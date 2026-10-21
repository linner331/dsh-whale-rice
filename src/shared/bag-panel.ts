/**
 * The treasure UI around her: the right-click menu, the bag / collection panel and the item card.
 * All three live in the whale layer next to her and report their bounds (`rects()`), so the
 * desktop overlay keeps them clickable while everything else stays click-through.
 */
import { ITEMS, MAX_BAIT, RARITY_ORDER, itemById, type BagView, type Item } from './items.ts'
import { TREASURE } from './treasure-art.ts'

const MENU_IDLE_MS = 5000
const CARD_MS = 6000

/** An item's icon, cut from the icon sheet; `known: false` shows only its silhouette (collection). */
export function itemIcon(item: Item, size: number, known = true): HTMLElement {
  const el = document.createElement('div')
  el.className = `wr-icon wr-r-${item.rarity}${known ? '' : ' wr-unknown'}`
  const n = TREASURE.items[item.id as keyof typeof TREASURE.items] ?? 0
  el.style.setProperty('--size', `${size}px`)
  el.style.setProperty('--sheet', `${TREASURE.cols * size}px`)
  el.style.setProperty('--at', `${-(n % TREASURE.cols) * size}px ${-Math.floor(n / TREASURE.cols) * size}px`)
  el.style.setProperty('--rarity', ITEMS.rarities[item.rarity].color)
  return el
}

export interface MenuState { bait: number; canDive: boolean; why?: string }

export class TreasureUi {
  private menu: HTMLElement | null = null
  private panel: HTMLElement | null = null
  private card: HTMLElement | null = null
  private menuTimer: ReturnType<typeof setTimeout> | undefined
  private cardTimer: ReturnType<typeof setTimeout> | undefined
  private tab: 'bag' | 'dex' = 'bag'
  onCardClosed: (() => void) | undefined

  constructor(private readonly layer: HTMLElement) {
    // In the DSH window a click anywhere else closes the menu and panel (the desktop overlay
    // never sees those clicks; there they close by timeout or their own buttons).
    document.addEventListener('pointerdown', this.onOutside, true)
  }

  dispose(): void {
    document.removeEventListener('pointerdown', this.onOutside, true)
    this.closeMenu(); this.closeBag(); this.closeCard()
  }

  rects(): DOMRect[] {
    return [this.menu, this.panel, this.card].filter((e): e is HTMLElement => e !== null).map(e => e.getBoundingClientRect())
  }

  get busy(): boolean { return this.menu !== null || this.panel !== null }

  openMenu(near: DOMRect, s: MenuState, onDive: () => void, onBag: () => void): void {
    this.closeMenu()
    const m = document.createElement('div')
    m.className = 'wr-menu'
    const dive = button(`下海捞宝  ·  鱼饵 ${s.bait}/${MAX_BAIT}`, () => { this.closeMenu(); onDive() })
    dive.disabled = !s.canDive
    if (s.why) dive.title = s.why
    m.append(dive, button('背包', () => { this.closeMenu(); onBag() }))
    if (s.why) m.append(Object.assign(document.createElement('div'), { className: 'wr-menu-why', textContent: s.why }))
    this.menu = m
    this.place(m, near, 'above')
    const restart = (): void => { clearTimeout(this.menuTimer); this.menuTimer = setTimeout(() => this.closeMenu(), MENU_IDLE_MS) }
    m.addEventListener('pointermove', restart)
    restart()
  }

  closeMenu(): void {
    clearTimeout(this.menuTimer)
    this.menu?.remove()
    this.menu = null
  }

