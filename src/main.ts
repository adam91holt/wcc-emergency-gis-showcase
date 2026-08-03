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

function card(d: Dataset): string {
  // Uses the shell's single icon sprite (see index.html's <svg class="icon-sprite">)
  // rather than a text arrow, so this link gets the same glyph, baseline and
  // hover motion as every other external link in the product (footer sources,
  // .ds a .icon in style.css already assumes an <svg class="icon"> is here).
  const link = d.url
    ? `<a href="${d.url}" target="_blank" rel="noreferrer">source <svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-external" /></svg></a>`
    : "";
  return `<article class="ds" data-scope="${d.scope}">
    <h3>${label(d)}</h3>
    <p class="meta">${d.scope} · ${d.authority ?? "—"}${d.year ? ` · ${d.year}` : ""}</p>
    ${link}
  </article>`;
}

function renderCatalogue(term: string): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  const grouped = byTheme(search(term));
  const sections = [...grouped.entries()]
    .map(([theme, ds]) => `<section><h2>${theme} <span class="count">${ds.length}</span></h2>
      <div class="grid">${ds.map(card).join("")}</div></section>`)
    .join("");
  app.innerHTML = sections || `<p class="empty">No datasets match “${term}”.</p>`;
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
