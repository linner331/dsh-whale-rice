/**
 * The whale maid, a small desktop pet.
 *
 * What she does is decided in one place (`decide()`), in priority order:
 *   1. held / flying / region editing  – picked up by the scruff, thrown, or the user picks her area
 *   2. agent activity                  – eat while generating, take notes while tools run, wave for approvals
 *   3. queued reactions                – choke on errors, stuffed on max-tokens, cheer on long turns, pokes
 *   4. moods                           – what events leave behind, read off the emotion model (emotion.ts):
 *                                        sulk, wary, gloom, smug, expect, sleepy
 *   5. idle life                       – walk or somersault around her area, little idle gestures, nap after a while
 * Every behaviour runs as a cancellable task: starting a new one bumps `task`, and older loops stop
 * at their next await.
 */
import type { Activity } from './feed.ts'
import type { RegionSource } from './region.ts'
import { anim, animDuration, animFor, CELL, PIN, POSE, ROLL_FACING, RUN_FACING, SPIN, Sprite, WALK_FACING, type AnimName, type Steps } from './sprite.ts'
import { Emotion, EVENTS, type EmotionEvent, type Mood } from './emotion.ts'
import { Flight, Pendulum, PointerVelocity } from './toss.ts'

const SCALE = 0.42
const W = CELL.w * SCALE, H = CELL.h * SCALE
const GAITS = {
  walk: { anim: 'walk', speed: 55, facing: WALK_FACING, bob: 0 },
  run:  { anim: 'run', speed: 150, facing: RUN_FACING, bob: 0 },   // bob: extra px of bounce per stride (the frames carry their own)
} as const
type Gait = keyof typeof GAITS
const RUN_WHEN_HAPPY = 0.6               // chance to run instead of walk when she is in a good mood
const RUN_ANYWAY = 0.12                  // …and when she isn't
const ROLL_TURNS = 1                     // full turns of the ball per somersault
const QUARTER_MS = 170                   // time per quarter turn (one drawn angle)
const ROLL_DISTANCE = ROLL_TURNS * 2 * Math.PI * SPIN.radius * SCALE   // wheel: distance = angle × radius
const ROLL_CHANCE = 0.35                 // share of strolls done as a somersault, when there's room
const SLEEP_AFTER_MS = 5 * 60_000        // no activity or interaction for this long → nap
const ASK_IMPATIENT_MS = 8_000           // after this, waving turns into pleading / knocking
const IDLE_GESTURES: AnimName[] = ['idle_look', 'idle_tap', 'idle_peek', 'idle_swish']
const GRAB_EASE_MS = 180                 // she is pulled up into the pinch over this long
const STRUGGLE_AFTER_MS = 2500           // dangling longer than this → she starts to struggle
const STRUGGLE_MS = 4500                 // one bout of struggling, then she goes limp for a while
const STICK_LANDING_DEG = 40             // body within this of upright at impact → gymnast landing
const STICK_LANDING_SPEED = 1500         // px/s; hitting the floor faster than this → face-plant

const LINES = {
  poke: ['饭饭！', '再来一碗~', '摸鱼中…', '今天也要好好吃饭', '嗷呜！', '哼，才不是在等你'],
  busy: ['在吃饭呢，等一下下~', '嚼嚼嚼…'],
  ask: '要你确认一下哦~',
  askPoke: '去 DeepSeek 里点确认呀',
  oops: '咳咳…噎住了',
  full: '吃、吃撑了…',
  cheer: '做完啦！快回来看看~',
  struggle: ['放我下来！', '呜哇哇——', '哼！快松手！', '不要拎我啦！'],
  regrab: ['又来！！', '说了不要拎我！'],
  sulk: ['哼！', '不理你了', '……哼'],
  wary: ['别过来！', '你、你想干嘛', '不许再拎我'],
  smug: ['再来一次也行哦~', '厉害吧！'],
  gloom: ['呜…', '饭都没吃好…'],
  praised: ['嘿嘿~', '被夸了！'],
  tired: '……累了，随便你吧',
  stuck: ['完美落地！', '十点零分！', '哼哼~'],
  splat: ['呜…好痛', '鼻子…', '下次轻点啦！'],
} as const

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]

type Mode = 'idle' | 'walking' | 'busy' | 'activity' | 'asleep' | 'mood' | 'held' | 'flying' | 'editing'
/** `feel`: the emotion event it causes; `upbeat`: a happy animation, skipped if she ends up upset. */
type Reaction = { anim: AnimName; line?: string; feel?: EmotionEvent; upbeat?: boolean }