  openBag(near: DOMRect, bag: BagView, onPick: (id: string) => void): void {
    this.closeBag()
    const p = document.createElement('div')
    p.className = 'wr-bag'
    this.panel = p
    const render = (): void => {
      const owned = ITEMS.items.filter(i => bag.items[i.id]).sort(byRarity)
      const all = [...ITEMS.items].sort(byRarity)
      p.innerHTML = ''
      const head = document.createElement('div')
      head.className = 'wr-bag-head'
      for (const [tab, label] of [['bag', `背包 ${owned.length}`], ['dex', `图鉴 ${owned.length}/${all.length}`]] as const) {
        const b = button(label, () => { this.tab = tab; render() })
        b.classList.toggle('wr-on', this.tab === tab)
        head.append(b)
      }
      head.append(Object.assign(button('×', () => this.closeBag()), { className: 'wr-bag-close', title: '收起' }))
      const grid = document.createElement('div')
      grid.className = 'wr-bag-grid'
      const list = this.tab === 'bag' ? owned : all
      for (const item of list) {
        const have = bag.items[item.id]
        const slot = document.createElement('button')
        slot.type = 'button'
        slot.className = 'wr-slot'
        slot.style.setProperty('--rarity', ITEMS.rarities[item.rarity].color)
        slot.title = have ? item.name : '还没捞到'
        slot.append(itemIcon(item, 40, Boolean(have)))
        if (have && have.count > 1) slot.append(Object.assign(document.createElement('span'), { className: 'wr-count', textContent: `×${have.count}` }))
        if (have) slot.addEventListener('click', () => { this.closeBag(); onPick(item.id) })
        else slot.disabled = true
        grid.append(slot)
      }
      if (!list.length) grid.append(Object.assign(document.createElement('div'), { className: 'wr-bag-empty', textContent: '背包空空的，右键她去海里捞点什么吧' }))
      const foot = document.createElement('div')
      foot.className = 'wr-bag-foot'
      foot.textContent = `鱼饵 ${bag.bait}/${MAX_BAIT} · 史诗保底还差 ${ITEMS.pity.epic - bag.pity.epic} · 传说保底还差 ${ITEMS.pity.legendary - bag.pity.legendary}`
      p.append(head, grid, foot)
    }
    render()
    this.place(p, near, 'above')
  }

  closeBag(): void {
    this.panel?.remove()
    this.panel = null
  }

  /** The item card beside her; closes on click or after a while. */
  showCard(near: DOMRect, id: string, bag: BagView, isNew = false): void {
    this.closeCard()
    const item = itemById(id)
    if (!item) return
    const have = bag.items[id]
    const c = document.createElement('div')
    c.className = `wr-card wr-r-${item.rarity}`
    c.style.setProperty('--rarity', ITEMS.rarities[item.rarity].color)
    const body = document.createElement('div')
    body.className = 'wr-card-body'
    const title = document.createElement('div')
    title.className = 'wr-card-title'
    title.textContent = item.name
    if (isNew) title.append(Object.assign(document.createElement('span'), { className: 'wr-new', textContent: 'NEW' }))
    const tag = Object.assign(document.createElement('div'), { className: 'wr-card-rarity', textContent: ITEMS.rarities[item.rarity].name })
    const desc = Object.assign(document.createElement('div'), { className: 'wr-card-desc', textContent: item.desc })
    body.append(title, tag, desc)
    if (have) {
      const meta = document.createElement('div')
      meta.className = 'wr-card-meta'
      meta.textContent = `拥有 ×${have.count} · 第一次捞到 ${new Date(have.firstAt).toLocaleDateString('zh-CN')}`
      body.append(meta)
    }
    c.append(itemIcon(item, 64), body)
    c.addEventListener('click', () => this.closeCard())
    this.card = c
    this.place(c, near, 'side')
    this.cardTimer = setTimeout(() => this.closeCard(), CARD_MS)
  }

  closeCard(): void {
    clearTimeout(this.cardTimer)
    if (!this.card) return
    this.card.remove()
    this.card = null
    this.onCardClosed?.()
  }

  get cardOpen(): boolean { return this.card !== null }

  /** Put `el` above her or beside her, kept inside the layer. */
  private place(el: HTMLElement, near: DOMRect, where: 'above' | 'side'): void {
    el.style.visibility = 'hidden'
    this.layer.append(el)
    const room = this.layer.getBoundingClientRect()
    const w = el.offsetWidth, h = el.offsetHeight
    let x: number, y: number
    if (where === 'above') {
      x = near.x + near.width / 2 - w / 2
      y = near.y - h + near.height * 0.12
    } else {
      x = near.right - near.width * 0.1
      if (x + w > room.width - 8) x = near.x + near.width * 0.1 - w
      y = near.y + near.height * 0.15
    }
    el.style.left = `${Math.round(Math.min(Math.max(8, x), room.width - w - 8))}px`
    el.style.top = `${Math.round(Math.min(Math.max(8, y), room.height - h - 8))}px`
    el.style.visibility = ''
  }

  private readonly onOutside = (e: PointerEvent): void => {
    const t = e.target as Node
    if (this.menu && !this.menu.contains(t)) this.closeMenu()
    if (this.panel && !this.panel.contains(t)) this.closeBag()
  }
}

const byRarity = (a: Item, b: Item): number => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity)

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = text
  b.addEventListener('click', e => { e.stopPropagation(); onClick() })
  return b
}
