# Design tokens

The shared visual vocabulary for the WCC Emergency GIS Data Showcase lives in
`src/theme.css` as CSS custom properties, and `src/style.css` is built entirely
on top of it. Every sibling feature module (map, dataset detail, filters,
charts) should consume these tokens rather than hard-coding a hex value, a
pixel size, or a duration — that is what keeps four independently shipped
tickets reading as one product.

`theme.css` holds the **only** raw hex values and the **only** raw pixel
literals in the codebase. If you find yourself typing `#` or `px` outside it,
either an existing token fits or a new one belongs in `theme.css`.

Scope: this file documents shared-chrome tokens only. Feature modules own their
own component CSS files and may add module-scoped classes alongside them, but
should not redefine anything below.

---

## The concept: "situation board"

The app is dressed as an emergency-management wall display. Concretely, that
means five recurring moves — match them and your module will look native:

1. **Near-black instrument surfaces** with hairline rules doing the separating,
   not drop shadows.
2. **Uppercase micro-labels** (`.eyebrow`) titling every region, with a
   hairline running out to the edge of that region.
3. **Tabular monospace figures** for every number, so counts do not jitter as
   the catalogue re-renders on each keystroke.
4. **A channel colour system** — one hue per hazard theme, one stripe colour
   per publishing tier — carried consistently across map, filters and cards.
5. **One ambient signal sweep** along the masthead rule. It is the only looping
   animation in the product; do not add a second.

---

## Theming

The app is **dark-first**: `:root` in `theme.css` (no media query, no
attribute) *is* the dark palette — the default and the fallback for any browser
or embedding context that does not understand `prefers-color-scheme`. Light
mode is a deliberate port, not an inversion, and layers on in ascending
precedence:

| Layer | Selector | Wins over |
| --- | --- | --- |
| Dark (designed default) | `:root` | — |
| Light, OS-driven | `@media (prefers-color-scheme: light) :root` | the default |
| Explicit override | `html[data-theme="light" \| "dark"]` | both |

A small classic script in `index.html` reads `localStorage["wcc-gis-theme"]`
before first paint and sets `data-theme` on `<html>`, so an explicitly chosen
theme never flashes the OS default. The masthead toggle writes it back.
**Feature modules never need to know which theme is active** — read tokens and
you are correct in both.

> The light ramp is intentionally duplicated between the media query and the
> `[data-theme="light"]` block. CSS cannot express "media query OR attribute"
> in one selector. Change one, change the other.

---

## Colour

### Surfaces — a ladder, climb it

| Token | Use |
| --- | --- |
| `--surface-0` | Page background. Nothing else. |
| `--surface-1` | Masthead, footer, `.panel`, hero. |
| `--surface-2` | Raised things on a panel: cards, inputs, the channel index. |
| `--surface-3` | Hover / pressed state of a `--surface-2` element; badge fills. |
| `--surface-inset` | Wells and troughs that sit *below* the page. |

### Borders

`--border` is the default hairline; `--border-strong` marks hover, focus-within
and any edge that needs to read as deliberate. Always at `--border-width`.

### Text — steps down in luminance, never in opacity

| Token | Use | Contrast (dark / light, on `--surface-0`) |
| --- | --- | --- |
| `--text-primary` | Headings, card titles, values | 17.1:1 / 16.1:1 |
| `--text-secondary` | Body copy, lede, footer links | 9.2:1 / 7.5:1 |
| `--text-tertiary` | Eyebrows, meta lines, placeholders | 6.6:1 / 5.2:1 |

Never use `opacity` to make text quieter — it breaks against a tinted surface.
All three clear WCAG AA (4.5:1) against `--surface-0` **and** `--surface-3` in
both modes.

### The one owned accent

`--accent` (emergency signal amber) is the product's colour. It owns live and
active state, the fault line in the brand mark, headline figures, and focus.
Nothing else competes with it.

| Token | Use |
| --- | --- |
| `--accent` | The accent itself |
| `--accent-hover` / `--accent-pressed` | Interactive states of an accent fill |
| `--accent-fg` | Text/icons drawn **on top of** `--accent` |
| `--accent-quiet` | Low-alpha tint fill (selected rows, active chips) |
| `--accent-line` | Low-alpha tint hairline, underlines, selection |

Status colours are limited to `--success` and `--danger`. Resist adding a
third: six accents means zero accents.

### Hazard channels

One hue per non-null `Dataset["theme"]` from `src/catalogue.ts`. Token names
match the theme key exactly, so a module can build the variable name from
data:

```css
.layer { border-inline-start-color: var(--hazard-flood); }
```

**`Dataset["theme"]` is nullable.** The 11 national-scope rows (`scope ===
"national"`) carry `theme: null` — `byTheme()` in `src/catalogue.ts` buckets
them under a synthetic `"Uncategorised"` group precisely because they have no
theme, and `src/catalogue.selectors.test.ts` asserts this count (23 wcc + 33
regional + 11 national; the `themes()` selector's total is smaller than
`datasets().length` for exactly this reason). Building a token name from
`dataset.theme` without accounting for `null` produces `--hazard-null`, which
does not exist — always fall back explicitly:

