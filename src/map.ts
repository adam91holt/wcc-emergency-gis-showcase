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
  type LonLat,
} from "./inspect";
import { getState, setState, type RouteState } from "./router";
import type {
  CircleMarker,
  GeoJSON as GeoJSONLayer,
  LatLng,
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
  /** Rolling status of the rack (how many layers are drawn / loading). */
  live: HTMLElement;
  /** The inspector's verdict. Kept separate from `live` because syncReadout
   * rewrites that one on every layer status change, which would stamp over an
   * answer the moment a layer finished loading. */
  say: HTMLElement;
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

/** How hard a feature is drawn: its resting state, under the pointer, or lit
 * up because a row in the inspector popup is pointing at it. */
export type StyleEmphasis = "base" | "hover" | "highlight";

const STROKE_WEIGHT: Record<StyleEmphasis, number> = { base: 1.6, hover: 3, highlight: 3.4 };

/** Fill opacity is per *geometry kind*, not per layer: an extent polygon has
 * to stay translucent enough to read the two extents under it, but a point
 * dataset is a 5px disc — at 0.22 it is a smudge, and a point dataset that
 * cannot be seen cannot be clicked, which would quietly cost the inspector
 * half the datasets the ticket makes inspectable. */
const FILL_OPACITY: Record<StyleEmphasis, { point: number; area: number }> = {
  base: { point: 0.62, area: 0.22 },
  hover: { point: 0.82, area: 0.42 },
  highlight: { point: 0.88, area: 0.45 },
};

/** The draw style for one feature of a drawn layer. Everything that restyles
 * geometry — the initial draw, the pointer hover, the inspector's highlight —
 * goes through here, because Leaflet's `setStyle` merges a *flat* options
 * object into every child of a GeoJSON group: restyling with a single
 * polygon-shaped object silently repaints circle markers at polygon opacity
 * and never puts them back. */
export function layerStyle(
  color: string,
  feature?: Feature<Geometry, GeoJsonProperties> | null,
  emphasis: StyleEmphasis = "base",
): PathOptions {
  const type = feature?.geometry?.type;
  const point = type === "Point" || type === "MultiPoint";
  return {
    color,
    weight: STROKE_WEIGHT[emphasis],
    opacity: emphasis === "base" ? 0.95 : 1,
    fillColor: color,
    fillOpacity: point ? FILL_OPACITY[emphasis].point : FILL_OPACITY[emphasis].area,
  };
}

/** Both quote forms are escaped, not just the double: every attribute this
 * module writes is double-quoted today, but a single-quoted one added later
 * must not silently become an injection point for service-supplied text. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
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
 * value — the same six-attribute readout the old per-feature popup gave, now
 * attached to the layer row it belongs to. Values come from the service, so
 * both key and value are escaped. */
function attrChips(feature: Feature<Geometry, GeoJsonProperties> | null, limit = 6): string {
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
  // No aria-label on the button: it would *replace* the name computed from
  // the row's contents, which is exactly the readout — theme, how it hit, and
  // the matched feature's attributes — that a screen reader is here for. The
  // action is appended as visually-hidden text instead, so the row announces
  // what it says and then what it does.
  return `<li class="hazins__item" style="--swatch:${escapeHtml(hit.color)}">
    <button type="button" class="hazhit" data-action="inspect-focus" data-id="${escapeHtml(hit.id)}">
      <span class="hazhit__key" aria-hidden="true"></span>
      <span class="hazhit__body">
        <span class="hazhit__name">${escapeHtml(hit.label)}</span>
        <span class="hazhit__meta">
          <span class="hazhit__theme">${escapeHtml(hit.theme)}</span>
          <span class="hazhit__mode" data-mode="${hit.mode}">${escapeHtml(badge)}</span>
        </span>
        ${attrChips(hit.feature)}
        <span class="sr-only">Zoom to this feature</span>
      </span>
    </button>
  </li>`;
}

/** A layer the user switched on that the inspector could *not* test, because
 * its GeoJSON is still in flight or its service failed. Reported rather than
 * dropped: "no hazard covers this point" is a dangerous thing to say about a
 * channel that was never checked. */
export interface UncheckedLayer {
  label: string;
  /** Why it wasn't checked — "still loading" or "unavailable". */
  note: string;
}

/** The whole popup: verdict first (the answer to the question that was
 * asked), then the hits, then one muted line for everything that was checked
 * and came back clear, then — only when there is one — the caveat naming the
 * channels that could not be checked at all. Pure string-building, so
 * src/inspect.test.ts can assert both the wording and — since feature
 * attributes come straight off a council's ArcGIS service — that nothing
 * reaches the popup unescaped. */
export function inspectorHtml(
  result: InspectResult,
  lat: number,
  lon: number,
  unchecked: readonly UncheckedLayer[] = [],
): string {
  const total = result.hits.length + result.misses.length;
  const clear = result.hits.length === 0;
  const misses = result.misses.map((m) => m.label).join(", ");
  const pending = unchecked.map((u) => `${u.label} (${u.note})`).join(", ");
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
    ${pending ? `<p class="hazins__pending">${ICON_ALERT}<span><span class="hazins__pending-key">Not checked</span> ${escapeHtml(pending)}</span></p>` : ""}
    ${clear && !pending ? `<p class="hazins__nudge">Switch more hazard channels on to widen the check.</p>` : ""}
  </div>`;
}

/** The same answer as one spoken sentence. A Leaflet popup is a visual answer
 * only — it takes no focus and carries no live-region role (see its
 * `_initLayout`), so without this the whole feature is silent to a screen
 * reader. Pure, so src/inspect.test.ts can assert the wording. */
export function inspectionSummary(
  result: InspectResult,
  unchecked: readonly UncheckedLayer[] = [],
): string {
  const total = result.hits.length + result.misses.length;
  const layers = `${total} drawn layer${total === 1 ? "" : "s"}`;
  // The caveat is spoken too — an all-clear that quietly skipped a channel is
  // the one thing this readout must never imply.
  const caveat = unchecked.length
    ? ` ${unchecked.length} not checked: ${unchecked.map((u) => `${u.label}, ${u.note}`).join("; ")}.`
    : "";
  if (result.hits.length === 0) {
    return `No drawn hazard covers this point. Checked ${layers}.${caveat}`;
  }
  const names = result.hits
    .map((h) => (h.mode === "covers" ? h.label : `${h.label}, nearby`))
    .join("; ");
  return `This point is in ${result.hits.length} of ${layers}: ${names}.${caveat}`;
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
    refreshInspector();
    return;
  }
  setRowStatus(id, "loading");
  // An open inspection has to admit, straight away, that a channel it cannot
  // read yet is now in play — see drawnLayerSets.
  refreshInspector();
  let data: HazardCollection;
  try {
    data = await loadLayer(id, url);
  } catch (error) {
    if (wanted.has(id)) {
      setRowStatus(id, "error", error instanceof Error ? error.message : "Request failed");
      // "Still loading" has just become "unavailable"; the open answer says so.
      refreshInspector();
    }
    return;
  }
  if (!wanted.has(id) || !view || drawn.has(id)) return;

  const color = themeColor(dataset.theme);
  const layer = L.geoJSON(data, {
    style: (feature) => layerStyle(color, feature),
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, { ...layerStyle(color, feature), radius: 5 }),
    onEachFeature: (feature, featureLayer) => {
      // No per-feature popup: the click answer for this map is the point
      // inspector below, which reports every layer covering the spot rather
      // than only the feature that happened to be on top.
      //
      // Hover is the "before the click" feedback: the feature under the
      // pointer thickens and brightens, then falls back to the layer style.
      // Every child layer here is a Path (polygon/line) or the circleMarker
      // built above, so setStyle is always present.
      const path = featureLayer as CircleMarker;
      featureLayer.on("mouseover", () => path.setStyle(layerStyle(color, feature, "hover")));
      featureLayer.on("mouseout", () =>
        path.setStyle(layerStyle(color, feature, highlighted === id ? "highlight" : "base")),
      );
    },
  });
  layer.addTo(view.map);
  drawn.set(id, layer);
  // A layer landing mid-inspection would make the open popup's "not in" line
  // wrong — but the fix for that is to re-answer, not to snatch the popup
  // away from someone reading it. refreshInspector() re-runs the same
  // inspection against the now-larger layer set and updates the open popup's
  // content in place; if nothing is open it is a no-op.
  refreshInspector();

  const count = data.features.length;
  const capped = data.exceededTransferLimit ? " (capped)" : "";
  setRowStatus(id, "live", `${count.toLocaleString("en-NZ")} feature${count === 1 ? "" : "s"}${capped}`);
}

function deactivateLayer(id: string): void {
  const layer = drawn.get(id);
  if (layer && view) view.map.removeLayer(layer);
  drawn.delete(id);
  // A layer switched off while the popup was pointing at it takes the
  // highlight with it — otherwise `highlighted` still names a layer that is
  // no longer on the map, and highlightLayer's identity check would skip the
  // restyle if it were ever drawn and hovered again.
  if (highlighted === id) highlighted = null;
  // An open inspection is an answer about a specific set of layers; once that
  // set changes the answer is stale. refreshInspector() re-answers against
  // the smaller set in place, and closes the popup itself if nothing is left
  // to check.
  refreshInspector();
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
/** The clicked point behind the open popup, in GeoJSON `[lon, lat]` order —
 * kept so a layer arriving or leaving can re-run the same inspection rather
 * than only being able to close the popup. `null` whenever no popup is open. */
let inspectorPoint: LonLat | null = null;
/** The markup currently in the open popup, so a re-answer that lands on the
 * same words leaves the popup's DOM (and anyone's focus in it) alone. */
let inspectorMarkup = "";
let announceTimer: ReturnType<typeof setTimeout> | undefined;
/** The feature that answered for each hit layer in the open popup, so a click
 * on a row can frame *that* extent rather than the whole layer. */
const inspectorFeatures = new Map<string, Feature<Geometry, GeoJsonProperties>>();

/** Light one drawn layer up on the map and dim it back down again — the live
 * link between a row in the popup and the geometry it is talking about. */
function highlightLayer(id: string | null): void {
  if (highlighted === id) return;
  const previous = highlighted;
  highlighted = id;
  // Only the two layers whose emphasis actually changed are restyled: a
  // GeoJSON setStyle writes ~8 attributes per child path, and a drawn ArcGIS
  // layer can hold a couple of thousand of them, so repainting every layer on
  // every row-to-row pointer move would stutter the whole map.
  for (const layerId of [previous, id]) {
    if (!layerId) continue;
    const layer = drawn.get(layerId);
    if (!layer) continue;
    const color = themeColor(findById(layerId)?.theme);
    const emphasis: StyleEmphasis = layerId === id ? "highlight" : "base";
    // A style *function* rather than an object: Leaflet hands it each child's
    // feature, so points keep their heavier fill through the restyle.
    layer.setStyle((feature) => layerStyle(color, feature, emphasis));
  }
}

/** Everything the user has switched on, split into what the inspector can
 * actually test and what it cannot. A layer still fetching, or one whose
 * service failed, holds no GeoJSON — and a hazard channel that was never
 * tested must be *named* in the answer, not dropped from it: "no drawn hazard
 * covers this point" would otherwise read as an all-clear for a fault layer
 * that never loaded. */
function drawnLayerSets(): { inspectable: InspectLayer[]; unchecked: UncheckedLayer[] } {
  const inspectable: InspectLayer[] = [];
  const unchecked: UncheckedLayer[] = [];
  for (const id of wanted) {
    const dataset = findById(id);
    if (!dataset) continue;
    const collection = drawn.has(id) ? geoCache.get(id) : undefined;
    if (!collection) {
      unchecked.push({
        label: label(dataset),
        note: rowStatus.get(id) === "error" ? "unavailable" : "still loading",
      });
      continue;
    }
    inspectable.push({
      id,
      label: label(dataset),
      theme: dataset.theme_label?.trim() || "Hazard layer",
      color: themeColor(dataset.theme),
      collection,
    });
  }
  return { inspectable, unchecked };
}

/** Drop the inspector's own state — the mark, the highlight, the spoken
 * answer — without touching the popup's lifecycle. This is what a
 * `popupclose` handler must call: Leaflet has not yet finished removing the
 * popup layer at that point (`Map.removeLayer` fires `onRemove`, and only
 * *then* deletes the layer from its registry), so calling `map.closePopup()`
 * again from inside this handler would re-enter `Popup.onRemove` and fire a
 * second `popupclose`/`remove` for the one user action that started it. */
function clearInspectorState(): void {
  const mark = inspectorMark;
  inspectorPopup = null;
  inspectorMark = null;
  inspectorPoint = null;
  inspectorMarkup = "";
  inspectorFeatures.clear();
  highlightLayer(null);
  if (announceTimer !== undefined) {
    clearTimeout(announceTimer);
    announceTimer = undefined;
  }
  if (view) view.say.textContent = "";
  if (view && mark) view.map.removeLayer(mark);
}

/** Speak one verdict into the map's status region. The blank and the fill are
 * deliberately in *separate* tasks: assistive tech diffs a live region once
 * per task, so clearing and re-filling it in the same one is no change at all
 * — and two clicks with the same verdict would then be announced only once.
 * The clear happens synchronously so a stale answer is never left standing
 * while the new one is pending. */
function announce(message: string): void {
  if (!view) return;
  const node = view.say;
  node.textContent = "";
  if (announceTimer !== undefined) clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    announceTimer = undefined;
    node.textContent = message;
  }, 60);
}

/** Actively close the open inspection — a new layer landed, a layer left, or
 * a fresh click is about to replace it. Leaflet's own close paths (the ✕
 * button, Escape, `autoClose` on the next popup) never call this: they close
 * the popup themselves and land on the `popupclose` handler below, which
 * only clears state. */
function closeInspector(): void {
  const popup = inspectorPopup;
  clearInspectorState();
  if (view && popup) view.map.closePopup(popup);
}

/** Re-answer the open inspection against the current layer set and update its
 * popup in place — called whenever a layer is drawn or removed while a popup
 * is open, so an unrelated fetch landing does not snatch away the answer
 * someone is mid-read of. A no-op when no popup is open. Closes the popup
 * outright once nothing is left to check, matching inspectAt's own
 * nothing-drawn no-op. */
function refreshInspector(): void {
  if (!inspectorPopup || !inspectorPoint || !view) return;
  const { inspectable, unchecked } = drawnLayerSets();
  if (inspectable.length === 0) {
    closeInspector();
    return;
  }
  const [lon, lat] = inspectorPoint;
  const result = inspectPoint(inspectorPoint, inspectable, toleranceForZoom(view.map.getZoom(), lat));
  inspectorFeatures.clear();
  for (const hit of result.hits) {
    if (hit.feature) inspectorFeatures.set(hit.id, hit.feature);
  }
  const html = inspectorHtml(result, lat, lon, unchecked);
  // Only rewrite when the answer actually changed: setContent rebuilds the
  // popup's DOM, which replays the entrance animation and drops the focus of
  // anyone keyboarding through the hit rows.
  if (html !== inspectorMarkup) {
    inspectorMarkup = html;
    // The row the pointer (or focus) was on is destroyed by this rewrite, and
    // neither `mouseleave` nor — in Chromium, for a removed focused element —
    // `focusout` reliably fires for it. Drop the highlight explicitly, or a
    // layer stays lit up on the map with nothing pointing at it.
    highlightLayer(null);
    inspectorPopup.setContent(html);
    announce(inspectionSummary(result, unchecked));
  }
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

/** Test one point against every drawn layer and answer in a single popup —
 * `at` is the clicked latlng, or the view centre when the inspection came
 * from the keyboard. With nothing drawn there is nothing to answer with, so
 * it is a no-op rather than an empty popup. */
function inspectAt(L: LeafletModule, map: LeafletMap, at: LatLng): void {
  const { inspectable, unchecked } = drawnLayerSets();
  // Nothing drawn yet — including the case where every switched-on layer is
  // still in flight — leaves the click a no-op rather than opening a popup
  // with no answer in it. Once the first layer lands, refreshInspector() is
  // not involved either: there is no popup to refresh.
  if (inspectable.length === 0) return;
  const { lat, lng } = at;
  // Leaflet's continuous world scroll lets a longitude drift past ±180 the
  // moment the user pans to a wrapped copy of the map; every dataset's
  // GeoJSON is normalised to -180..180, so the geometry test (and the
  // coordinate printed in the popup) run on the wrapped point. The mark and
  // the popup itself stay at the *literal* latlng, so they still land exactly
  // under the cursor even when that click was on a wrapped copy of the world.
  const wrapped = at.wrap();
  const result = inspectPoint(
    [wrapped.lng, wrapped.lat],
    inspectable,
    toleranceForZoom(map.getZoom(), wrapped.lat),
  );

  closeInspector();
  inspectorPoint = [wrapped.lng, wrapped.lat];
  inspectorMarkup = inspectorHtml(result, wrapped.lat, wrapped.lng, unchecked);
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
    maxHeight: Math.max(160, map.getSize().y - 96),
    autoPanPadding: [24, 24],
  })
    .setLatLng(at)
    .setContent(inspectorMarkup)
    .openOn(map);
  wirePopupContent(L, inspectorPopup);
  announce(inspectionSummary(result, unchecked));
}

function wireInspector(L: LeafletModule, map: LeafletMap): void {
  map.on("click", (event) => inspectAt(L, map, (event as LeafletMouseEvent).latlng));
  // Keyboard parity: Leaflet's own keyboard handler pans and zooms the focused
  // map but never synthesises a click, so without this the whole inspector
  // would be pointer-only. Enter inspects the centre of the current view —
  // the spot the arrow keys just drove to — and the mark shows exactly which
  // point was tested. Keys pressed inside the popup belong to its own buttons.
  map.on("keydown", (event) => {
    const original = (event as unknown as { originalEvent: KeyboardEvent }).originalEvent;
    if (original.key !== "Enter" || original.altKey || original.ctrlKey || original.metaKey) return;
    if (original.target !== map.getContainer()) return;
    original.preventDefault();
    inspectAt(L, map, map.getCenter());
  });
  // Closing by the ✕, by Escape, or by the next click's autoClose all land
  // here *while Leaflet is still tearing the popup down* — only clear our
  // own state, never call back into map.closePopup (see clearInspectorState).
  // The identity check keeps a popup we have already replaced from clearing
  // the new one's marker.
  map.on("popupclose", (event) => {
    if ((event as PopupEvent).popup === inspectorPopup) clearInspectorState();
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
          <p class="hazmap__hint">Switch layers on to draw them live from their ArcGIS service · click anywhere on the map — or focus it and press Enter — to see what covers that point</p>
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
      <p class="sr-only hazmap__live" role="status" aria-live="polite"></p>
      <p class="sr-only hazmap__say" role="status" aria-live="polite"></p>
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
    inspectorPoint = null;
    inspectorMarkup = "";
    inspectorFeatures.clear();
    highlighted = null;
    // A verdict queued for the old mount's status region must not land in the
    // new one's — the popup it described is gone with the old map.
    if (announceTimer !== undefined) {
      clearTimeout(announceTimer);
      announceTimer = undefined;
    }
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
        live: root.querySelector<HTMLElement>(".hazmap__live")!,
        say: root.querySelector<HTMLElement>(".hazmap__say")!,
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
