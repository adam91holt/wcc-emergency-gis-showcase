# CLAUDE.md — WCC Emergency GIS Data Showcase

## What this is
A public web app that showcases the Wellington City Council Emergency
Management GIS datasets (67 public datasets: coastal inundation, flooding,
active faults, landslides, climate projections, and more). The dataset
catalogue is bundled at `data/catalogue.json` (verbatim from the upstream
`claudecommunity-nz/wcc-emergency-gis-data` repo). The goal is a genuinely
useful, beautiful, explorable showcase of this data.

## Commands
```bash
bun install
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun run build       # tsc + vite build
bun run dev         # local dev server
```

## Conventions for contributors (incl. the factory)
- **Vanilla TypeScript + Vite. Zero runtime dependencies** unless a ticket
  explicitly calls for one — keep it fast and dependency-light.
- All dataset access goes through `src/catalogue.ts` (typed selectors). Add
  new selectors there with tests in `src/catalogue.test.ts`.
- **Do not edit** `.github/`, this `CLAUDE.md`, or the bundled `data/` — the
  data is upstream-owned and CI is fixed. Build features in `src/` and
  `public/`, and ADD new tests (never modify/delete existing ones).
- Every feature ships with a passing vitest test and clean typecheck/build —
  that is the merge gate.

## What "fantastic" looks like
An interactive map of Wellington with hazard layers, per-dataset detail views,
theme filtering, search, charts for the climate time-series data, and a clean
responsive design that works in light and dark mode. Ship it incrementally;
each PR should leave `main` green and the app strictly better.
