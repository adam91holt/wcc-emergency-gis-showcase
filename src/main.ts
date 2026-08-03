// Thin bootstrap: renders the existing theme-grouped catalogue card list,
// initialises the router, and exposes a mount registry so later feature
// tickets (map/detail/charts/filters) attach a module in a few lines rather
// than editing this file. This is still a SEED for the card list itself —
// the factory grows the four named mounts from here.
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
 * re-invoked whenever route state changes. */
export type FeatureModule = (root: HTMLElement, state: RouteState) => void;

const registry = new Map<MountId, FeatureModule>();

/** Register a feature module against a named mount point. Call this once
 * from the feature's own file — no edits to main.ts required. Renders
 * immediately with the current route state, then again on every route change. */
export function registerMount(id: MountId, mod: FeatureModule): void {
  registry.set(id, mod);
  renderMount(id, getState());
}

function renderMount(id: MountId, state: RouteState): void {
  const root = document.querySelector<HTMLElement>(MOUNT_SELECTORS[id]);
  const mod = registry.get(id);
  if (root && mod) mod(root, state);
}

function renderAllMounts(state: RouteState): void {
  for (const id of registry.keys()) renderMount(id, state);
}

function card(d: Dataset): string {
  const link = d.url ? `<a href="${d.url}" target="_blank" rel="noreferrer">source ↗</a>` : "";
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
