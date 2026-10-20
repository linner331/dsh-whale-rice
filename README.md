# dsh-whale-rice · 鲸鱼娘吃白饭

A DeepSeek Harness (DSH) plugin: a chibi whale maid keeps eating white rice while the model is
generating, and puts her bowl down when it stops. On macOS she lives on your desktop, anywhere on
any screen; elsewhere she stays inside the DSH window.

## Features

- **Eats while tokens flow**: from `step/start` until the model's `assistant/message` she loops the eating animation; gaps under 1.5s between steps don't interrupt her. When generation stops she finishes the bite and puts the bowl down.
- **Balance on hover**: with an API key configured, the host reads `GET https://api.deepseek.com/user/balance` and the tooltip shows the current balance. Nothing is shown when it can't be read (e.g. DeepSeek-account sign-in), and per-reply costs / top-ups are deliberately not displayed: balance deltas can't be attributed to a single reply reliably.
- **Desktop mode (macOS)**: she leaves the DSH window. Double-click her → every screen dims → drag a rectangle on any screen to set her area (Esc / right-click cancels). Saved in `~/.dsh/whale-rice/overlay.json`.
- **Interactions**: click to poke, drag to carry her (she snaps back inside her area), and she hops around her area on her own.

## Installation

```bash
dsh plugin --profile web add github:linner331/dsh-whale-rice
```

The key is read from the DSH credentials service under the name `DEEPSEEK_API_KEY` (the same one DSH itself uses), with the environment variable as a fallback.
The key is only used on the host side and never sent to the browser.

Optional config (`cordis.patch.yml`):

```yaml
config:
  apiKeyRef: DEEPSEEK_API_KEY  # credential / env var name
  pollSeconds: 60              # polling interval, minimum 15
  desktop: true                # macOS: false keeps her inside the DSH window
```

Desktop mode runs a small native helper, `lib/whale-overlay` (Swift, source in `native/`, compiled with `swiftc` at build time): one transparent always-on-top window per screen, click-through everywhere except the whale. It only talks to a private `127.0.0.1` port opened by the plugin (random token per launch) and exits when DSH does.

## Development

```bash
pnpm install
pnpm dev          # build + start the local harness at http://127.0.0.1:8770 (DESKTOP=1 to also run the desktop overlay)
```

The harness (`dev/`) runs the real host-side code with a mock DeepSeek balance API, so you can simulate charges, top-ups, and unloading without installing DSH.

```
src/
  host/        Node half: agent activity (activity.ts), balance, SSE hub, desktop overlay host
  shared/      The whale itself: behaviour state machine, sprite playback, regions, styles
  client/      In-app entry (inside the DSH window)
  overlay/     Desktop overlay page (one per screen, inside the native helper)
native/macos/  Swift helper: transparent click-through windows
assets/        Shipped runtime assets: sprites/whale.webp + whale.json, artwork license
art/           Source artwork (not shipped): generated grids, reference, prompts, sprites.json manifest
scripts/       build.mjs (all artifacts → lib/), sprites/build_sprites.py (art → atlas)
dev/           Local harness with mock events and a mock balance API
```

Sprites: edit `art/sprites.json` (sources, frame ids, animations, durations) and run `pnpm sprites`
(needs Python 3 with Pillow and NumPy). It splits the grids, removes the white background, aligns
every frame on the feet / face axis and writes `assets/sprites/whale.{webp,json}`, a labelled contact
sheet (`art/previews/atlas.png`) and every behaviour laid out in playback order with measured head
sizes (`art/previews/flows.png`).

Sizing rule: inside a sheet, standing frames are normalised to the same body height; across sheets,
each sheet gets one factor so its median head height (top of the hair to the chin) matches the other
sheets, so switching between behaviours drawn in different sheets never changes her head size
(`faceMatch`: 1 = equal heads, 0 = equal heights). Per-frame `frameScale` is only for panels the
image model drew at a different size within one grid.

| Agent state (session events) | What she does |
|---|---|
| generating (`step/start` → `assistant/message`) | eats, bite after bite |
| tools running (`assistant/message` → `step/end`) | takes notes, bowl on the floor |
| approval pending (`approval/asked` → `approval/decided`) | waves at you; after 8s pleads and knocks on her bowl |
| turn ends with `error` / `max-tokens` | chokes / holds her full belly |
| a turn of 20s+ completes | jumps and gives a thumbs-up |
| idle | walks, happily runs with her rice bowl (mostly when she's in a good mood), or somersaults (rolls like a wheel: distance = angle × radius) around her area, little gestures, naps after 5 minutes |
| picked up (drag) | dangles from the scruff under a pinching cursor and swings like a pendulum; struggles after 2.5 s, then goes limp |
| afterwards (moods) | an emotion model (`src/shared/emotion.ts`): every event adds a fixed impulse to *valence* (unhappy…happy), *arousal* (drained…worked up) and *need* (wants attention), which decay on their own; the mood is the region she is in — sulk, wary, gloom, smug, expect (praise me), sleepy. Repeated events stack, nice events only soften a bad mood, and happy endings (gymnast pose, cheering) are skipped if she ends up upset. New behaviour = one row in the event table |
| thrown (release while moving) | flies under gravity, bounces off screen edges and tumbles; lands like a gymnast if she comes down upright, otherwise face-plants; walks back if she lands outside her area |

## License

- Code: MIT (`LICENSE`)
- Artwork: CC BY-NC-SA 4.0 (`assets/LICENSE-ARTWORK`), no commercial use; see `NOTICE` for sources

Unofficial fan work, not affiliated with DeepSeek.