export class Whale {
  readonly root = document.createElement('div')
  private readonly sprite: Sprite
  private pos = { x: 0, y: 0 }          // top-left of the sprite box, CSS px
  private mode: Mode = 'idle'
  private activity: Activity = 'idle'
  private readonly reactions: Reaction[] = []
  private task = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private raf = 0
  private lastAttention = Date.now()
  readonly emotion = new Emotion()
  private turnDeg = 0                   // extra rotation (somersault ball, dangling swing, tumbling flight)
  private held: { token: number; px: number; py: number; since: number; velocity: PointerVelocity; swing: Pendulum } | null = null
  private returnTo: { x: number; y: number } | null = null   // thrown out while upset: walk back once calm
  private disposed = false
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(private readonly layer: HTMLElement, imageUrl: string, private readonly regions: RegionSource) {
    this.root.className = 'wr-whale wr-idle'
    const inner = document.createElement('div')
    inner.className = 'wr-sprite'
    this.root.append(inner)
    this.sprite = new Sprite(inner, imageUrl, SCALE)
    this.sprite.show(POSE.rest)
    layer.append(this.root)

    const r = this.regions.rect()
    this.place(r.right - W - 8, r.bottom - H)
    this.bindPointer()
    window.addEventListener('resize', this.onResize)
    this.decide()
  }

  dispose(): void {
    this.disposed = true
    this.task++
    clearTimeout(this.idleTimer)
    cancelAnimationFrame(this.raf)
    this.sprite.stop()
    window.removeEventListener('resize', this.onResize)
    this.root.remove()
  }

  /** She is held or her area is being edited (the desktop overlay must keep receiving the mouse). */
  get interacting(): boolean { return this.mode === 'held' || this.mode === 'editing' }

  /** Screen-space bounds of everything clickable (the desktop overlay lets clicks through elsewhere). */
  hitRect(): DOMRect { return this.root.getBoundingClientRect() }

  /** The region moved or resized: walk back inside it. */
  regionChanged(): void {
    const r = this.regions.rect()
    if (this.mode === 'idle' || this.mode === 'walking') this.walkTo(r.left + Math.max(0, r.width - W) / 2, r.bottom - H)
    else this.place(this.pos.x, this.pos.y)
  }

  // ---- inputs ----------------------------------------------------------------------------------

  setActivity(next: Activity): void {
    if (next === this.activity) return
    this.activity = next
    if (next !== 'idle') this.lastAttention = Date.now()
    this.decide()
  }

  react(kind: 'oops' | 'full' | 'cheer'): void {
    const feel: Record<typeof kind, EmotionEvent> = { oops: 'error', full: 'stuffed', cheer: 'taskDone' }
    this.queue({ anim: kind, line: LINES[kind], feel: feel[kind], upbeat: kind === 'cheer' })
  }

  /** Director mode (demos/debugging): act something out now instead of waiting for chance or time. */
  direct(act: string, arg: string | null): void {
    const r = this.regions.rect()
    const side = arg === 'left' || arg === 'right' ? arg : this.pos.x - r.left > r.right - W - this.pos.x ? 'left' : 'right'
    // A cue cuts short a mood, an idle gesture or a nap — never a drag, a throw or real work.
    const free = (): boolean => {
      if (this.activity !== 'idle' || !['idle', 'walking', 'mood', 'busy', 'asleep'].includes(this.mode)) return false
      if (this.mode !== 'idle' && this.mode !== 'walking') { this.begin('idle'); this.sprite.show(POSE.rest) }
      return true
    }
    switch (act) {
      case 'run': case 'walk':
        if (free()) this.walkTo(side === 'left' ? r.left : r.right - W, this.pos.y, act)
        return
      case 'roll': if (free()) this.roll(side); return
      case 'sleep': if (free()) void this.fallAsleep(); return
      case 'oops': case 'full': case 'cheer': return this.react(act)
      case 'feel': if (arg && arg in EVENTS) { this.emotion.feel(arg as EmotionEvent); this.decide() } return
      case 'calm': this.emotion.reset(); if (this.mode === 'mood') this.toIdle(); return
      case 'region': {
        // arg "x,y,w,h" as fractions of the window (in-app area only; the desktop area is picked on screen)
        const [x, y, w, h] = (arg ?? '').split(',').map(Number)
        if ([x, y, w, h].every(v => v >= 0 && v <= 1) && this.regions.set) { this.regions.set({ x, y, w, h }); this.regionChanged() }
        return
      }
      case 'grab': {
        if (!free()) return
        // arg "seconds,vx,vy": hold that long, then let go with that velocity (px/s; 0,0 = drop)
        const [secs = 2.5, vx = 0, vy = 0] = (arg ?? '').split(',').map(Number).map(n => (Number.isFinite(n) ? n : undefined))
        return void this.directedGrab(secs, vx, vy)
      }
    }
  }

