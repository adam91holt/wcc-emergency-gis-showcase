// Scenario briefings — the guided first run.
//
// Every surface in this app is deep-linkable (see src/router.ts), but an
// empty hash is an empty map: 67 cards and nothing drawn. This module turns
// the existing `layers=` / `theme=` / `dataset=` plumbing into a handful of
// curated stories — one click and the harbour is ringed with inundation
// extents, the faults are drawn and the detail panel is already open on the
// dataset that anchors the story. The same click is a shareable link, which
// is what the emergency-management audience actually passes around.
//
// Concept (carried from the discovery console in src/filters.ts): a rack of
// pre-set briefings on a dispatcher's panel. Each briefing is an instrument,
// not a pill — it reports, live, how much of its picture is currently lit on
// the map (2 of 4 layers), so the rack doubles as a read on where the user
// has wandered to by hand. Fully lit = the briefing is loaded and its chip is
// pressed; partly lit = a real, visible in-between state.
//
// Split the same way every other feature module here is split:
//   - pure scenario data + patch/match logic (no `document`, no `window`), so
//     src/scenarios.test.ts exercises it directly in the node environment;
//   - DOM rendering behind a `typeof document === "undefined"` guard.
// It imports nothing from src/main.ts — main.ts wires it with two lines (see
// the FeatureModule doc there).
import "./scenarios.css";
import { mappableDatasets, type Dataset } from "./catalogue";
import { getState, setState, type RouteState } from "./router";

// ---------------------------------------------------------------------------
// Scenario data (pure)
// ---------------------------------------------------------------------------

/** Glyph keys for the icon family drawn at the bottom of this file. */
export type ScenarioIcon = "coast" | "fault" | "flood" | "slope" | "tsunami" | "lifeline";

/** The router keys a scenario is allowed to own. `query`/`scope` are left to
 * the discovery console — a briefing narrows the *map*, it never silently
 * re-types the user's search. */
export type ScenarioKey = "layers" | "theme" | "dataset";

const SCENARIO_KEYS: ScenarioKey[] = ["layers", "theme", "dataset"];

export interface Scenario {
  /** Stable id — used as the chip's `data-scenario` handle, not a hash key. */
  id: string;
  title: string;
  /** One line, sentence case: what this briefing puts on the screen. */
  description: string;
  icon: ScenarioIcon;
  /** The route state this briefing deep-links to. `layers` is required (a
   * briefing that draws nothing is not a briefing); every id in it must be a
   * mappable catalogue dataset — scenarios.test.ts enforces both. */
  patch: Partial<RouteState> & { layers: string[] };
}

/** The curated set. Layer ids are catalogue ids that survive
 * `mappableDatasets()` (queryable, vector, resolved Feature Layer) — the
 * raster/portal rows a reader might expect here (`storm-surge`,
 * `slope-over-25`, `sea-level-rise`) cannot be drawn, so they are deliberately
 * absent rather than silently dropped by the map at runtime. Each briefing's
 * `dataset` shares its `theme`, so the theme filter never hides the very card
 * the briefing just selected. */
export const SCENARIOS: Scenario[] = [
  {
    id: "coastal",
    title: "Coastal inundation",
    description: "Medium and high inundation hazard around the harbour, over the national erosion index.",
    icon: "coast",
    patch: {
      layers: ["coastal-inundation-medium", "coastal-inundation-high", "coastal-erosion-index"],
      theme: "coastal_inundation",
      dataset: "coastal-inundation-high",
    },
  },
  {
    id: "earthquake",
    title: "Earthquake & liquefaction",
    description: "Active faults over the district-plan and regional liquefaction ground.",
    icon: "fault",
    patch: {
      layers: ["active-faults", "liquefaction-overlay", "liquefaction-regional", "soil-classification-regional"],
      theme: "earthquake",
      dataset: "active-faults",
    },
  },
  {
    id: "flooding",
    title: "Flooding & flowpaths",
    description: "Stream corridors, overland flowpaths and where the water sits afterwards.",
    icon: "flood",
    patch: {
      layers: ["stream-corridor", "overland-flowpath", "ponding-areas"],
      theme: "flood",
      dataset: "overland-flowpath",
    },
  },
  {
    id: "landslide",
    title: "Landslides & steep slopes",
    description: "GNS slide morphology across the city with regional shaking-induced slope failure.",
    icon: "slope",
    patch: {
      layers: ["landslide-features", "landslide-process", "landslide-materials", "slope-failure"],
      theme: "landslide",
      dataset: "landslide-features",
    },
  },
  {
    id: "tsunami",
    title: "Tsunami evacuation",
    description: "City and regional evacuation zones — the two that get read together in an event.",
    icon: "tsunami",
    patch: {
      layers: ["tsunami-evacuation-zones", "tsunami-zones-regional"],
      theme: "earthquake",
      dataset: "tsunami-evacuation-zones",
    },
  },
  {
    id: "lifelines",
    title: "Access & lifelines",
    description: "Roads, footpaths, park tracks and sensor cut lines — the network an evacuation uses.",
    icon: "lifeline",
    patch: {
      layers: ["roads", "footpaths", "parks-tracks", "transport-sensors"],
      theme: "other",
      dataset: "roads",
    },
  },
];

