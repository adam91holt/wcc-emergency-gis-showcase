// The hazard overlay console: an interactive Leaflet map of Wellington with
// the catalogue's mappable layers drawn live from their ArcGIS REST services.
//
// Split the same way src/filters.ts is:
//   - pure functions (query-URL construction, the theme colour key, the
//     layers ↔ route-hash mapping) with no `document`/`window`/Leaflet
//     reference at all, so src/map.test.ts exercises them in the node test
//     environment;
//   - DOM + Leaflet work behind a `typeof document === "undefined"` guard,
//     the same way src/main.ts gates boot().
//
// Leaflet itself is *dynamically* imported inside that guard on purpose: its
// ESM entry evaluates `'ActiveXObject' in window` at module top level, so a
// static import would blow up the moment a node test imported this file. Only
// the stylesheet is imported statically (Vite inlines it into the bundle; the
// test environment resolves CSS imports to nothing).
//
// This module deliberately imports nothing from main.ts — see the
// FeatureModule doc there for the import-cycle hazard that would create.
import "leaflet/dist/leaflet.css";
import "./map.css";
import { findById, label, mappableDatasets, type Dataset } from "./catalogue";
import {
  METRES_PER_DEGREE,
  inspectPoint,
  lonScale,
  type InspectLayer,
  type InspectResult,
  type LayerHit,
} from "./inspect";
import { getState, setState, type RouteState } from "./router";
import type {
  CircleMarker,
  GeoJSON as GeoJSONLayer,
  LatLngBoundsExpression,
  LeafletMouseEvent,
  Map as LeafletMap,
  PathOptions,
  Popup,
  PopupEvent,
} from "leaflet";
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from "geojson";

type LeafletModule = typeof import("leaflet");

// ---------------------------------------------------------------------------
// Pure logic — no DOM, no Leaflet
// ---------------------------------------------------------------------------

/** Wellington CBD, framed so the harbour, the south coast and the western
 * hills are all in view at first paint. */
export const WELLINGTON_VIEW = { lat: -41.29, lon: 174.78, zoom: 12 } as const;

/** The hazard colour key. One stable colour per catalogue theme, chosen to
 * stay separable against the dimmed basemap and against each other (water
 * blues → land ambers → seismic red → climate violet → infrastructure lime).
 * This is the token layer for layer colour: the swatch in the toggle panel and
 * the geometry drawn on the map both read from here (the CSS consumes it as
 * `--swatch`), so a layer can never be one colour in the panel and another on
 * the map. The product's own accent (`--accent`, style.css) is untouched by
 * this and stays the single owned UI accent. */
const THEME_COLOURS: Record<string, string> = {
  coastal_inundation: "#4cc9f0",
  sea_level_rise: "#4361ee",
  flood: "#2ec4b6",
  landslide: "#f4a259",
  earthquake: "#ff5d73",
  climate: "#c77dff",
  other: "#a3e635",
};

/** Used for catalogue rows with no theme at all (the national-scope rows). */
const UNTHEMED_COLOUR = "#94a3b8";

/** The stable draw colour for a theme. Unknown/empty/missing themes all get
 * one shared fallback rather than an unpredictable colour. */
export function themeColor(theme: string | null | undefined): string {
  if (!theme) return UNTHEMED_COLOUR;
  return THEME_COLOURS[theme] ?? UNTHEMED_COLOUR;
}

/** The `/query` URL that returns a dataset's features as GeoJSON (rather than
 * layerQueryUrl's Esri JSON), reprojected to WGS84 so Leaflet can draw it
 * without a projection step. Same guard and same
 * `resolved_layer ?? default_child ?? layer_id` fallback order as
 * catalogue.layerQueryUrl — resolved_layer is the upstream-resolved index,
 * default_child is the documented sibling for rows whose own layer is a
 * non-queryable group, and only then the raw layer_id. Returns null for
 * datasets that aren't feature-queryable, have no service, or resolve to no
 * layer index at all. */
export function geoJsonQueryUrl(d: Dataset): string | null {
  if (!d.feature_queryable || !d.service_root) return null;
  const layer = d.resolved_layer ?? d.default_child ?? d.layer_id;
  if (layer == null) return null;
  return `${d.service_root}/${layer}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`;
}

/** How far off a line or point feature a click still counts as "on it",
 * in the latitude degrees src/inspect.ts measures in.
 *
 * The tolerance has to be a *screen* measure converted to ground distance,
 * not a fixed geographic one: an active fault is a hairline at z12 and still
 * a hairline at z18, so what must stay constant is how close the cursor has
 * to get. `pixels` screen pixels → degrees of longitude at this zoom (Web
 * Mercator: 256px tiles spanning 360° at z0) → latitude-equivalent degrees by
 * the same cos(lat) scaling inspect.ts uses. At z12 that is ~230 m, at z17
 * ~7 m. Polygons ignore it entirely — containment stays exact. */