  /** Director mode: the real pick-up / dangle / throw, driven by a scripted pointer instead of a mouse. */
  private async directedGrab(seconds: number, vx: number, vy: number): Promise<void> {
    const pin = this.setPivot(PIN.x, PIN.y)
    const x0 = this.pos.x + pin.x, y0 = this.pos.y + pin.y
    this.grab(x0, y0)
    const token = this.task
    const t0 = performance.now()
    await new Promise<void>(done => {
      const step = (now: number): void => {
        const h = this.held
        if (!h || !this.alive(token)) return done()
        const t = (now - t0) / 1000
        const lift = 1 - (1 - Math.min(1, t / 0.5)) ** 2        // raised ~70px, then a gentle sway
        h.px = x0 + Math.sin(t * 2.4) * 16 * lift
        h.py = y0 - 70 * lift
        h.velocity.add(h.px, h.py)
        if (t < seconds) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    })
    if (!this.held || !this.alive(token)) return
    this.held = null
    this.root.classList.remove('wr-held')
    void this.toss(vx, vy, this.turnDeg)
  }

  say(text: string): void {
    const b = document.createElement('div')
    b.className = 'wr-bubble'
    b.textContent = text
    this.root.append(b)
    b.addEventListener('animationend', () => b.remove())
  }

  // ---- the director ----------------------------------------------------------------------------

  private decide(): void {
    if (this.disposed || this.mode === 'held' || this.mode === 'flying' || this.mode === 'editing') return
    if (this.activity !== 'idle') {
      if (this.mode !== 'activity') void this.runActivity()
      return
    }
    if (this.mode === 'activity' || this.mode === 'busy' || this.mode === 'mood') return   // they hand back via toIdle()
    const reaction = this.reactions.shift()
    if (reaction) return void this.runReaction(reaction)
    if (this.mode === 'idle' && this.emotion.mood) return void this.runMood()
    if (this.mode === 'idle' && this.returnTo) {
      const { x, y } = this.returnTo
      this.returnTo = null
      return this.walkTo(x, y)
    }
    if (this.mode === 'idle') this.scheduleIdleLife()
  }

  private queue(r: Reaction): void {
    this.lastAttention = Date.now()
    this.reactions.push(r)
    this.decide()
  }

  /** Start a new behaviour: cancel the old one and report whether she has to wake up first. */
  private begin(mode: Mode): { token: number; wasAsleep: boolean } {
    const wasAsleep = this.mode === 'asleep'
    this.task++
    this.sprite.stop()
    cancelAnimationFrame(this.raf)
    clearTimeout(this.idleTimer)
    this.turnDeg = 0                      // an interrupted somersault / swing / flight leaves no tilt
    this.root.style.transformOrigin = ''
    this.mode = mode
    this.root.classList.toggle('wr-idle', mode === 'idle')
    this.render(0)
    return { token: this.task, wasAsleep }
  }

  private alive(token: number): boolean { return token === this.task && !this.disposed }

  private async play(token: number, steps: Steps): Promise<boolean> {
    await this.sprite.play(steps)
    return this.alive(token)
  }

  private toIdle(): void {
    if (this.disposed) return
    this.begin('idle')
    this.sprite.show(POSE.rest)
    this.decide()
  }

  // ---- behaviours ------------------------------------------------------------------------------

  private async runActivity(): Promise<void> {
    const { token, wasAsleep } = this.begin('activity')
    if (wasAsleep && !(await this.play(token, anim('wake')))) return
    let current: Activity = 'idle'
    let askSince = 0
    while (this.alive(token) && this.activity !== 'idle') {
      const a = this.activity
      if (a !== current) {
        current = a
        if (a === 'generating' && !(await this.play(token, anim('eat_start')))) return
        if (a === 'tool' && !(await this.play(token, anim('tool_start')))) return
        if (a === 'ask') { askSince = Date.now(); this.say(LINES.ask) }
        continue
      }
      // Each loop is one full cycle, so a change always lands on a finished bite / note.
      const loop: AnimName = a === 'generating' ? 'eat_loop'
        : a === 'tool' ? 'tool_loop'
        : Date.now() - askSince > ASK_IMPATIENT_MS ? 'ask_more' : 'ask'
      if (!(await this.play(token, anim(loop)))) return
      if (loop === 'eat_loop') this.emotion.feel('eat', 1.3)     // one bite ≈ 1.3 s of eating
    }
    if (!this.alive(token)) return
    // Linger on how the work ended before going back to the rest pose.
    if (current === 'generating' && !(await this.play(token, anim('eat_done')))) return
    if (current === 'tool' && !(await this.play(token, anim('tool_end')))) return
    this.toIdle()
  }

  private async runReaction(r: Reaction): Promise<void> {
    const { token, wasAsleep } = this.begin('busy')
    if (wasAsleep && !(await this.play(token, anim('wake')))) return
    if (r.feel) this.emotion.feel(r.feel)
    // A happy ending is only played if she actually ends up happy (no cheering while sulking).
    if (!r.upbeat || this.emotion.valence >= 0) {
      if (r.line) this.say(r.line)
      if (!(await this.play(token, anim(r.anim)))) return
    }
    this.toIdle()
  }

  // ---- moods: read off the emotion model, lived out until they fade -------------------------

  private static readonly UPSET: Mood[] = ['sulk', 'wary', 'gloom']

  private static readonly MOOD_LOOP: Record<Exclude<Mood, 'sleepy'>, () => AnimName> = {
    sulk: () => (Math.random() < 0.25 ? 'sulk_peek' : 'sulk'),
    wary: () => 'wary',
    gloom: () => 'gloom',
    smug: () => 'smug',
    expect: () => 'expect',
  }

  /** Live whatever mood the emotion model reports until it fades; `intro` plays first. */
  private async runMood(intro?: Steps): Promise<void> {
    const { token } = this.begin('mood')
    if (intro && !(await this.play(token, intro))) return
    let prev: Mood | null = intro ? this.emotion.mood : null
    for (let mood = this.emotion.mood; mood; mood = this.emotion.mood) {
      if (mood === 'sleepy') {
        if (!(await this.play(token, anim('sleepy')))) return
        return void this.fallAsleep()
      }
      if (mood === 'wary' && prev !== 'wary' && !(await this.play(token, anim('wary_in')))) return
      prev = mood
      if (!(await this.play(token, anim(Whale.MOOD_LOOP[mood]())))) return
    }
    if (prev === 'sulk' && !(await this.play(token, anim('hmph')))) return
    this.toIdle()
  }

  /** A click while she is in a mood: the emotion model decides what it means. */
  private pokeMood(): void {
    const before = this.emotion.mood
    this.emotion.poke()
    switch (before) {
      case 'sulk': this.say(pick(LINES.sulk)); return void this.runMood(anim('hmph'))
      case 'wary': this.say(pick(LINES.wary)); return void this.runMood(anim('wary'))
      case 'gloom': this.say(pick(LINES.gloom)); return void this.runMood()
      case 'smug': case 'expect': return void this.runReaction({ anim: 'praised', line: pick(LINES.praised) })
      default: return void this.runMood()
    }
  }

  private async fallAsleep(): Promise<void> {
    const { token } = this.begin('asleep')
    if (!(await this.play(token, anim('sleep_in')))) return
    while (await this.play(token, anim('sleep', 4))) { /* breathe */ }
  }

  // ---- idle life -------------------------------------------------------------------------------

  private scheduleIdleLife(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.mode !== 'idle') return
      if (document.hidden) return this.scheduleIdleLife()
      if (Date.now() - this.lastAttention > SLEEP_AFTER_MS) return void this.fallAsleep()
      if (!this.reducedMotion && Math.random() < 0.55) {
        if (Math.random() < ROLL_CHANCE && this.roll()) return
        const r = this.regions.rect()
        const happy = this.emotion.valence >= 0.15
        const gait: Gait = Math.random() < (happy ? RUN_WHEN_HAPPY : RUN_ANYWAY) ? 'run' : 'walk'
        return this.walkTo(r.left + Math.random() * Math.max(0, r.width - W), r.top + Math.random() * Math.max(0, r.height - H), gait)
      }
      void this.runReaction({ anim: IDLE_GESTURES[Math.floor(Math.random() * IDLE_GESTURES.length)] })
    }, 6000 + Math.random() * 8000)
  }

  private walkTo(tx: number, ty: number, gait: Gait = 'walk'): void {
    const { token } = this.begin('walking')
    const g = GAITS[gait]
    const from = { ...this.pos }
    const dist = Math.hypot(tx - from.x, ty - from.y)
    if (dist < 4) return this.toIdle()
    // Mirror the frames when she heads the other way from how they were drawn.
    const goingLeft = tx < from.x
    this.root.classList.toggle('wr-flip', g.facing === 'left' ? !goingLeft : goingLeft)
    // The mood picks the version of the gait (a sulky walk when cross), if one is drawn.
    const steps = animFor(g.anim, this.emotion.mood)
    void (async () => { while (await this.play(token, anim(steps))) { /* keep stepping */ } })()
    const duration = (dist / g.speed) * 1000
    const stride = animDuration(steps) / 2            // two leaps per cycle
    const t0 = performance.now()
    const frame = (now: number): void => {
      if (!this.alive(token)) return
      const t = Math.min(1, (now - t0) / duration)
      this.pos.x = from.x + (tx - from.x) * t
      this.pos.y = from.y + (ty - from.y) * t
      // A bouncy gait rises once per stride, in step with the drawn leaps.
      this.render(g.bob * Math.abs(Math.sin((Math.PI * (now - t0)) / stride)))
      if (t < 1) this.raf = requestAnimationFrame(frame)
      else this.toIdle()
    }
    this.raf = requestAnimationFrame(frame)
  }


  /** Somersault sideways (given or random direction) if the region has room; false if she can't. */
  roll(direction?: 'left' | 'right'): boolean {
    if (this.mode !== 'idle' && this.mode !== 'walking') return false
    const r = this.regions.rect()
    const room = { left: this.pos.x - r.left, right: r.right - W - this.pos.x }
    const dirs = (direction ? [direction] : ['left', 'right'] as const).filter(d => room[d] >= ROLL_DISTANCE)
    if (!dirs.length) return false
    void this.somersault(dirs[Math.floor(Math.random() * dirs.length)])
    return true
  }

  private async somersault(dir: 'left' | 'right'): Promise<void> {
    const { token } = this.begin('walking')
    const left = dir === 'left'
    this.root.classList.toggle('wr-flip', ROLL_FACING === 'left' ? !left : left)
    if (!(await this.play(token, anim('sault_in')))) return
    if (!(await this.spin(token, left ? -1 : 1))) return
    if (await this.play(token, anim('sault_out'))) this.toIdle()
  }

  /**
   * Roll the curled-up ball like a wheel. The four drawn angles are swapped every quarter turn and
   * the ball is rotated smoothly in between; the position always equals angle × radius, so the
   * point touching the floor never slides. `sign` −1 rolls left (counter-clockwise), +1 right.
   */
  private spin(token: number, sign: -1 | 1): Promise<boolean> {
    this.setPivot(SPIN.cx, SPIN.cy)
    const radius = SPIN.radius * SCALE
    const quarters = ROLL_TURNS * 4
    const fromX = this.pos.x
    const t0 = performance.now()
    let shown = -1
    return new Promise(resolve => {
      const done = (ok: boolean): void => {
        this.turnDeg = 0
        this.root.style.transformOrigin = ''
        if (ok) this.render(0)
        resolve(ok)
      }
      const tick = (now: number): void => {
        if (!this.alive(token)) return done(false)
        const q = Math.min((now - t0) / QUARTER_MS, quarters)     // quarter turns completed
        const k = Math.min(Math.floor(q), quarters - 1)
        if (k % 4 !== shown) { shown = k % 4; this.sprite.show(SPIN.frames[shown]) }
        this.turnDeg = sign * (q - k) * 90
        this.pos.x = fromX + sign * radius * q * (Math.PI / 2)
        this.render(0)
        if (q < quarters) this.raf = requestAnimationFrame(tick)
        else done(true)
      }
      this.raf = requestAnimationFrame(tick)
    })
  }

  // ---- placement -------------------------------------------------------------------------------

  private place(x: number, y: number): void {
    const r = this.regions.rect()
    // Keep the feet inside the region; the sprite box may poke above it.
    this.pos.x = Math.min(Math.max(x, r.left), r.right - W)
    this.pos.y = Math.min(Math.max(y, r.top), r.bottom - H)
    this.render(0)
  }

  /** Rotation pivot for `turnDeg`, in cell px of the frame as drawn (mirrored when flipped). */
  private setPivot(cellX: number, cellY: number): { x: number; y: number } {
    const flipped = this.root.classList.contains('wr-flip')
    const x = (flipped ? CELL.w - cellX : cellX) * SCALE, y = cellY * SCALE
    this.root.style.transformOrigin = `${x}px ${y}px`
    return { x, y }
  }

  private render(lift: number): void {
    const turn = this.turnDeg ? ` rotate(${this.turnDeg}deg)` : ''
    this.root.style.transform = `translate(${this.pos.x}px, ${this.pos.y - lift}px)${turn}`
  }

  private readonly onResize = (): void => this.place(this.pos.x, this.pos.y)

  // ---- pointer: click = poke, drag = pick up by the scruff, release = throw, dblclick = area ------

  private onClick(): void {
    this.lastAttention = Date.now()
    if (this.mode === 'asleep') return void this.runReaction({ anim: 'wake', line: '唔…早上好？' })
    if (this.mode === 'activity') return this.say(this.activity === 'ask' ? LINES.askPoke : pick(LINES.busy))
    if (this.mode === 'mood') return this.pokeMood()
    if (this.mode === 'idle' || this.mode === 'walking') this.runReaction({ anim: 'poke', line: pick(LINES.poke) })
  }

  private bindPointer(): void {
    let start: { x: number; y: number } | null = null
    this.root.addEventListener('pointerdown', e => {
      if (this.mode === 'editing') return
      start = { x: e.clientX, y: e.clientY }
      this.root.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    this.root.addEventListener('pointermove', e => {
      if (!start) return
      if (!this.held) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return
        this.grab(e.clientX, e.clientY)
      }
      this.held!.px = e.clientX
      this.held!.py = e.clientY
      this.held!.velocity.add(e.clientX, e.clientY)
    })
    const up = (): void => {
      if (!start) return
      start = null
      if (this.held) this.release()
      else this.onClick()
    }
    this.root.addEventListener('pointerup', up)
    this.root.addEventListener('pointercancel', up)
    this.root.addEventListener('dblclick', () => void this.editArea())
  }

  // ---- picked up: dangle from the pointer, swing, struggle when held too long -----------------

  private grab(px: number, py: number): void {
    const { token } = this.begin('held')
    this.lastAttention = Date.now()
    this.root.classList.add('wr-held')
    // Picked up again while sulking / wary: no patience left, she struggles right away.
    const before = this.emotion.mood
    const angry = before === 'sulk' || before === 'wary'
    this.returnTo = null
    this.emotion.feel('grab')
    if (angry) this.say(pick(LINES.regrab))
    const velocity = new PointerVelocity()
    velocity.add(px, py)
    const since = performance.now() - (angry ? STRUGGLE_AFTER_MS : 0)
    this.held = { token, px, py, since, velocity, swing: new Pendulum() }
    const pin = this.setPivot(PIN.x, PIN.y)
    // Where she was grabbed relative to the scruff; eased away so she is pulled up into the
    // pinch instead of jumping there.
    const offset = { x: this.pos.x + pin.x - px, y: this.pos.y + pin.y - py }
    const t0 = performance.now()
    let last = t0
    // The pinch point ends up exactly under the pointer; the body swings around it.
    const tick = (now: number): void => {
      const h = this.held
      if (!h || !this.alive(token)) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const ease = Math.max(0, 1 - (now - t0) / GRAB_EASE_MS) ** 2
      this.turnDeg = h.swing.step(dt, h.velocity.get(now).vx)
      this.pos.x = h.px - pin.x + offset.x * ease
      this.pos.y = h.py - pin.y + offset.y * ease
      this.render(0)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
    void this.dangle(token)
  }

  private async dangle(token: number): Promise<void> {
    if (!(await this.play(token, anim('lift')))) return
    while (this.alive(token) && this.held) {
      if (performance.now() - this.held.since < STRUGGLE_AFTER_MS) {
        if (!(await this.play(token, anim('hang')))) return
        continue
      }
      this.say(pick(LINES.struggle))
      this.emotion.feel('struggle')
      const until = performance.now() + STRUGGLE_MS
      while (performance.now() < until) {
        if (!(await this.play(token, anim(pick(['kick', 'flail', 'wiggle'] as const), 2)))) return
      }
      this.say(LINES.tired)
      if (!(await this.play(token, anim('tired', 2)))) return
    }
  }

  // ---- thrown: ballistic flight, then a gymnast landing or a face-plant, then walk back -------

  private release(): void {
    const h = this.held
    if (!h) return
    this.held = null
    this.root.classList.remove('wr-held')
    const { vx, vy } = h.velocity.get()
    void this.toss(vx, vy, this.turnDeg)
  }

  private async toss(vx: number, vy: number, angle: number): Promise<void> {
    const { token } = this.begin('flying')
    // Flight frames face left as drawn; mirror them when she flies to the right.
    if (Math.abs(vx) > 40) this.root.classList.toggle('wr-flip', vx > 0)
    this.setPivot(CELL.w / 2, CELL.h * 0.6)
    const r = this.regions.rect()
    const room = this.layer.getBoundingClientRect()
    const ground = Math.max(r.bottom - H, Math.min(this.pos.y, room.height - H))
    const bounds = { left: 0, top: 0, right: room.width - W, ground }
    const flight = new Flight(this.pos.x, this.pos.y, vx, vy, angle)
    let highest = this.pos.y
    let impact = 0
    let shown = -1
    const landed = await new Promise<boolean>(resolve => {
      let last = performance.now()
      const tick = (now: number): void => {
        if (!this.alive(token)) return resolve(false)
        const dt = Math.min(0.033, (now - last) / 1000)
        last = now
        const vyBefore = flight.vy
        const down = flight.step(dt, bounds)
        highest = Math.min(highest, flight.y)
        const frame = flight.vy < -150 ? POSE.air_rise : Math.abs(flight.spin) > 220 ? POSE.air_tumble : POSE.air_fall
        if (frame !== shown) { this.sprite.show(frame); shown = frame }
        this.pos.x = flight.x
        this.pos.y = flight.y
        this.turnDeg = flight.angle
        this.render(0)
        if (down) { impact = vyBefore; return resolve(true) }
        this.raf = requestAnimationFrame(tick)
      }
      this.raf = requestAnimationFrame(tick)
    })
    if (!landed) return
    const tilt = Math.abs(flight.uprightError)
    this.turnDeg = 0
    this.root.style.transformOrigin = ''
    this.render(0)

    // Physics decides how she lands; the emotion model decides how she takes it. A clean landing
    // only gets the proud ending if she is actually in a good mood afterwards.
    if (ground - highest < 40 && tilt < 60) {
      if (!(await this.play(token, [[POSE.touch_down, 160]]))) return     // just set down
    } else if (tilt <= STICK_LANDING_DEG && impact < STICK_LANDING_SPEED) {
      this.emotion.feel('stuck')
      if (this.emotion.valence >= 0) {
        this.say(pick(LINES.stuck))
        if (!(await this.play(token, anim('land_a')))) return
      } else if (!(await this.play(token, [[POSE.touch_down, 400]]))) return
    } else {
      this.emotion.feel('faceplant')
      this.say(pick(LINES.splat))
      if (!(await this.play(token, anim('land_b')))) return
    }
    // Thrown out of her area: walk back in. The mood plays out from idle.
    const tx = Math.min(Math.max(this.pos.x, r.left), r.right - W)
    const ty = Math.min(Math.max(this.pos.y, r.top), r.bottom - H)
    // Upset with no walk drawn for that mood (the plain one smiles): sulk it out where she fell,
    // walk back once calm. With a mood version she stomps back right away, then sulks.
    const mood = this.emotion.mood
    const smilingWalk = animFor('walk', mood) === 'walk'
    if (Math.hypot(tx - this.pos.x, ty - this.pos.y) <= 4) this.toIdle()
    else if (mood && Whale.UPSET.includes(mood) && smilingWalk) { this.returnTo = { x: tx, y: ty }; this.toIdle() }
    else this.walkTo(tx, ty)
  }

  private async editArea(): Promise<void> {
    const { token } = this.begin('editing')
    this.sprite.show(POSE.rest)
    await this.regions.edit()
    if (!this.alive(token)) return
    this.place(this.pos.x, this.pos.y)
    this.toIdle()
  }
}