/** Look up a briefing by its id. */
export function scenarioById(id: string, list: Scenario[] = SCENARIOS): Scenario | undefined {
  return list.find((s) => s.id === id);
}

/** The route keys this briefing writes, in a stable order. */
export function scenarioKeys(scenario: Scenario): ScenarioKey[] {
  return SCENARIO_KEYS.filter((key) => key in scenario.patch);
}

/** The layer ids in route state the map can actually draw — same contract as
 * map.ts's `layersFromRoute` (unknown/raster ids dropped, duplicates
 * collapsed), re-derived from the catalogue here so this module stays
 * independent of the map ticket's internals. */
export function drawableLayerIds(state: RouteState, list: Dataset[] = mappableDatasets()): string[] {
  const known = new Set(list.map((d) => d.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of state.layers ?? []) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** How many of the briefing's layers are currently switched on. This is what
 * the chip's meter reports, so hand-toggling one of a briefing's layers on
 * the map panel is visible in the rack as a partial fill. */
export function scenarioLayersOn(scenario: Scenario, state: RouteState): number {
  const on = new Set(state.layers ?? []);
  return scenario.patch.layers.filter((id) => on.has(id)).length;
}

/** Is the app showing exactly this briefing? Every key the briefing owns must
 * match route state: scalars by equality, `layers` as a set (hash order is
 * not meaningful) with no extras. Deliberately exact rather than "contains":
 * `aria-pressed="true"` on a chip claims *this* is the picture on screen, and
 * clicking it clears exactly the keys it set — so a state carrying extra
 * layers reads as partial (the meter says so) rather than as loaded. */
export function isScenarioActive(scenario: Scenario, state: RouteState): boolean {
  for (const key of scenarioKeys(scenario)) {
    if (key === "layers") {
      const wanted = scenario.patch.layers;
      const have = state.layers ?? [];
      if (new Set(have).size !== new Set(wanted).size) return false;
      if (scenarioLayersOn(scenario, state) !== new Set(wanted).size) return false;
    } else if (state[key] !== scenario.patch[key]) {
      return false;
    }
  }
  return true;
}

/** The router patch one click on this briefing should write. Toggle
 * semantics, matching the card list and the theme chips: clicking a loaded
 * briefing clears the keys it set (each written as `undefined` so
 * router.mergeHash *deletes* them rather than leaving `layers=` empty), and
 * any key the briefing doesn't own is left alone. */
export function patchForScenario(scenario: Scenario, state: RouteState): Partial<RouteState> {
  if (!isScenarioActive(scenario, state)) {
    return { ...scenario.patch, layers: [...scenario.patch.layers] };
  }
  const cleared: Partial<RouteState> = {};
  for (const key of scenarioKeys(scenario)) {
    if (key === "layers") cleared.layers = undefined;
    else if (key === "theme") cleared.theme = undefined;
    else cleared.dataset = undefined;
  }
  return cleared;
}

/** Load (or, when it is already loaded, clear) a briefing. No-ops outside a
 * browser, because router.setState does. */
export function applyScenario(scenario: Scenario, state: RouteState = getState()): void {
  setState(patchForScenario(scenario, state));
}

/** The rack's own status line: what is loaded and how much of it is drawn. */
export function announcement(state: RouteState, list: Scenario[] = SCENARIOS): string {
  const drawn = drawableLayerIds(state).length;
  const active = list.find((s) => isScenarioActive(s, state));
  const layers = `${drawn} ${drawn === 1 ? "layer" : "layers"} on the map`;
  if (active) return `${active.title} briefing loaded — ${layers}.`;
  return drawn > 0 ? `No briefing loaded — ${layers}.` : "No briefing loaded — the map is clear.";
}

// ---------------------------------------------------------------------------
// Icon set — one family, same rules as src/filters.ts and src/map.ts: solid
// paths hand-drawn on a 16px grid, filled in currentColor. No second icon
// library, no emoji.
// ---------------------------------------------------------------------------

function svg(path: string, size = 16): string {
  return `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" fill-rule="evenodd" aria-hidden="true" focusable="false"><path d="${path}" fill="currentColor"/></svg>`;
}

const ICONS: Record<ScenarioIcon, string> = {
  // Two stacked swell bands.
  coast: svg(
    "M1 5.2 4 3.2 7 5.2 10 3.2 13 5.2v2L10 5.2 7 7.2 4 5.2 1 7.2v-2Z M1 10.4 4 8.4 7 10.4 10 8.4 13 10.4v2L10 10.4 7 12.4 4 10.4 1 12.4v-2Z M14.6 3.2h1.2v9.6h-1.2V3.2Z",
  ),
  // A fault scarp — ground offset across a break — with the epicentre above.
  fault: svg(
    "M1 7.4h5v2H1V7.4Z M6 7.4h2v5.4H6V7.4Z M8 10.8h7v2H8v-2Z M11.4 1.6a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2Z",
  ),
  // Droplet over a flowpath line.
  flood: svg(
    "M8 1.2c2.6 3.1 4.4 5.3 4.4 7.3a4.4 4.4 0 0 1-8.8 0c0-2 1.8-4.2 4.4-7.3Z M1 13.4c1.8 0 1.8-1.4 3.5-1.4s1.7 1.4 3.5 1.4 1.8-1.4 3.5-1.4 1.7 1.4 3.5 1.4v1.6c-1.8 0-1.8-1.4-3.5-1.4s-1.7 1.4-3.5 1.4-1.8-1.4-3.5-1.4-1.7 1.4-3.5 1.4v-1.6Z",
  ),
  // A steep face with debris coming off it.
  slope: svg(
    "M14.6 3.4v10.2H2.2L14.6 3.4Z M4.6 3.6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z M8.4 1a1.1 1.1 0 1 1 0 2.2A1.1 1.1 0 0 1 8.4 1Z",
  ),
  // Evacuate uphill, away from the swell.
  tsunami: svg(
    "M8 .8l4.2 5.2H9.5v4.2h-3V6H3.8L8 .8Z M1 12.4c1.8 0 1.8-1.4 3.5-1.4s1.7 1.4 3.5 1.4 1.8-1.4 3.5-1.4 1.7 1.4 3.5 1.4V15c-1.8 0-1.8-1.4-3.5-1.4s-1.7 1.4-3.5 1.4-1.8-1.4-3.5-1.4S2.8 15 1 15v-2.6Z",
  ),
  // A road with its centre line, drawn as holes in the carriageway.
  lifeline: svg(
    "M5.2 1.4h5.6l2.6 13.2H2.6L5.2 1.4Z M7.35 3.2h1.3v2.4h-1.3V3.2Z M7.25 6.8h1.5v2.6h-1.5V6.8Z M7.15 10.6h1.7v2.6h-1.7v-2.6Z",
  ),
};

// ---------------------------------------------------------------------------
// DOM rendering — the briefing rack (#scenarios-root)
// ---------------------------------------------------------------------------
// Built once, then patched in place on every route change (same discipline as
// the discovery console): re-serialising innerHTML would restart the mount
// stagger and drop keyboard focus off the chip the user just pressed.

interface Chip {
  button: HTMLButtonElement;
  glyph: HTMLElement;
  meter: HTMLElement;
  on: HTMLElement;
}

interface Rack {
  root: HTMLElement;
  shell: HTMLElement;
  live: HTMLElement;
  drawn: HTMLElement;
  chips: Map<string, Chip>;
}

let rack: Rack | null = null;
let hydrating = false;
let pendingRoute: RouteState | null = null;

const wiredRoots = new WeakSet<HTMLElement>();

/** Skeleton shapes with the real rack's geometry (label, readout, one card
 * per briefing at the real card height), so the first frame is the layout
 * that is about to arrive — never a spinner, never a blank flash. */
function paintSkeleton(root: HTMLElement): void {
  const cards = SCENARIOS.map(
    (_, i) => `<span class="scn-skel scn-skel--card" style="--i:${i}" aria-hidden="true"></span>`,
  ).join("");
  root.innerHTML = `
    <section class="playbook is-loading" aria-busy="true">
      <div class="playbook__head">
        <p class="playbook__label">Scenario briefings</p>
        <span class="scn-skel scn-skel--readout" aria-hidden="true"></span>
      </div>
      <div class="playbook__rack">${cards}</div>
      <p class="scn-sr">Loading scenario briefings…</p>
    </section>`;
}

function chipMarkup(scenario: Scenario, index: number): string {
  const total = scenario.patch.layers.length;
  return `<button type="button" class="scen" data-scenario="${scenario.id}" aria-pressed="false" data-state="idle" style="--i:${index}">
    <span class="scen__frame">
      <span class="scen__top">
        <span class="scen__glyph" aria-hidden="true">${ICONS[scenario.icon]}</span>
        <span class="scen__title">${scenario.title}</span>
      </span>
      <span class="scen__desc">${scenario.description}</span>
      <span class="scen__foot" aria-hidden="true">
        <span class="scen__readout"><span class="scen__on">0</span><span class="scen__of">/${total}</span></span>
        <span class="scen__unit">layers</span>
        <span class="scen__meter"><span class="scen__meter-fill"></span></span>
      </span>
    </span>
  </button>`;
}

function buildRack(root: HTMLElement): Rack {
  root.innerHTML = `
    <section class="playbook" data-loaded="false">
      <div class="playbook__head">
        <div class="playbook__ident">
          <p class="playbook__label">Scenario briefings</p>
          <p class="playbook__hint">One click loads a curated hazard picture and its deep link — click it again to clear.</p>
        </div>
        <p class="playbook__readout" aria-hidden="true">
          <span class="playbook__drawn">0</span>
          <span class="playbook__unit">layers live</span>
        </p>
      </div>
      <div class="playbook__rack">${SCENARIOS.map(chipMarkup).join("")}</div>
      <p class="scn-sr" role="status" aria-live="polite"></p>
    </section>`;

  const chips = new Map<string, Chip>();
  for (const scenario of SCENARIOS) {
    const button = root.querySelector<HTMLButtonElement>(`.scen[data-scenario="${scenario.id}"]`)!;
    chips.set(scenario.id, {
      button,
      glyph: button.querySelector<HTMLElement>(".scen__glyph")!,
      meter: button.querySelector<HTMLElement>(".scen__meter-fill")!,
      on: button.querySelector<HTMLElement>(".scen__on")!,
    });
  }

  wireRack(root);

  return {
    root,
    shell: root.querySelector<HTMLElement>(".playbook")!,
    live: root.querySelector<HTMLElement>(".scn-sr")!,
    drawn: root.querySelector<HTMLElement>(".playbook__drawn")!,
    chips,
  };
}

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** Restart the glyph's pop animation (the class alone wouldn't replay it on a
 * second load of the same briefing). */
function armGlyph(glyph: HTMLElement): void {
  glyph.classList.remove("is-armed");
  void glyph.offsetWidth; // force a reflow so the animation restarts
  glyph.classList.add("is-armed");
}

/** Paint route state onto the rack: pressed state, per-briefing meter fill,
 * the panel's live layer count and one polite announcement. */
function syncRack(state: RouteState): void {
  if (!rack) return;
  let loaded = false;

  for (const scenario of SCENARIOS) {
    const chip = rack.chips.get(scenario.id);
    if (!chip) continue;
    const total = scenario.patch.layers.length;
    const on = scenarioLayersOn(scenario, state);
    const active = isScenarioActive(scenario, state);
    loaded = loaded || active;

    // The lock-in beat: the glyph pops the moment a briefing goes live, so
    // loading one is felt and not just read. Retriggered on the transition
    // only (never on every route change) and drawn on the glyph rather than
    // the button, so it can't fight the button's hover/press transform.
    if (active && chip.button.dataset.state !== "live") armGlyph(chip.glyph);
    chip.button.setAttribute("aria-pressed", String(active));
    chip.button.dataset.state = active ? "live" : on > 0 ? "partial" : "idle";
    setText(chip.on, String(on));
    // scaleX rather than width: the meter animates on the compositor.
    chip.meter.style.transform = `scaleX(${total > 0 ? on / total : 0})`;
  }

  rack.shell.dataset.loaded = String(loaded);
  setText(rack.drawn, String(drawableLayerIds(state).length));
  setText(rack.live, announcement(state));
}

function wireRack(root: HTMLElement): void {
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(".scen");
    const scenario = button?.dataset.scenario ? scenarioById(button.dataset.scenario) : undefined;
    if (!scenario) return;
    applyScenario(scenario, getState());
  });
}

/** The FeatureModule registered against `#scenarios-root` in src/main.ts.
 * Called once at boot and again on every route change — so Back/Forward and a
 * pasted deep link restyle the rack the same way a click does. */
export default function renderScenarios(root: HTMLElement, state: RouteState): void {
  if (typeof document === "undefined") return;
  pendingRoute = state;
  if (rack && rack.root === root) {
    syncRack(state);
    return;
  }
  // Re-mounting into a different root (HMR, or any future re-init): the old
  // rack's nodes are gone, so drop the singleton rather than patching detached
  // elements nobody can see.
  if (rack && rack.root !== root) rack = null;
  if (hydrating) return;
  hydrating = true;
  paintSkeleton(root);
  const hydrate = (): void => {
    rack = buildRack(root);
    hydrating = false;
    syncRack(pendingRoute ?? getState());
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(hydrate);
  else hydrate();
}