export function toleranceForZoom(
  zoom: number,
  lat: number = WELLINGTON_VIEW.lat,
  pixels = 8,
): number {
  const z = Number.isFinite(zoom) ? Math.min(Math.max(zoom, 0), 22) : WELLINGTON_VIEW.zoom;
  const degreesPerPixel = 360 / (256 * 2 ** z);
  return pixels * degreesPerPixel * lonScale(lat);
}

export interface LayerGroup {
  /** The catalogue `theme` key ("" for the unthemed national rows). */
  theme: string;
  label: string;
  color: string;
  datasets: Dataset[];
}

/** Mappable datasets bucketed for the toggle panel, in catalogue order.
 * Grouped by `theme` rather than `theme_label` on purpose: the catalogue
 * carries both "Flood data" and "Flood Data" for the same `flood` theme, and
 * two near-identical headings in a colour-keyed panel would read as a bug. */
export function layerGroups(list: Dataset[] = mappableDatasets()): LayerGroup[] {
  const groups = new Map<string, LayerGroup>();
  for (const d of list) {
    const theme = d.theme ?? "";
    let group = groups.get(theme);
    if (!group) {
      group = {
        theme,
        label: d.theme_label?.trim() || "Uncategorised",
        color: themeColor(theme),
        datasets: [],
      };
      groups.set(theme, group);
    }
    group.datasets.push(d);
  }
  return [...groups.values()];
}

/** The layer ids from route state that this module can actually draw: hash
 * order preserved, duplicates collapsed, and any id that isn't a mappable
 * dataset (typo, stale link, a raster-only row) dropped rather than throwing. */
export function layersFromRoute(state: RouteState, list: Dataset[] = mappableDatasets()): string[] {
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

/** The router patch for a set of toggled layers. An empty set is written as
 * `undefined` so the key is *removed* from the hash rather than left as an
 * empty `layers=` — see router.mergeHash. */
export function patchForLayers(ids: string[]): Partial<RouteState> {
  return { layers: ids.length > 0 ? ids : undefined };
}

/** Turn one layer on or off within the currently toggled set. Adding appends
 * (so the hash reads in the order the user switched layers on); removing
 * preserves the order of the rest. */
export function toggleLayerId(current: string[], id: string, on: boolean): string[] {
  if (!on) return current.filter((x) => x !== id);
  return current.includes(id) ? [...current] : [...current, id];
}

// ---------------------------------------------------------------------------
// Icon set — same family as src/filters.ts: solid paths on a 16px grid, drawn
// in currentColor. No second icon library, no emoji.
// ---------------------------------------------------------------------------

function svg(path: string, size = 14): string {
  return `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="${path}" fill="currentColor"/></svg>`;
}

const ICON_TARGET = svg(
  "M8 0a1 1 0 0 1 1 1v1.07a6 6 0 0 1 4.93 4.93H15a1 1 0 1 1 0 2h-1.07A6 6 0 0 1 9 13.93V15a1 1 0 1 1-2 0v-1.07A6 6 0 0 1 2.07 9H1a1 1 0 0 1 0-2h1.07A6 6 0 0 1 7 2.07V1a1 1 0 0 1 1-1Zm0 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z",
  13,
);
const ICON_RETRY = svg(
  "M8 2a6 6 0 1 0 5.65 8 1 1 0 1 0-1.88-.67A4 4 0 1 1 8 4a3.96 3.96 0 0 1 2.6.98L9.3 6.29A.7.7 0 0 0 9.8 7.5H13a1 1 0 0 0 1-1V3.3a.7.7 0 0 0-1.2-.5l-.79.79A5.97 5.97 0 0 0 8 2Z",
  12,
);
const ICON_CLEAR = svg(
  "M3.3 3.3a1 1 0 0 1 1.4 0L8 6.6l3.3-3.3a1 1 0 1 1 1.4 1.4L9.4 8l3.3 3.3a1 1 0 0 1-1.4 1.4L8 9.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L6.6 8 3.3 4.7a1 1 0 0 1 0-1.4Z",
  12,
);
const ICON_ALERT = svg(
  "M8 1.5a1.2 1.2 0 0 1 1.04.6l6 10.3A1.2 1.2 0 0 1 14 14.2H2a1.2 1.2 0 0 1-1.04-1.8l6-10.3A1.2 1.2 0 0 1 8 1.5Zm0 3.6a.9.9 0 0 0-.9.97l.25 3a.65.65 0 0 0 1.3 0l.25-3A.9.9 0 0 0 8 5.1Zm0 5.4a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Z",
  12,
);

// ---------------------------------------------------------------------------
// GeoJSON fetching — cached per dataset id, so re-toggling never refetches
// ---------------------------------------------------------------------------

/** An ArcGIS `f=geojson` response: a plain FeatureCollection, plus the
 * server's own "you hit maxRecordCount" flag, which we surface rather than
 * silently pretending we drew everything. */
type HazardCollection = FeatureCollection<Geometry, GeoJsonProperties> & {
  exceededTransferLimit?: boolean;
};

const geoCache = new Map<string, HazardCollection>();
const inflight = new Map<string, Promise<HazardCollection>>();

async function fetchGeoJson(url: string): Promise<HazardCollection> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`service responded ${res.status}`);
  // ArcGIS reports failures as HTTP 200 with an `error` object in the body,
  // so a status check alone is not enough.
  const body = (await res.json()) as HazardCollection & { error?: { message?: string } };
  if (body?.error) throw new Error(body.error.message || "service error");
  if (!body || !Array.isArray(body.features)) throw new Error("no features in response");
  return body;
}