```ts
el.style.setProperty(
  "--channel-color",
  `var(--hazard-${dataset.theme ?? "other"})`,
);
```

`--hazard-other` is the intended home for anything outside the seven named
themes, so route null-theme (uncategorised/national) rows there rather than
inventing an eighth hue — the masthead's "Channels" figure (derived from
`themes().length`, not hardcoded) describes the seven themed channels only,
and `--hazard-other` is what keeps an unthemed row visually consistent with
them instead of falling through to an undefined custom property.

**No hazard-channel legend ships in this shell.** These hues have no visible
instance on the page yet — this seed's cards carry only a `data-scope` edge
stripe, not a per-theme colour — so a decode-this-colour-system key here would
teach a code with nothing to point at. Land the legend next to the first
surface that actually paints with `--hazard-*` (the map's layer list or the
filter chips), not in the shared shell.

`--hazard-coastal_inundation`, `--hazard-flood`, `--hazard-landslide`,
`--hazard-earthquake`, `--hazard-sea_level_rise`, `--hazard-climate`,
`--hazard-other`.

Every hue is verified ≥ 4.5:1 against both `--surface-0` and `--surface-3` in
both modes, so a channel name may be **set** in its own colour, not merely
swatched. Use them for identity — a stripe, a dot, a series line, a section
rule. Never for primary interactive attention; that is `--accent`'s job.

### Scope stripes

`--scope-wcc`, `--scope-regional`, `--scope-national` map `Dataset["scope"]` to
the stripe down a card's leading edge (`--edge-width`). They alias hues already
in the palette, so the product's total colour count does not grow. The hero's
scope key is what teaches the reader to decode them — keep it in sync if you
change one.

---

## Type

Three families, a real hierarchy, and a strict rule about which does what.

| Token | Family | Carries |
| --- | --- | --- |
| `--font-display` | Space Grotesk | Headings, chrome, eyebrows, buttons, card titles |
| `--font-sans` | Inter | Prose and body copy |
| `--font-mono` | IBM Plex Mono | Every figure, id, service path and code token |

Self-hosted per house style — there is no font `<link>` in `index.html` and no
third-party font CDN in the request path. Until the named weights are vendored
into `public/fonts/` with matching `@font-face` rules, each stack resolves to
its first installed system face, which is the deliberate current state, not a
fallback-on-failure.

### Scale

| Token | Size | Use |
| --- | --- | --- |
| `--text-2xs` | 11px | Uppercase eyebrows, legend keys, stat captions, card meta |
| `--text-xs` | 12px | Badges, footer, source links, counts |
| `--text-sm` | 14px | Dense card body, secondary controls, hero body |
| `--text-base` | 16px | Body copy (the `body` default) |
| `--text-md` | 18px | Lede paragraphs, brand name |
| `--text-lg` | 22px | Section headings |
| `--text-xl` | 28px | Panel titles, ledger figures |
| `--text-2xl` | 36px | Page heading |
| `--text-3xl` | fluid | Reserved for a full-bleed statement |

Weights are `--weight-regular` 400, `--weight-medium` 500,
`--weight-semibold` 600, `--weight-bold` 700 — do not introduce a fifth.
Line heights: `--leading-tight` (headings), `--leading-snug` (ledes, card
titles), `--leading-normal` (prose). Tracking: `--tracking-tight` on display
headings, `--tracking-eyebrow` (0.09em) on every uppercase micro-label.

Add `.num` to any element containing a figure to get the mono face plus
`tabular-nums`.

---

## Space, radii, line weights

`--space-0` … `--space-8` is an 8px rhythm on a 4px grid: 0, 4, 8, 12, 16, 24,
32, 48, 64px. **Every** margin, padding and gap in the app is one of these.
Off-grid spacing is the single loudest "template default" tell.

Density is chosen per surface, not globally:

- **Scanning/comparing surfaces** (the ledger, the card grid, the channel
  index) are tight — `--space-2` / `--space-3` gaps, hairline-ruled.
- **Reading/deciding surfaces** (the hero briefing, the empty state) breathe —
  `--space-5` / `--space-6` padding and a capped measure.

Radii: `--radius-sm` 6px (inputs, chips, skeletons), `--radius-md` 10px
(buttons, cards), `--radius-lg` 16px (panels), `--radius-full` (pills, dots).

Line weights: `--border-width` 1px (all hairlines), `--rule-width` 2px (eyebrow
rules, the masthead sweep track), `--edge-width` 3px (the scope stripe).

## Layout

