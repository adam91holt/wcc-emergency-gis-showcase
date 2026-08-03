// Thin bootstrap: renders the existing theme-grouped catalogue card list,
// initialises the router, and exposes a mount registry so later feature
// tickets (map/detail/charts/filters) attach a module by importing their
// render function here and calling registerMount() in boot() — two lines,
// rather than rewriting this file's structure. (The feature file itself
// stays a plain module with no dependency back on main.ts — see the
// FeatureModule doc below for why that direction matters.) This is still a
// SEED for the card list itself — the factory grows the four named mounts
// from here.
import { byTheme, search, label, catalogue, type Dataset } from "./catalogue";
import { getState, subscribe, type RouteState } from "./router";

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

// Entrance stagger is capped rather than left uncapped: a result set can run
// to dozens of cards in one section, and a delay that keeps climbing with
// index would make the tail of a big section crawl in over a visibly long
// tail instead of reading as one quick, instrument-like beat. Capping at 6
// means every section/grid settles inside ~6 * --stagger-step regardless of
// how many rows it actually holds.
const MAX_STAGGER = 6;

function card(d: Dataset, index: number): string {
  // Uses the shell's single icon sprite (see index.html's <svg class="icon-sprite">)
  // rather than a text arrow, so this link gets the same glyph, baseline and
  // hover motion as every other external link in the product (footer sources,
  // .ds a .icon in style.css already assumes an <svg class="icon"> is here).
  const link = d.url
    ? `<a href="${d.url}" target="_blank" rel="noreferrer">source <svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-external" /></svg></a>`
    : "";
  // --stagger-i drives the per-card enter animation's animation-delay (see
  // `.grid > .ds` in style.css) — the same "data-driven custom property, set
  // inline" idiom the hero read-out already uses for --channel-color/--share,
  // rather than a one-off inline animation-delay length.
  return `<article class="ds" data-scope="${d.scope}" style="--stagger-i: ${Math.min(index, MAX_STAGGER)}">
    <h3>${label(d)}</h3>
    <p class="meta">${d.scope} · ${d.authority ?? "—"}${d.year ? ` · ${d.year}` : ""}</p>
    ${link}
  </article>`;
}

/** The aria-live copy for the current filter. Empty (no announcement, no
 * visible line) at rest so first paint stays as calm as the ledger stat
 * beside it; as soon as a term is typed it states the match count against
 * the catalogue total, or the same zero-match wording the visual `.empty`
 * fallback below already uses, so a screen-reader user gets the same
 * information a sighted user reads off the card grid. */
function resultsStatus(term: string, matched: number, total: number): string {
  if (term.trim() === "") return "";
  return matched === 0
    ? `No datasets match “${term}”.`
    : `${matched} of ${total} datasets match “${term}”.`;
}

function renderCatalogue(term: string): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  const results = search(term);
  const grouped = byTheme(results);
  const sections = [...grouped.entries()]
    .map(
      ([theme, ds], sectionIndex) => `<section style="--stagger-i: ${Math.min(sectionIndex, MAX_STAGGER)}"><h2>${theme} <span class="count">${ds.length}</span></h2>
      <div class="grid">${ds.map((d, cardIndex) => card(d, cardIndex)).join("")}</div></section>`,
    )
    .join("");
  app.innerHTML = sections || `<p class="empty">No datasets match “${term}”.</p>`;

  // #search-status lives in the masthead, not inside #app, so it is never
  // touched by the innerHTML swap above — only its textContent changes, on
  // every keystroke, which is what makes aria-live announce it.
  const status = document.querySelector<HTMLElement>("#search-status");
  if (status) status.textContent = resultsStatus(term, results.length, catalogue.counts.total);
}

function boot(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  document.querySelector<HTMLElement>("#total")!.textContent = String(catalogue.counts.total);
  const input = document.querySelector<HTMLInputElement>("#search");
  input?.addEventListener("input", () => renderCatalogue(input.value));
  renderCatalogue("");
  subscribe(renderAllMounts);
}

if (typeof document !== "undefined") boot();