/** Load (and memoise) one dataset's features. Concurrent requests for the same
 * id share a single fetch; a failed load is not cached, so Retry really
 * retries. */
function loadLayer(id: string, url: string): Promise<HazardCollection> {
  const cached = geoCache.get(id);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(id);
  if (existing) return existing;
  const request = fetchGeoJson(url)
    .then((data) => {
      geoCache.set(id, data);
      inflight.delete(id);
      return data;
    })
    .catch((error) => {
      inflight.delete(id);
      throw error;
    });
  inflight.set(id, request);
  return request;
}

// ---------------------------------------------------------------------------
// DOM + Leaflet
// ---------------------------------------------------------------------------

type RowStatus = "off" | "loading" | "live" | "error";

interface LayerRow {
  item: HTMLLIElement;
  input: HTMLInputElement;
  status: HTMLElement;
  focus: HTMLButtonElement;
  retry: HTMLButtonElement;
}

interface MapView {
  root: HTMLElement;
  shell: HTMLElement;
  map: LeafletMap;
  rows: Map<string, LayerRow>;
  count: HTMLElement;
  features: HTMLElement;
  live: HTMLElement;
  clear: HTMLButtonElement;
}

let view: MapView | null = null;
let leaflet: LeafletModule | null = null;
let booting = false;
let pendingState: RouteState | null = null;

/** Drawn layers currently on the map, and the set of ids the route says
 * should be on. The two differ only while a fetch is in flight — which is
 * exactly the window a user can toggle a layer back off in, so every async
 * continuation re-checks `wanted` before touching the map. */
const drawn = new Map<string, GeoJSONLayer>();
const wanted = new Set<string>();
const rowStatus = new Map<string, RowStatus>();