| Token | Value | Use |
| --- | --- | --- |
| `--content-width` | 72rem (84rem ≥ 100rem viewport) | The outer content column |
| `--prose-width` | 62ch | `max-inline-size` on any run of prose |
| `--lede-width` | 54ch | Short, large statements |
| `--search-width` | 34rem | The search field's cap |
| `--card-min` | 15rem | `auto-fill` track floor for the card grid |
| `--channel-min` | 9.5rem | `auto-fill` track floor for the channel index |
| `--tap-min` | 2.75rem (44px) | Minimum interactive target (WCAG 2.5.5) |
| `--icon-size` / `--icon-size-sm` | 20 / 16px | Icon box |
| `--brand-mark` | 40px | The masthead mark |
| `--dot-size` | 8px | Badge dots |

`--content-width` widens to 84rem past a 100rem viewport (set in `theme.css`).
The shell is verified from 360px to ultrawide with no horizontal scroll.

> Breakpoint *conditions* are the one unavoidable literal in `style.css` — CSS
> custom properties are not valid inside a media query condition. Everything a
> query *sets* is still a token.

---

## Elevation

`--shadow-sm` / `--shadow-md` / `--shadow-lg`, driven by `--shadow-color`.
On dark, hairlines do nearly all the separating and shadows only whisper;
in light mode the same tokens carry more of the load. Reach for a border
before you reach for a shadow.

---

## Focus

Defined **once**, in `style.css`, on `:focus-visible`, and inherited by every
focusable element in the app. Do not restyle focus in a component.

- `--focus-ring-color` (the accent), `--focus-ring-width` 2px,
  `--focus-ring-offset` 2px — the outline form.
- `--focus-ring` — the composed `box-shadow` form, for controls that already
  own their outline or that sit inside a clipped container.

If your module renders a custom control, make sure it is a real focusable
element and do **not** set `outline: none` without substituting `--focus-ring`.

---

## Motion

`transform` and `opacity` only — never animate layout properties.

| Token | Value | Use |
| --- | --- | --- |
| `--duration-fast` | 120ms | Hover / press feedback |
| `--duration-base` | 200ms | Control state change |
| `--duration-slow` | 320ms | Element enter |
| `--duration-shimmer` | 1400ms | Skeleton sheen cycle |
| `--duration-ambient` | 7s | The masthead sweep — the only ambient loop |
| `--stagger-step` | 24ms | Per-item delay in a staggered list |

Easings: `--ease-standard`, `--ease-out`, `--ease-spring` (for things that
should feel like they have mass). Composites `--transition-colors` and
`--transition-transform` cover most needs.

**Reduced motion is handled centrally.** `theme.css` collapses the duration
tokens to ~0 under `prefers-reduced-motion: reduce`, and `style.css` stops
looping animations outright (a 0.01ms loop would strobe rather than settle). If
you express timing with the tokens above, your module is already compliant —
you do not need your own media query.

---

## Utilities in `style.css`

| Class | Purpose |
| --- | --- |
| `.stack` | Vertical flow with a consistent gap; override `--stack-space` |
| `.cluster` | Horizontal group that wraps; override `--cluster-space` |
| `.panel` | Panel surface + hairline + radius + soft shadow |
| `.eyebrow` | Uppercase micro-label with a hairline running to the edge |
| `.prose` | Capped measure + secondary text colour |
| `.badge` / `.badge__dot` | Pill label; set `--dot-color` for the dot |
| `.button` | Accent action; `.button--ghost` quiet; `.button--icon` square |
| `.icon` / `.icon--sm` | Icon box, sized from tokens |
| `.visually-hidden` | Screen-reader-only text |
| `.num` | Mono + tabular figures |
| `.skeleton`, `.skeleton--text`, `.skeleton--title`, `.skeleton-card` | The loading convention |

### Icons

The app has **one** icon set: an inline `<symbol>` sprite at the top of
`index.html`, drawn on a 24px grid with a 1.6 stroke and round caps/joins.
Reference one with `<svg class="icon"><use href="#icon-search" /></svg>`. Add
new glyphs to that sprite in the same style. Do not pull in an icon library,
and never use an emoji in place of a glyph.

### Loading

Anything async gets a **skeleton shaped like its result**, so the layout does
not jump when content lands — never a bare spinner, a blank flash, or a
"Loading…" string. Compose `.skeleton` blocks into the silhouette of your
panel; `.skeleton-card` already matches a `.ds` card exactly. The sheen is a
`translateX` on a pseudo-element, so it stays on the compositor.

Live examples ship in the shell: the `#total`, `#channels-total` and
`#tiers-total` ledger figures each render a figure-shaped placeholder until
their writer (`main.ts` for `#total`; the small boot module in `index.html`,
reading `src/catalogue.ts`, for the other two) fills them in, and `#app` holds
a four-card skeleton grid that `main.ts` replaces wholesale on its first
render.

### Mount points

`#filters-root`, `#map-root`, `#detail-root` and `#charts-root` are
`display: none` while empty, so the shell stays clean until your module mounts.
Render content into your root and the region appears — no shell change needed.
