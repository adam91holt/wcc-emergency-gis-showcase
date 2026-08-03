// Thin bootstrap: renders the existing theme-grouped catalogue card list,
// initialises the router, and exposes a mount registry so later feature
// tickets (map/detail/charts/filters) attach a module by importing their
// render function here and calling registerMount() in boot() — two lines,
// rather than rewriting this file's structure. (The feature file itself
// stays a plain module with no dependency back on main.ts — see the
// FeatureModule doc below for why that direction matters.) This is still a
// SEED for the card list itself — the factory grows the four named mounts
// from here.
import { byTheme, label, catalogue, type Dataset } from "./catalogue";
import { getState, subscribe, type RouteState } from "./router";
import renderFilters, {
  applyFilters,
  filterStateFromRoute,
  getSelectedId,
  onSelectionChange,
  selectDataset,
} from "./filters";
// The map module's own Leaflet/esri-leaflet payload is behind a dynamic
// import inside renderMap, so this static import only costs the shell.
import renderMap from "./map";

/** The four stable mount points declared in index.html, one per feature ticket. */
export type MountId = "filters" | "map" | "detail" | "charts";

const MOUNT_SELECTORS: Record<MountId, string> = {
  filters: "#filters-root",
  map: "#map-root",
  detail: "#detail-root",
  charts: "#charts-root",
};

/** A feature module renders itself into its mount's root element and is
 * re-invoked whenever route state changes. Export one of these (e.g. as
 * `export default`) from your feature's own file — do NOT import
 * `registerMount` back into that file and call it there. main.ts is the
 * app's entry module (index.html loads only this file); if a feature module
 * imported main.ts to reach the registry, and main.ts side-effect-imported
 * that feature module to load its code (`import "./map"`), the two modules
 * would form an import cycle. ES modules resolve static imports before
 * either module's own top-level code runs, so the feature module could call
 * into `registry` before main.ts's `const registry = new Map()` had
 * executed — a temporal-dead-zone ReferenceError, not a type error, so it
 * wouldn't be caught by `bun run typecheck`. Instead, wire a new feature by
 * adding two lines here in main.ts: `import renderMap from "./map"` and
 * `registerMount("map", renderMap)` inside boot() — the feature file itself
 * never needs to import anything from main.ts. */
export type FeatureModule = (root: HTMLElement, state: RouteState) => void;

const registry = new Map<MountId, FeatureModule>();

/** Register a feature module against a named mount point. Call this from
 * main.ts (see the FeatureModule doc above for why). Renders immediately
 * with the current route state, then again on every route change. */
export function registerMount(id: MountId, mod: FeatureModule): void {
  registry.set(id, mod);
  renderMount(id, getState());
}

function renderMount(id: MountId, state: RouteState): void {
  if (typeof document === "undefined") return;
  const root = document.querySelector<HTMLElement>(MOUNT_SELECTORS[id]);
  const mod = registry.get(id);
  if (root && mod) mod(root, state);
}

function renderAllMounts(state: RouteState): void {
  for (const id of registry.keys()) renderMount(id, state);
}

/** `--i` staggers the card's mount animation (see filters.css); capped so a
 * 67-card render doesn't end in a one-second cascade. */
function card(d: Dataset, index: number): string {
  const link = d.url ? `<a href="${d.url}" target="_blank" rel="noreferrer">source ↗</a>` : "";
  // The button lives *inside* the heading (not the other way round) so the
  // card stays a real h3 for screen-reader heading navigation while being
  // operable from the keyboard.
  return `<article class="ds" data-scope="${d.scope}" data-id="${d.id}" style="--i:${Math.min(index, 14)}">
    <h3><button type="button" class="ds-select" aria-pressed="false">${label(d)}</button></h3>
    <p class="meta">${d.scope} · ${d.authority ?? "—"}${d.year ? ` · ${d.year}` : ""}</p>
    ${link}
  </article>`;
}

/** The theme × scope × query slice the card list is currently showing. A
 * selection-only route change (dataset=…) must not rebuild the list — that
 * would restart every card's mount animation and throw away the DOM the
 * highlight is about to touch. */
let renderedSlice: string | null = null;

/** Renders the catalogue card list for the current route state — filtered
 * through filters.ts's theme × scope × query predicate, so this list and the
 * filter panel are always looking at the same data. */
function renderCatalogue(state: RouteState): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  const filters = filterStateFromRoute(state);
  const slice = `${filters.theme ?? ""} ${filters.scope ?? ""} ${filters.query ?? ""}`;
  if (slice === renderedSlice) return;
  renderedSlice = slice;

  // No empty markup here on purpose: when nothing matches, the filter console
  // directly above shows the explanation and the one-click reset, next to the
  // controls that caused it. Two empty states would say the same thing twice.
  let index = 0;
  app.innerHTML = [...byTheme(applyFilters(filters)).entries()]
    .map(([theme, ds]) => `<section><h2>${theme} <span class="count">${ds.length}</span></h2>
      <div class="grid">${ds.map((d) => card(d, index++)).join("")}</div></section>`)
    .join("");
  highlightSelection(getSelectedId());
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Paint the selected dataset into the card list. Driven by filters.ts's
 * selection API, so a selection made anywhere — a card click, Enter in the
 * search combobox, a pasted deep link, Back/Forward — lands here the same way
 * (and the map/detail tickets subscribe to exactly the same callback). */
function highlightSelection(id: string | undefined): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  for (const node of app.querySelectorAll<HTMLElement>(".ds")) {
    const selected = node.dataset.id === id;
    node.classList.toggle("is-selected", selected);
    node.querySelector(".ds-select")?.setAttribute("aria-pressed", String(selected));
    if (selected) {
      node.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
  }
}

/** One delegated listener for the whole card list, since #app's innerHTML is
 * replaced wholesale whenever the filters change. Clicking the already
 * selected card clears the selection, so the card is a real toggle. */
function wireCardList(app: HTMLDivElement): void {
  app.addEventListener("click", (event) => {
    const select = (event.target as HTMLElement).closest<HTMLElement>(".ds-select");
    const id = select?.closest<HTMLElement>(".ds")?.dataset.id;
    if (!id) return;
    selectDataset(id === getSelectedId() ? undefined : id);
  });
}

function boot(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  document.querySelector<HTMLElement>("#total")!.textContent = String(catalogue.counts.total);
  wireCardList(app);
  registerMount("filters", renderFilters);
  registerMount("map", renderMap);
  renderCatalogue(getState());
  onSelectionChange(highlightSelection);
  subscribe((state) => {
    renderAllMounts(state);
    renderCatalogue(state);
  });
}

if (typeof document !== "undefined") boot();