function pathStyle(color: string): PathOptions {
  return { color, weight: 1.6, opacity: 0.95, fillColor: color, fillOpacity: 0.22 };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ---------------------------------------------------------------------------
// Point inspector — "what's here?" for one clicked spot
//
// Rendering only: the geometry test is src/inspect.ts, which never sees the
// DOM. The clicked point is tested against the GeoJSON already in `geoCache`,
// so an inspection costs no request and works offline once layers are drawn.
//
// This popup replaced the per-feature attribute popup that used to be bound
// in onEachFeature. Two popups could not coexist: a click on a polygon fires
// on the feature *and* propagates to the map, so whichever opened last won
// and the other flickered. The inspector is the strictly larger answer — it
// reports every layer covering the point, not just the topmost one — and it
// still carries the matched feature's attributes, so nothing was lost.
// ---------------------------------------------------------------------------

/** Signed decimal degrees as an emergency-services-legible bearing pair. */
function formatCoord(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}°${ns} · ${Math.abs(lon).toFixed(4)}°${ew}`;
}

/** Latitude degrees → the nearest useful ground unit. */
function formatDistance(degrees: number): string {
  const metres = degrees * METRES_PER_DEGREE;
  if (metres < 950) return `${Math.max(1, Math.round(metres))} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Up to `limit` attributes of the matched feature that actually carry a
 * value — the same readout the old per-feature popup gave, now attached to
 * the layer row it belongs to. Values come from the service, so both key and
 * value are escaped. */
function attrChips(feature: Feature<Geometry, GeoJsonProperties> | null, limit = 3): string {
  const entries = Object.entries(feature?.properties ?? {})
    .filter(([, v]) => v !== null && v !== "" && v !== undefined)
    .slice(0, limit);
  if (entries.length === 0) return "";
  return `<span class="hazhit__attrs">${entries
    .map(
      ([k, v]) =>
        `<span class="hazhit__attr"><span class="hazhit__k">${escapeHtml(k)}</span><span class="hazhit__v">${escapeHtml(String(v))}</span></span>`,
    )
    .join("")}</span>`;
}

/** One hit: swatch, layer name, theme, and how it hit — a containing polygon
 * reads "covers", a nearby fault line reads its distance. The row is a button
 * because it does something: hovering lights that layer up on the map,
 * clicking frames the very feature that answered. */
function hitHtml(hit: LayerHit): string {
  const badge =
    hit.mode === "covers"
      ? hit.matches > 1
        ? `${hit.matches}× covers`
        : "covers"
      : `≈ ${formatDistance(hit.distance)}`;
  return `<li class="hazins__item" style="--swatch:${escapeHtml(hit.color)}">
    <button type="button" class="hazhit" data-action="inspect-focus" data-id="${escapeHtml(hit.id)}"
      aria-label="Zoom to the ${escapeHtml(hit.label)} feature at this point">
      <span class="hazhit__key" aria-hidden="true"></span>
      <span class="hazhit__body">
        <span class="hazhit__name">${escapeHtml(hit.label)}</span>
        <span class="hazhit__meta">
          <span class="hazhit__theme">${escapeHtml(hit.theme)}</span>
          <span class="hazhit__mode" data-mode="${hit.mode}">${escapeHtml(badge)}</span>
        </span>
        ${attrChips(hit.feature)}
      </span>
    </button>
  </li>`;
}

/** The whole popup: verdict first (the answer to the question that was
 * asked), then the hits, then one muted line for everything that was checked
 * and came back clear. */
function inspectorHtml(result: InspectResult, lat: number, lon: number): string {
  const total = result.hits.length + result.misses.length;
  const clear = result.hits.length === 0;
  const misses = result.misses.map((m) => m.label).join(", ");
  return `<div class="hazins" data-state="${clear ? "clear" : "hit"}">
    <div class="hazins__head">
      <p class="hazins__label">${ICON_TARGET}<span>Point inspector</span></p>
      <p class="hazins__coord">${escapeHtml(formatCoord(lat, lon))}</p>
    </div>
    <p class="hazins__verdict">${
      clear
        ? "No drawn hazard covers this point"
        : `In <span class="hazins__num">${result.hits.length}</span> of <span class="hazins__num">${total}</span> drawn layer${total === 1 ? "" : "s"}`
    }</p>
    ${clear ? "" : `<ul class="hazins__list">${result.hits.map(hitHtml).join("")}</ul>`}
    ${misses ? `<p class="hazins__misses"><span class="hazins__misses-key">Not in</span> ${escapeHtml(misses)}</p>` : ""}
    ${clear ? `<p class="hazins__nudge">Switch more hazard channels on to widen the check.</p>` : ""}
  </div>`;
}

function setRowStatus(id: string, status: RowStatus, detail?: string): void {
  rowStatus.set(id, status);
  const row = view?.rows.get(id);
  if (!row) return;
  row.item.dataset.status = status;
  // A "live" layer whose service returned zero features (or only
  // null-geometry ones) has no extent to fly to — leaving the button visible
  // then would give a keyboard-reachable control that silently does nothing
  // when clicked, so gate it on the same bounds check focusLayer() uses.
  row.focus.hidden = status !== "live" || layerBounds(id) === null;
  row.retry.hidden = status !== "error";
  const text =
    status === "loading"
      ? "Fetching…"
      : status === "error"
        ? detail || "Unavailable"
        : status === "live"
          ? detail || "Drawn"
          : "Off";
  row.status.textContent = text;
  row.status.title = status === "error" ? `Request failed: ${detail ?? "unknown error"}` : "";
  syncReadout();
}

function featureTotal(): number {
  let total = 0;
  for (const [id, layer] of drawn) {
    if (!wanted.has(id)) continue;
    total += (geoCache.get(id)?.features.length ?? 0) || layer.getLayers().length;
  }
  return total;
}

function syncReadout(): void {
  if (!view) return;
  const live = [...wanted].filter((id) => rowStatus.get(id) === "live").length;
  const loading = [...wanted].filter((id) => rowStatus.get(id) === "loading").length;
  const failed = [...wanted].filter((id) => rowStatus.get(id) === "error").length;
  view.count.textContent = String(wanted.size);
  view.features.textContent = featureTotal().toLocaleString("en-NZ");
  view.clear.hidden = wanted.size === 0;
  view.shell.dataset.busy = String(loading > 0);
  // Drives the plate's idle prompt: an empty basemap should say what to do
  // with it rather than sitting there looking finished.
  view.shell.dataset.layers = String(wanted.size);
  const parts = [`${live} of ${wanted.size} hazard layers drawn`];
  if (loading > 0) parts.push(`${loading} loading`);
  if (failed > 0) parts.push(`${failed} unavailable`);
  view.live.textContent = `${parts.join(", ")}.`;
}

/** Draw one layer, or restore it from cache. Every step re-checks that the
 * layer is still wanted, so a fast off-toggle during a slow fetch never
 * leaves an orphan on the map. */
async function activateLayer(L: LeafletModule, id: string): Promise<void> {
  if (drawn.has(id)) return;
  const dataset = findById(id);
  if (!dataset) return;
  const url = geoJsonQueryUrl(dataset);
  if (!url) {
    setRowStatus(id, "error", "No queryable layer");
    return;
  }
  setRowStatus(id, "loading");
  let data: HazardCollection;
  try {
    data = await loadLayer(id, url);
  } catch (error) {
    if (wanted.has(id)) {
      setRowStatus(id, "error", error instanceof Error ? error.message : "Request failed");
    }
    return;
  }
  if (!wanted.has(id) || !view || drawn.has(id)) return;

  const color = themeColor(dataset.theme);
  const layer = L.geoJSON(data, {
    style: () => pathStyle(color),
    pointToLayer: (_feature, latlng) =>
      L.circleMarker(latlng, { ...pathStyle(color), radius: 5, fillOpacity: 0.6 }),
    onEachFeature: (_feature, featureLayer) => {
      // No per-feature popup: the click answer for this map is the point
      // inspector below, which reports every layer covering the spot rather
      // than only the feature that happened to be on top.
      //
      // Hover is the "before the click" feedback: the feature under the
      // pointer thickens and brightens, then falls back to the layer style.
      // Every child layer here is a Path (polygon/line) or the circleMarker
      // built above, so setStyle is always present.
      const path = featureLayer as CircleMarker;
      featureLayer.on("mouseover", () => path.setStyle({ weight: 3, fillOpacity: 0.42 }));
      featureLayer.on("mouseout", () => path.setStyle(pathStyle(color)));
    },
  });
  layer.addTo(view.map);
  drawn.set(id, layer);
  // Same reason as deactivateLayer: a layer landing mid-inspection would make
  // the open popup's "not in" line wrong.
  closeInspector();

  const count = data.features.length;
  const capped = data.exceededTransferLimit ? " (capped)" : "";
  setRowStatus(id, "live", `${count.toLocaleString("en-NZ")} feature${count === 1 ? "" : "s"}${capped}`);
}

function deactivateLayer(id: string): void {
  const layer = drawn.get(id);
  if (layer && view) view.map.removeLayer(layer);
  drawn.delete(id);
  // An open inspection is an answer about a specific set of layers; once that
  // set changes the answer is stale, so it goes rather than lying.
  closeInspector();
  setRowStatus(id, "off");
}

function layerBounds(id: string): LatLngBoundsExpression | null {
  const layer = drawn.get(id);
  if (!layer) return null;
  const bounds = layer.getBounds();
  return bounds.isValid() ? bounds : null;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Fly the map to a drawn layer's extent — the answer to "I switched on a
 * national layer and see nothing in Wellington". Reduced motion gets the same
 * destination as a straight cut rather than a zero-duration flight. */
function focusLayer(id: string): void {
  const bounds = layerBounds(id);
  if (!bounds || !view) return;
  const padding: [number, number] = [28, 28];
  if (prefersReducedMotion()) view.map.fitBounds(bounds, { padding });
  else view.map.flyToBounds(bounds, { padding, duration: 0.7 });
}

// --- point inspector: map wiring -------------------------------------------

let inspectorPopup: Popup | null = null;
let inspectorMark: CircleMarker | null = null;
let highlighted: string | null = null;
/** The feature that answered for each hit layer in the open popup, so a click
 * on a row can frame *that* extent rather than the whole layer. */
const inspectorFeatures = new Map<string, Feature<Geometry, GeoJsonProperties>>();

/** Light one drawn layer up on the map and dim it back down again — the live
 * link between a row in the popup and the geometry it is talking about. */
function highlightLayer(id: string | null): void {
  if (highlighted === id) return;
  highlighted = id;
  for (const [layerId, layer] of drawn) {
    const color = themeColor(findById(layerId)?.theme);
    layer.setStyle(
      layerId === id ? { ...pathStyle(color), weight: 3.4, opacity: 1, fillOpacity: 0.45 } : pathStyle(color),
    );
  }
}

/** The drawn layers, in the order the user switched them on, paired with the
 * GeoJSON already sitting in the fetch cache. A layer still loading (or one
 * whose service failed) simply isn't inspectable yet. */
function inspectableLayers(): InspectLayer[] {
  const out: InspectLayer[] = [];
  for (const id of wanted) {
    if (!drawn.has(id)) continue;
    const collection = geoCache.get(id);
    const dataset = findById(id);
    if (!collection || !dataset) continue;
    out.push({
      id,
      label: label(dataset),
      theme: dataset.theme_label?.trim() || "Hazard layer",
      color: themeColor(dataset.theme),
      collection,
    });
  }
  return out;
}

function closeInspector(): void {
  const popup = inspectorPopup;
  const mark = inspectorMark;
  inspectorPopup = null;
  inspectorMark = null;
  inspectorFeatures.clear();
  highlightLayer(null);
  if (view && mark) view.map.removeLayer(mark);
  if (view && popup) view.map.closePopup(popup);
}

/** Frame the single feature that answered for a row. Same reduced-motion
 * contract as focusLayer: same destination, no flight. */
function focusFeature(L: LeafletModule, id: string): void {
  const feature = inspectorFeatures.get(id);
  if (!feature || !view) return;
  const bounds = L.geoJSON(feature).getBounds();
  if (!bounds.isValid()) return;
  const padding: [number, number] = [40, 40];
  if (prefersReducedMotion()) view.map.fitBounds(bounds, { padding, maxZoom: 16 });
  else view.map.flyToBounds(bounds, { padding, maxZoom: 16, duration: 0.7 });
}

/** Hover/focus a row → that layer lights up on the map; activate it → the map
 * flies to the feature that answered. Leaflet already stops click propagation
 * inside a popup, so none of this re-triggers the map's own click handler. */
function wirePopupContent(L: LeafletModule, popup: Popup): void {
  const element = popup.getElement();
  if (!element) return;
  const rowId = (target: EventTarget | null): string | null =>
    (target instanceof HTMLElement ? target.closest<HTMLElement>(".hazhit")?.dataset.id : null) ?? null;
  element.addEventListener("mouseover", (event) => highlightLayer(rowId(event.target)));
  element.addEventListener("mouseleave", () => highlightLayer(null));
  element.addEventListener("focusin", (event) => highlightLayer(rowId(event.target)));
  element.addEventListener("focusout", () => highlightLayer(null));
  element.addEventListener("click", (event) => {
    const id = rowId(event.target);
    if (id) focusFeature(L, id);
  });
}

/** Test the clicked point against every drawn layer and answer in one popup.
 * With nothing drawn there is nothing to answer with, so the click is a
 * no-op rather than an empty popup. */
function inspectAt(L: LeafletModule, map: LeafletMap, event: LeafletMouseEvent): void {
  const layers = inspectableLayers();
  if (layers.length === 0) return;
  const { lat, lng } = event.latlng;
  const result = inspectPoint([lng, lat], layers, toleranceForZoom(map.getZoom(), lat));

  closeInspector();
  for (const hit of result.hits) {
    if (hit.feature) inspectorFeatures.set(hit.id, hit.feature);
  }
  // The tested spot stays marked while the popup is up — the answer is about
  // this point, not roughly around here.
  inspectorMark = L.circleMarker([lat, lng], {
    radius: 6,
    weight: 2,
    className: "hazins-mark",
    interactive: false,
  }).addTo(map);
  inspectorPopup = L.popup({
    className: "hazins-wrap",
    maxWidth: 300,
    minWidth: 232,
    autoPanPadding: [24, 24],
  })
    .setLatLng(event.latlng)
    .setContent(inspectorHtml(result, lat, lng))
    .openOn(map);
  wirePopupContent(L, inspectorPopup);
}

function wireInspector(L: LeafletModule, map: LeafletMap): void {
  map.on("click", (event) => inspectAt(L, map, event as LeafletMouseEvent));
  // Closing by the ✕, by Escape, or by the next click all land here; the
  // identity check keeps a popup we have already replaced from clearing the
  // new one's marker.
  map.on("popupclose", (event) => {
    if ((event as PopupEvent).popup === inspectorPopup) closeInspector();
  });
}

// --- route ↔ panel sync ----------------------------------------------------

function currentLayerIds(): string[] {
  return layersFromRoute(getState());
}

/** Write a toggle back to the URL — the panel keeps no state of its own, it
 * re-renders from whatever the router says next. `push` for the first layer
 * (so Back returns to the empty map), `replace` for every toggle after that,
 * so building up a five-layer view doesn't need five presses of Back to
 * escape. */
function commitToggle(id: string, on: boolean): void {
  const current = currentLayerIds();
  setState(patchForLayers(toggleLayerId(current, id, on)), { replace: current.length > 0 });
}

function syncView(L: LeafletModule, state: RouteState): void {
  if (!view) return;
  const ids = layersFromRoute(state);
  const next = new Set(ids);

  for (const id of [...wanted]) {
    if (!next.has(id)) {
      wanted.delete(id);
      deactivateLayer(id);
    }
  }
  for (const id of ids) {
    if (!wanted.has(id)) {
      wanted.add(id);
      void activateLayer(L, id);
    }
  }
  for (const [id, row] of view.rows) {
    const on = next.has(id);
    if (row.input.checked !== on) row.input.checked = on;
    if (!rowStatus.has(id)) setRowStatus(id, "off");
  }
  syncReadout();
}

// --- markup ----------------------------------------------------------------

/** Skeleton shapes that match the real console's geometry — a map plate and
 * the grouped toggle rows that replace them — so the first frame is never a
 * spinner or a blank mount. Leaflet is a dynamic import, so on a cold cache
 * this is genuinely what the visitor looks at while it lands. */
function paintSkeleton(root: HTMLElement): void {
  const groups = layerGroups();
  root.innerHTML = `
    <section class="hazmap is-loading" aria-busy="true">
      <div class="hazmap__head">
        <div class="hazmap__ident">
          <p class="hazmap__label">Hazard overlay</p>
          <p class="hazmap__hint">Loading map engine…</p>
        </div>
        <span class="hazskel hazskel--readout" aria-hidden="true"></span>
      </div>
      <div class="hazmap__body">
        <div class="hazmap__plate hazskel hazskel--plate" aria-hidden="true"></div>
        <div class="hazmap__panel">
          ${groups
            .map(
              (g) => `<div class="hazgroup" style="--swatch:${g.color}">
                <p class="hazgroup__label"><span class="hazgroup__key" aria-hidden="true"></span>${escapeHtml(g.label)}</p>
                ${g.datasets
                  .map(() => `<span class="hazskel hazskel--row" aria-hidden="true"></span>`)
                  .join("")}
              </div>`,
            )
            .join("")}
        </div>
      </div>
      <p class="sr-only">Loading the hazard map…</p>
    </section>`;
}

function buildMarkup(root: HTMLElement): void {
  const groups = layerGroups();
  const total = groups.reduce((n, g) => n + g.datasets.length, 0);
  root.innerHTML = `
    <section class="hazmap" data-busy="false" data-layers="0">
      <div class="hazmap__head">
        <div class="hazmap__ident">
          <p class="hazmap__label">Hazard overlay</p>
          <p class="hazmap__hint">Switch layers on to draw them live from their ArcGIS service · click anywhere on the map to see what covers that point</p>
        </div>
        <p class="hazmap__readout" aria-hidden="true">
          <span class="hazmap__count">0</span>
          <span class="hazmap__total">/ ${total}</span>
          <span class="hazmap__unit">layers</span>
          <span class="hazmap__sep"></span>
          <span class="hazmap__features">0</span>
          <span class="hazmap__unit">features</span>
        </p>
        <button type="button" class="hazmap__clear" data-action="clear-layers" hidden>
          ${ICON_CLEAR}<span>Clear layers</span>
        </button>
      </div>
      <div class="hazmap__body">
        <div class="hazmap__plate">
          <div class="hazmap__canvas" role="application" aria-label="Wellington hazard map"></div>
          <p class="hazmap__idle" aria-hidden="true">No layers live — switch a hazard channel on to draw it</p>
          <p class="hazmap__scroll-hint" aria-hidden="true">Click the map to zoom with the wheel</p>
        </div>
        <div class="hazmap__panel">
          ${groups
            .map(
              (g) => `<div class="hazgroup" role="group" aria-label="${escapeHtml(g.label)} layers" style="--swatch:${g.color}">
                <p class="hazgroup__label"><span class="hazgroup__key" aria-hidden="true"></span>${escapeHtml(g.label)}<span class="hazgroup__count">${g.datasets.length}</span></p>
                <ul class="hazgroup__list">
                  ${g.datasets
                    .map(
                      (d, i) => `<li class="hazlayer" data-id="${escapeHtml(d.id)}" data-status="off" style="--i:${Math.min(i, 8)}">
                        <input class="hazlayer__input" type="checkbox" id="hazlayer-${escapeHtml(d.id)}" />
                        <label class="hazlayer__label" for="hazlayer-${escapeHtml(d.id)}">
                          <span class="hazlayer__swatch" aria-hidden="true"></span>
                          <span class="hazlayer__name">${escapeHtml(label(d))}</span>
                        </label>
                        <span class="hazlayer__status">Off</span>
                        <button type="button" class="hazlayer__act" data-action="focus-layer" aria-label="Zoom to ${escapeHtml(label(d))}" hidden>${ICON_TARGET}</button>
                        <button type="button" class="hazlayer__act hazlayer__act--retry" data-action="retry-layer" aria-label="Retry ${escapeHtml(label(d))}" hidden>${ICON_RETRY}</button>
                      </li>`,
                    )
                    .join("")}
                </ul>
              </div>`,
            )
            .join("")}
          <p class="hazmap__credit">${ICON_ALERT}<span>Layers are fetched straight from the councils' live ArcGIS services — some may be slow or briefly unavailable.</span></p>
        </div>
      </div>
      <p class="sr-only" role="status" aria-live="polite"></p>
    </section>`;
}

function collectRows(root: HTMLElement): Map<string, LayerRow> {
  const rows = new Map<string, LayerRow>();
  for (const item of root.querySelectorAll<HTMLLIElement>(".hazlayer")) {
    const id = item.dataset.id;
    if (!id) continue;
    rows.set(id, {
      item,
      input: item.querySelector<HTMLInputElement>(".hazlayer__input")!,
      status: item.querySelector<HTMLElement>(".hazlayer__status")!,
      focus: item.querySelector<HTMLButtonElement>('[data-action="focus-layer"]')!,
      retry: item.querySelector<HTMLButtonElement>('[data-action="retry-layer"]')!,
    });
  }
  return rows;
}

function wirePanel(L: LeafletModule, root: HTMLElement): void {
  root.addEventListener("change", (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>(".hazlayer__input");
    const id = input?.closest<HTMLElement>(".hazlayer")?.dataset.id;
    if (!input || !id) return;
    commitToggle(id, input.checked);
  });
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!button) return;
    const id = button.closest<HTMLElement>(".hazlayer")?.dataset.id;
    const action = button.dataset.action;
    if (action === "focus-layer" && id) focusLayer(id);
    else if (action === "retry-layer" && id) {
      geoCache.delete(id);
      setRowStatus(id, "off");
      void activateLayer(L, id);
    } else if (action === "clear-layers") {
      setState(patchForLayers([]));
    }
  });
}

