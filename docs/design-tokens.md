# Design tokens

The shared visual vocabulary for the WCC Emergency GIS Data Showcase lives in
`src/theme.css` as CSS custom properties, and `src/style.css` is built
entirely on top of it. Every sibling feature module (map, dataset detail,
filters, charts) should consume these tokens rather than hard-coding a hex
value, a pixel size, or a duration — that's what keeps four independently
shipped tickets reading as one product.

Scope: this file documents shared-chrome tokens only. Feature modules own
their own component CSS files and may add module-scoped tokens/classes
alongside them, but should not redefine anything below.

## Theming

The app is **dark-first**: `:root` in `theme.css` (no media query, no
attribute) *is* the dark palette — it's the default and fallback for any
browser or embedding context that doesn't understand `prefers-color-scheme`.
Light mode layers on top, in ascending precedence:

1. `:root` — dark (default)
2. `@media (prefers-color-scheme: light)` — light, when the OS asks for it
3. `html[data-theme="light"]` / `html[data-theme="dark"]` — explicit
   override, wins regardless of OS preference

No toggle ships yet. A future one is a single line —
`document.documentElement.dataset.theme = "light"` — with zero CSS changes,
because the `data-theme` selectors are already live.

## Colour

### Surfaces

Near-black (dark) / near-white (light) ladder, four steps of luminance.
Prefer hairline `--border` over `box-shadow` to separate surfaces on dark —
shadows are reserved for things that visually float above the page (the
hero panel, future dropdowns/popovers).

| Token         | Use                                              |
| ------------- | ------------------------------------------------ |
| `--surface-0` | Page background                                  |
| `--surface-1` | Header / footer / structural chrome              |
| `--surface-2` | Raised content: cards, panels                     |
| `--surface-3` | Hover/active state of a raised surface            |
| `--border`    | Hairline separators, default borders              |
| `--border-strong` | Emphasised border (hover, input focus lead-in) |

### Text

Off-white/near-black, stepped **down in luminance** — never opacity — for
secondary/tertiary text, so contrast stays predictable.

| Token             | Use                                            | Min. contrast on `--surface-0/1/2` |
| ------------------ | ---------------------------------------------- | ----------------------------------- |
| `--text-primary`   | Body copy, headings                            | ≥ 14.4:1 (both modes)               |
| `--text-secondary` | Secondary copy, descriptions                   | ≥ 7.7:1 (both modes)                |
| `--text-tertiary`  | Meta, timestamps, counts                       | ≥ 4.4:1 (both modes, incl. `--surface-3` hover) |

`--text-tertiary` is tuned to clear 4.5:1 body-text AA against every shared
surface it's actually used on — including `--surface-3` (the `.ds:hover`
background), the tightest case. If a future use puts it on a *lighter*
surface than `--surface-3` (dark) / a darker one than `--surface-0` (light),
re-check contrast before shipping — don't assume the margin carries over.

### The one owned accent

`--accent` / `--accent-hover` / `--accent-fg` is the single interactive
colour: links, the primary button, the focus ring, the active search border.
It is amber/orange in both modes — an emergency-signal colour that fits the
domain — but the *shade* changes per theme to hold ≥ 4.5:1 against body text
sizes:

- Dark: `--accent: #ffa63d` on `--surface-0/2` ≥ 8.3:1; use `--accent-fg`
  (near-black) as text/icon colour drawn on top of it.
- Light: `--accent: #a3540a` on `--surface-0/1` ≥ 5.1:1; use `--accent-fg`
  (near-white) on top of it.

Don't introduce a second interactive colour for "just this one button" —
extend `--accent` usage instead.

### Hazard-category accents

Seven tokens, one per `Dataset["theme"]` value in `src/catalogue.ts`
(`coastal_inundation`, `flood`, `landslide`, `earthquake`, `sea_level_rise`,
`climate`, `other`). These identify a hazard category at a glance — a
`.badge__dot`, a thin left border on a theme section heading — and are
**decorative swatches, not text colours**: nothing renders hazard-coloured
text directly against a surface, so they aren't held to the text-contrast
table above. Keep new uses to small dots/borders/outlines; they should never
compete with `--accent` for primary interactive attention (six accents is
zero accents).

### Status

`--success` / `--danger` cover the only other semantic colours the shell
needs. Don't add a third.

## Typography

Two families, differentiated by weight/tracking/case rather than a second
webfont (no self-hosted fonts ship in this ticket's file set):

- `--font-sans` — body copy and headings. Headings use `--weight-bold` +
  `--tracking-tight` to read as "display" without a second typeface.
- `--font-mono` — figures: dataset counts, the `.count` badge. Numbers use
  `font-variant-numeric: tabular-nums` wherever they can change (search
  results, counts) so digits don't jitter width.

Type scale (`--text-xs` … `--text-2xl`, ~1.25 modular ratio), line-heights
(`--leading-tight/snug/normal`) and weights (`--weight-regular` …
`--weight-bold`) are enumerated in `theme.css` with their intended use
inline. `--tracking-eyebrow` (0.08em, uppercase) is reserved for the small
uppercase section labels (`.eyebrow`) — the single highest-leverage
"designed" typographic move; don't reuse it for body text.

## Spacing & radii

8px-based scale, `--space-1` (4px, hairline gaps) through `--space-8`
(64px, section breathing room). Every margin/padding/gap in shared chrome
resolves to one of these — no bespoke pixel values. Radii: `--radius-sm`
(controls), `--radius-md` (cards, inputs), `--radius-lg` (panels/hero),
`--radius-full` (pills, dots).

## Elevation

`--shadow-sm/md/lg` are tuned per theme (very low-opacity black on dark,
low-opacity cool grey on light) and are for things that float above the
page — not a substitute for `--border` on regular cards.

## Focus ring

Defined once, globally, on `:focus-visible` in `style.css` using
`--focus-ring-color` (= `--accent`), `--focus-ring-width` (2px) and
`--focus-ring-offset` (2px). Don't redefine `outline` in a feature module
unless you also restore this ring — every focusable element in the app,
including ones feature modules add later, should show it.

## Motion

`--duration-fast` (120ms, feedback), `--duration-base` (200ms, default
transitions) and `--duration-slow` (320ms, view-level animation like the
hero's entrance), paired with `--ease-standard` / `--ease-out`. Only animate
`transform`/`opacity` — never layout properties. Every token collapses to
~0 under `@media (prefers-reduced-motion: reduce)` (set once, in
`theme.css`), and `style.css` additionally zeroes all `animation`/
`transition` durations under the same query as a global safety net — a new
component that uses a hard-coded `transition: 200ms` instead of the token
won't get this for free, so always reach for the token.

## Utilities (`style.css`)

`.stack` (vertical gap via flex-column, `--stack-space` overridable),
`.cluster` (wrapping horizontal group, `--cluster-space` overridable),
`.visually-hidden` (screen-reader-only), `.badge` (+ `.badge__dot`, coloured
via `--dot-color`), `.button` (primary, accent-filled, ≥44px touch target),
`.panel` (raised surface + hairline border + `--shadow-sm`). Reach for these
before writing new one-off layout CSS in a feature module.