function createMap(L: LeafletModule, canvas: HTMLElement): LeafletMap {
  const map = L.map(canvas, {
    center: [WELLINGTON_VIEW.lat, WELLINGTON_VIEW.lon],
    zoom: WELLINGTON_VIEW.zoom,
    // The map sits mid-page, so a stray wheel gesture must not swallow the
    // page scroll — the wheel is armed only once the map is clicked/focused.
    scrollWheelZoom: false,
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const plate = canvas.closest<HTMLElement>(".hazmap__plate");
  const arm = (): void => {
    map.scrollWheelZoom.enable();
    plate?.setAttribute("data-armed", "true");
  };
  const disarm = (): void => {
    map.scrollWheelZoom.disable();
    plate?.setAttribute("data-armed", "false");
  };
  map.on("click focus", arm);
  map.on("blur", disarm);
  canvas.addEventListener("mouseleave", disarm);
  wireInspector(L, map);
  return map;
}

/** The FeatureModule registered against `#map-root` in src/main.ts. Called
 * once at boot and again on every route change: the first call paints the
 * skeleton and loads Leaflet, every later call just syncs the panel and the
 * drawn layers against the hash. */
export default function renderMap(root: HTMLElement, state: RouteState): void {
  if (typeof document === "undefined") return;
  pendingState = state;
  if (view && view.root === root && leaflet) {
    syncView(leaflet, state);
    return;
  }
  if (view && view.root !== root) {
    // Re-mounting into a different root (HMR, or any future re-init) — the
    // previous root's DOM (and the Leaflet map bound to it) is gone or about
    // to be replaced, so tear down the module singletons that reference it.
    // Without this, the old L.map() is never .remove()d (it keeps its tile
    // requests and window listeners alive), and `wanted`/`rowStatus` would
    // still list the old mount's layers as already active — syncView()'s
    // `if (!wanted.has(id))` guard would then skip activateLayer() entirely
    // for the new mount, leaving its map empty while the panel claims those
    // layers are live.
    view.map.remove();
    view = null;
    drawn.clear();
    wanted.clear();
    rowStatus.clear();
    inspectorPopup = null;
    inspectorMark = null;
    inspectorFeatures.clear();
    highlighted = null;
  }
  if (booting) return;
  booting = true;
  paintSkeleton(root);
  void import("leaflet")
    .then((L) => {
      leaflet = L;
      buildMarkup(root);
      const canvas = root.querySelector<HTMLElement>(".hazmap__canvas")!;
      view = {
        root,
        shell: root.querySelector<HTMLElement>(".hazmap")!,
        map: createMap(L, canvas),
        rows: collectRows(root),
        count: root.querySelector<HTMLElement>(".hazmap__count")!,
        features: root.querySelector<HTMLElement>(".hazmap__features")!,
        live: root.querySelector<HTMLElement>(".sr-only")!,
        clear: root.querySelector<HTMLButtonElement>(".hazmap__clear")!,
      };
      wirePanel(L, root);
      booting = false;
      syncView(L, pendingState ?? getState());
    })
    .catch(() => {
      booting = false;
      root.innerHTML = `<section class="hazmap hazmap--dead">
        <p class="hazmap__label">Hazard overlay</p>
        <p class="hazmap__deadtext">The map engine could not be loaded. The dataset catalogue below is unaffected.</p>
      </section>`;
    });
}
