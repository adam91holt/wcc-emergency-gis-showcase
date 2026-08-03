// The situation map: an interactive Wellington hazard map whose overlays are
// *derived from the catalogue*, not hand-listed. Every ArcGIS REST row in
// data/catalogue.json is classified into one of three kinds — a vector feature
// layer, a server-rendered image layer, or link-only — and the first two
// become channels in the overlay rack next to the map.
//
// Split the same way src/filters.ts is:
//   - pure functions (classification, service-URL building, grouping, route
//     encoding, popup content) with no `document`/`window`/`fetch` reference,
//     so src/map.test.ts exercises them in the node test environment with no
//     DOM and no network;
//   - DOM rendering + Leaflet wiring, gated behind `typeof document` checks
//     and behind a dynamic import() so neither Leaflet nor esri-leaflet is in
//     the initial bundle.
//
// Resilience is the reason this file is as long as it is. CORS is verified
// only for the ArcGIS-Online-hosted services; the six self-hosted
// `gis.*` / `mapping*.gw.govt.nz` hosts are unverified, so *every* channel is
// probed before its layer is added and degrades to an inline "open at source"
// state on CORS/4xx/5xx/timeout — one channel at a time, never the map.
/// <reference types="esri-leaflet" />
import "./map.css";
import type * as L from "leaflet";
import {
  datasets,
  themes,
  label as datasetLabel,
  findById,
  type Dataset,
} from "./catalogue";
import { setState, type RouteState } from "./router";
import { selectDataset } from "./filters";

// ---------------------------------------------------------------------------
// Pure layer model
// ---------------------------------------------------------------------------

/** How a dataset can be drawn.
 *  - `feature` — queryable vector layer, fetched as GeoJSON and drawn client
 *    side (clickable, styleable, popup-able).
 *  - `image`   — raster/group service with no queryable vector layer; the
 *    server renders a PNG for the current extent (no per-feature clicks).
 *  - `link`    — nothing we can draw in a Leaflet map: an ArcGIS Online web
 *    map, a plain web page, an empty service, or a row with no link at all.
 *    These are excluded from the overlay rack rather than added as a toggle
 *    that could never work. */
export type LayerKind = "feature" | "image" | "link";

export type ServerType = "MapServer" | "FeatureServer";

/** Everything the map UI needs about one catalogue row, computed once. */
export interface LayerDescriptor {
  id: string;
  label: string;
  /** Canonical theme key; `uncategorised` for the national rows whose theme
   * is null upstream. */
  theme: string;
  themeLabel: string;
  kind: LayerKind;
  serverType: ServerType | null;
  /** The layer index esri-leaflet is pointed at, for feature layers. */
  layerIndex: number | null;
  /** The URL handed to esri-leaflet: `${service_root}/${index}` for a feature
   * layer, the bare service root for an image layer, null for link-only. */
  serviceUrl: string | null;
  /** Sublayer ids for a dynamic image layer; null means "the whole service". */
  sublayers: number[] | null;
  /** Where a reader can open the data when the browser can't load it. */
  sourceUrl: string | null;
  host: string | null;
  attribution: string;
  /** Why this row is link-only. Null for drawable layers. */
  excludedReason: string | null;
}

/** ArcGIS REST service roots always end in `/MapServer` or `/FeatureServer`.
 * `server_type` carries that for most rows, but a handful of `link_type: web`
 * / null rows have a `service_root` and no `server_type` — the suffix is the
 * authoritative fallback, and the two must agree when both are present. */
export function serverTypeOf(d: Dataset): ServerType | null {
  if (d.server_type) return d.server_type;
  const root = d.service_root;
  if (!root) return null;
  const trimmed = root.replace(/\/+$/, "");
  if (/\/FeatureServer$/i.test(trimmed)) return "FeatureServer";
  if (/\/MapServer$/i.test(trimmed)) return "MapServer";
  return null;
}

/** The layer index to query, in the same precedence order catalogue.ts's
 * layerQueryUrl() documents: `resolved_layer` is the upstream-resolved index
 * and is already correct where present; `default_child` is the documented
 * sibling to use when this row's own layer is a non-queryable group; the raw
 * `layer_id` is the last resort. */
export function resolvedLayerIndex(d: Dataset): number | null {
  return d.resolved_layer ?? d.default_child ?? d.layer_id ?? null;
}

/** The URL esri-leaflet is pointed at for a given kind. Feature layers need
 * the layer index appended (`/MapServer/39`, `/FeatureServer/0`); a dynamic
 * image layer is created against the bare service root and told which
 * sublayers to draw. Returns null when there is no usable service. */
export function serviceUrlFor(d: Dataset, kind: LayerKind = classifyLayer(d)): string | null {
  if (kind === "link" || !d.service_root) return null;
  const root = d.service_root.replace(/\/+$/, "");
  if (kind === "image") return root;
  const index = resolvedLayerIndex(d);
  return index == null ? null : `${root}/${index}`;
}

/** The sublayers a dynamic image layer should draw, or null for "all of
 * them". Sea Level Rise and Storm Surge are group services whose only useful
 * child is `default_child`; the climate grids resolve to a single raster
 * index. Drawing the whole service where we have no index is still correct —
 * it is what the source's own viewer shows. */
export function imageSublayers(d: Dataset): number[] | null {
  const index = resolvedLayerIndex(d);
  return index == null ? null : [index];
}

/** Which of the three kinds a catalogue row is. Ordered so the cheapest
 * disqualifiers run first; everything that survives has a service we can
 * actually point Leaflet at. */
export function classifyLayer(d: Dataset): LayerKind {
  // `link_type` describes the row's *human-facing* `url`, not its data
  // endpoint: five rows are `arcgis_portal` and four of those (the NIWA
  // coastal set, including the coastal sensitivity inundation index) still
  // carry a resolved ArcGIS REST `service_root` alongside their portal page.
  // The rows that really are viewer-only — an ArcGIS Online web map with
  // nothing behind it — are exactly the rows with no `service_root`, so that
  // is the test, and it is what keeps this module from ever querying a web
  // map.
  if (!d.service_root) return "link";
  if (d.empty_service) return "link";

  const server = serverTypeOf(d);
  if (!server) return "link";

  if (d.raster_only) {
    // Only a MapServer can export a rendered image for an extent; a
    // FeatureServer has no export endpoint, so a raster-only FeatureServer
    // (none today, but the shape allows it) stays link-only.
    return server === "MapServer" ? "image" : "link";
  }

  if (d.feature_queryable && resolvedLayerIndex(d) != null) return "feature";

  // Non-raster, non-queryable: a group or unreadable service. A MapServer can
  // still draw itself as an image even when nothing under it is queryable.
  return server === "MapServer" ? "image" : "link";
}

/** The one-line explanation shown instead of a toggle. Null for drawable
 * layers. */
export function exclusionReason(d: Dataset): string | null {
  if (classifyLayer(d) !== "link") return null;
  if (!d.service_root) {
    return d.link_type === "arcgis_portal"
      ? "ArcGIS Online web map — opens in its own viewer"
      : "No service endpoint — external page only";
  }
  if (d.empty_service) return "Service publishes no layers";
  return "Service is not a MapServer or FeatureServer";
}

/** Attribution line for a single data source: who published it and which host
 * served it. Added to the map's attribution control while the layer is on and
 * removed when it is switched off, so the credit always matches what's drawn. */
export function attributionFor(d: Dataset): string {
  const who = d.authority?.trim();
  const host = d.host?.trim();
  if (who && host) return `${who} (${host})`;
  return who || host || "Source unattributed";
}

const UNCATEGORISED = "uncategorised";

/** Canonical theme labels, taken from the catalogue's own themes() selector
 * so the map and the filter console name a theme identically. Two upstream
 * rows spell the flood label differently ("Flood data" / "Flood Data"); this
 * pins the first-seen one for both. */
function themeLabels(list: Dataset[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const { theme, theme_label } of themes(list)) labels.set(theme, theme_label);
  labels.set(UNCATEGORISED, "National & other feeds");
  return labels;
}

/** Everything the UI needs about one row, in one object. */
export function describeLayer(d: Dataset, labels?: Map<string, string>): LayerDescriptor {
  const kind = classifyLayer(d);
  const theme = d.theme || UNCATEGORISED;
  const resolved = labels ?? themeLabels(datasets());
  return {
    id: d.id,
    label: datasetLabel(d),
    theme,
    themeLabel: resolved.get(theme) ?? d.theme_label ?? "Uncategorised",
    kind,
    serverType: serverTypeOf(d),
    layerIndex: kind === "feature" ? resolvedLayerIndex(d) : null,
    serviceUrl: serviceUrlFor(d, kind),
    sublayers: kind === "image" ? imageSublayers(d) : null,
    sourceUrl: d.url,
    host: d.host ?? null,
    attribution: attributionFor(d),
    excludedReason: exclusionReason(d),
  };
}

/** Every catalogue row as a descriptor, catalogue order preserved. */
export function describeAllLayers(list: Dataset[] = datasets()): LayerDescriptor[] {
  const labels = themeLabels(list);
  return list.map((d) => describeLayer(d, labels));
}

/** The layers that get a toggle: everything we can actually draw. Link-only
 * rows are dropped here rather than rendered as a control that would never
 * light up. */
export function toggleableLayers(list: Dataset[] = datasets()): LayerDescriptor[] {
  return describeAllLayers(list).filter((l) => l.kind !== "link");
}

export interface LayerGroup {
  theme: string;
  label: string;
  layers: LayerDescriptor[];
}

/** Hazard themes first (this is an emergency-management map — coastal
 * inundation and faults outrank the climate grids), then the remaining themes
 * in catalogue order. */
export const THEME_ORDER = [
  "coastal_inundation",
  "flood",
  "earthquake",
  "landslide",
  "sea_level_rise",
  "climate",
  "other",
  UNCATEGORISED,
];

/** Group descriptors into rack sections. Themes named in THEME_ORDER lead, in
 * that order; anything else follows in first-seen order. Empty groups are
 * dropped. */
export function groupLayersByTheme(layers: LayerDescriptor[]): LayerGroup[] {
  const buckets = new Map<string, LayerGroup>();
  for (const layer of layers) {
    let group = buckets.get(layer.theme);
    if (!group) {
      group = { theme: layer.theme, label: layer.themeLabel, layers: [] };
      buckets.set(layer.theme, group);
    }
    group.layers.push(layer);
  }
  const rank = (theme: string): number => {
    const i = THEME_ORDER.indexOf(theme);
    return i === -1 ? THEME_ORDER.length : i;
  };
  return [...buckets.values()].sort((a, b) => rank(a.theme) - rank(b.theme));
}

// ---------------------------------------------------------------------------
// Route state (`#layers=`)
// ---------------------------------------------------------------------------

/** Written to `#layers` when the reader has switched *everything* off. The
 * hash can't tell "no layers key" from "no layers wanted" on its own, and
 * without the distinction a reload of a deliberately-empty map would silently
 * re-enable the defaults. */
export const NO_LAYERS = "none";

/** The overlays a first-time visitor lands on: the two coastal inundation
 * bands the epic is built around, plus the active fault traces to give them
 * somewhere to sit. */
export const DEFAULT_LAYER_IDS = [
  "coastal-inundation-medium",
  "coastal-inundation-high",
  "active-faults",
];

/** Resolve route state into the ids that should be drawn. Unknown ids (a
 * stale deep link, a renamed dataset) are dropped rather than left to fail
 * later; the sentinel resolves to an empty map; an absent key means "first
 * visit", which gets the defaults. */
export function layerIdsFromRoute(state: RouteState, available: LayerDescriptor[]): string[] {
  const known = new Set(available.map((l) => l.id));
  const raw = state.layers;
  if (!raw || raw.length === 0) return DEFAULT_LAYER_IDS.filter((id) => known.has(id));
  if (raw.length === 1 && raw[0] === NO_LAYERS) return [];
  return raw.filter((id) => known.has(id));
}

/** The router patch for a set of active ids — the inverse of
 * layerIdsFromRoute, including the empty-map sentinel. */
export function patchForLayerIds(ids: string[]): Partial<RouteState> {
  return { layers: ids.length > 0 ? [...ids] : [NO_LAYERS] };
}

// ---------------------------------------------------------------------------
// Pure popup content
// ---------------------------------------------------------------------------

/** ArcGIS attribute tables are mostly plumbing: object ids, geometry
 * measurements, ESRI annotation columns, editor-tracking stamps. None of that
 * means anything to a resident reading "am I in the inundation zone", so the
 * popup skips them and shows the first few fields that carry actual content. */
const BORING_FIELD =
  /^(objectid|fid|globalid|uniqueid|shape|st_area|st_length)([^a-z0-9]|$)|^(se_anno|created_|created_date|last_edited_|editor_|gdb_)/i;

export interface PopupField {
  key: string;
  value: string;
}

/** Turn an ArcGIS column name into something readable: `HAZARD_TYPE` →
 * "Hazard type", `faultName` → "Fault name". */
export function humaniseField(key: string): string {
  const spaced = key
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  const lower = spaced.length > 0 ? spaced.toLowerCase() : key;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function formatValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? value.toLocaleString("en-NZ") : value.toFixed(2);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const text = String(value).trim();
  if (text === "" || text.toLowerCase() === "null") return null;
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

/** The handful of attributes worth showing in a popup, in table order. */
export function popupFields(properties: Record<string, unknown>, max = 3): PopupField[] {
  const out: PopupField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    if (out.length >= max) break;
    if (BORING_FIELD.test(key)) continue;
    const value = formatValue(raw);
    if (value === null) continue;
    out.push({ key: humaniseField(key), value });
  }
  return out;
}

/** Escape text for interpolation into markup. Attribute values come off a
 * third-party ArcGIS server, so nothing from a feature is ever trusted. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The popup a clicked feature opens: which dataset it came from, a couple of
 * its own attributes, and the two ways onward — the in-app dataset detail
 * (via selectDataset) and the authoritative source. */
export function popupHtml(layer: LayerDescriptor, properties: Record<string, unknown>): string {
  const fields = popupFields(properties);
  const rows = fields
    .map(
      (f) =>
        `<div class="hz-pop__row"><dt>${escapeHtml(f.key)}</dt><dd>${escapeHtml(f.value)}</dd></div>`,
    )
    .join("");
  const body = rows
    ? `<dl class="hz-pop__fields">${rows}</dl>`
    : `<p class="hz-pop__empty">This feature carries no descriptive attributes.</p>`;
  const source = layer.sourceUrl
    ? `<a class="hz-pop__link" href="${escapeHtml(layer.sourceUrl)}" target="_blank" rel="noreferrer">Source ${ARROW}</a>`
    : "";
  return `<div class="hz-pop">
    <p class="hz-pop__label">${escapeHtml(layer.themeLabel)}</p>
    <h4 class="hz-pop__title">${escapeHtml(layer.label)}</h4>
    ${body}
    <div class="hz-pop__actions">
      <button type="button" class="hz-pop__open" data-dataset="${escapeHtml(layer.id)}">Dataset detail</button>
      ${source}
    </div>
  </div>`;
}

const ARROW = "↗";

// ---------------------------------------------------------------------------
// Channel status (pure)
// ---------------------------------------------------------------------------

export type ChannelStatus = "idle" | "loading" | "live" | "blocked";

/** The mono readout at the right of a channel row. Feature layers report a
 * count once loaded; image layers have no client-side features to count, so
 * they report the render mode instead. */
export function statusReadout(
  status: ChannelStatus,
  kind: LayerKind,
  featureCount: number | null,
): string {
  if (status === "idle") return "off";
  if (status === "loading") return "···";
  if (status === "blocked") return "blocked";
  if (kind === "image") return "image";
  return featureCount == null ? "live" : `${featureCount.toLocaleString("en-NZ")}`;
}

// ---------------------------------------------------------------------------
// Icons — one set, drawn from the same 16×16 grid as src/filters.ts's. No
// second icon library and no emoji anywhere in this module.
// ---------------------------------------------------------------------------

function svg(path: string, size = 14): string {
  return `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="${path}" fill="currentColor"/></svg>`;
}

const ICON_LAYERS = svg(
  "M8 1.2 1.4 4.6a.7.7 0 0 0 0 1.25L8 9.24l6.6-3.39a.7.7 0 0 0 0-1.25L8 1.2Zm-4.9 6.9-1.7.87a.7.7 0 0 0 0 1.25L8 13.6l6.6-3.38a.7.7 0 0 0 0-1.25l-1.7-.87-4.55 2.33a.75.75 0 0 1-.7 0L3.1 8.1Z",
  15,
);
const ICON_ALERT = svg(
  "M7.13 1.9a1 1 0 0 1 1.74 0l6 10.5A1 1 0 0 1 14 14H2a1 1 0 0 1-.87-1.5l6-10.5ZM8 5a.9.9 0 0 0-.9.98l.3 3a.6.6 0 0 0 1.2 0l.3-3A.9.9 0 0 0 8 5Zm0 5.6a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Z",
  13,
);
const ICON_OFF = svg(
  "M8 1a1 1 0 0 1 1 1v5a1 1 0 0 1-2 0V2a1 1 0 0 1 1-1ZM4.4 3.5a1 1 0 0 1 .1 1.4A4.5 4.5 0 1 0 12.5 8a4.5 4.5 0 0 0-1-2.85 1 1 0 1 1 1.55-1.26A6.5 6.5 0 1 1 3 4.6a1 1 0 0 1 1.4-.1Z",
  13,
);

// ---------------------------------------------------------------------------
// DOM + Leaflet — everything below touches the browser
// ---------------------------------------------------------------------------

/** Wellington. The whole app is one city, so the map opens on it and stays
 * within a region-sized fence rather than letting a reader pan to Iceland. */
const WELLINGTON: [number, number] = [-41.2889, 174.7772];
const INITIAL_ZOOM = 12;
const REGION_BOUNDS: [[number, number], [number, number]] = [
  [-41.72, 174.42],
  [-40.86, 175.42],
];

/** A blocked host usually fails fast (CORS preflight) but a wedged one can
 * hang; without a deadline the channel would sit on "loading" forever. */
const PROBE_TIMEOUT_MS = 9000;

interface Channel {
  layer: LayerDescriptor;
  row: HTMLElement;
  toggle: HTMLButtonElement;
  readout: HTMLElement;
  note: HTMLElement;
  status: ChannelStatus;
  featureCount: number | null;
  /** The live Leaflet layer while this channel is on. */
  handle: unknown;
  /** Bumped on every activation so a slow probe that resolves after the
   * reader switched the channel back off can tell it is stale. */
  epoch: number;
}

interface MapShell {
  root: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLElement;
  skeleton: HTMLElement;
  count: HTMLElement;
  coords: HTMLElement;
  status: HTMLElement;
  live: HTMLElement;
  channels: Map<string, Channel>;
}

let shell: MapShell | null = null;
let leafletMap: unknown = null;
let runtime: MapRuntime | null = null;
let runtimeLoad: Promise<MapRuntime | null> | null = null;
/** Ids the reader wants drawn; the single source of truth is the URL, this is
 * just the last value we synced to. */
let activeIds: string[] = [];

/** The Leaflet module object, as a type. `import type * as L` above gives the
 * *type* meaning of `L`; the runtime object is destructured into a local
 * `const L` inside the functions that need it. TypeScript keeps value and
 * type namespaces separate, so `L.Map` in a type position still resolves to
 * the type-only import even where the local const shadows the value. */
type LeafletNS = typeof import("leaflet");

/** esri-leaflet ships no types of its own — @types/esri-leaflet only augments
 * the `L.esri` namespace — so the dynamic import is given the shape this
 * module actually calls. */
interface EsriModule {
  /** `attribution` is a real FeatureManager option upstream (it feeds
   * Leaflet's attribution control) but is missing from @types/esri-leaflet,
   * so it is spliced back in here rather than cast away at the call site. */
  featureLayer(
    options: L.esri.FeatureLayerOptions & { attribution?: string },
  ): L.esri.FeatureLayer;
  dynamicMapLayer(options: L.esri.DynamicMapLayerOptions): L.esri.DynamicMapLayer;
}

interface MapRuntime {
  L: LeafletNS;
  esri: EsriModule;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function prefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Read a hazard channel's colour out of the token layer so the geometry
 * drawn on the map and the swatch in the rack are literally the same value —
 * no component in this module hardcodes a colour. */
function themeColor(theme: string): string {
  if (typeof getComputedStyle !== "function") return "#7c8cf8";
  const styles = getComputedStyle(document.documentElement);
  const own = styles.getPropertyValue(`--map-hz-${theme.replace(/_/g, "-")}`).trim();
  return own || styles.getPropertyValue("--map-hz-default").trim() || "#7c8cf8";
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// Shell construction
// ---------------------------------------------------------------------------

function buildChannelRow(layer: LayerDescriptor, index: number): Channel {
  const row = el("div", "chan");
  row.dataset.id = layer.id;
  row.dataset.status = "idle";
  row.dataset.kind = layer.kind;
  row.style.setProperty("--chan-color", `var(--map-hz-${layer.theme.replace(/_/g, "-")}, var(--map-hz-default))`);
  row.style.setProperty("--i", String(Math.min(index, 12)));

  const toggle = el("button", "chan__toggle");
  toggle.type = "button";
  toggle.dataset.id = layer.id;
  toggle.setAttribute("aria-pressed", "false");

  const led = el("span", "chan__led");
  led.setAttribute("aria-hidden", "true");
  const name = el("span", "chan__name", layer.label);
  const readout = el("span", "chan__readout", "off");
  toggle.append(led, name, readout);

  const note = el("p", "chan__note");
  note.hidden = true;

  row.append(el("span", "chan__bar"), toggle, note);
  return {
    layer,
    row,
    toggle,
    readout,
    note,
    status: "idle",
    featureCount: null,
    handle: null,
    epoch: 0,
  };
}

/** The map stage's loading state: the geometry of the finished map — a
 * graticule, the HUD strip, the zoom stack and the scale bar — swept by the
 * same shimmer the filter console uses. Never a spinner and never a blank
 * rectangle, because the Leaflet chunk is a real download. */
function skeletonMarkup(): string {
  return `<div class="hzskel" aria-hidden="true">
    <div class="hzskel__grid"></div>
    <span class="hzskel__hud hzskel__shape"></span>
    <span class="hzskel__zoom hzskel__shape"></span>
    <span class="hzskel__scale hzskel__shape"></span>
    <span class="hzskel__blob hzskel__blob--a hzskel__shape"></span>
    <span class="hzskel__blob hzskel__blob--b hzskel__shape"></span>
  </div>`;
}

function buildShell(root: HTMLElement): MapShell {
  const toggleable = toggleableLayers();
  const groups = groupLayersByTheme(toggleable);
  const excluded = describeAllLayers().filter((l) => l.kind === "link");

  root.innerHTML = "";
  const panel = el("section", "hzmap");
  panel.dataset.ready = "false";

  // --- head -----------------------------------------------------------
  const head = el("header", "hzmap__head");
  const ident = el("div", "hzmap__ident");
  const kicker = el("p", "hzmap__label");
  kicker.innerHTML = `${ICON_LAYERS}<span>Hazard overlay</span>`;
  ident.append(kicker, el("h2", "hzmap__title", "Wellington situation map"));

  const readout = el("div", "hzmap__readout");
  const count = el("span", "hzmap__count", "0");
  readout.append(
    count,
    el("span", "hzmap__total", `/${toggleable.length}`),
    el("span", "hzmap__unit", "channels live"),
  );
  head.append(ident, readout);

  // --- rack -----------------------------------------------------------
  const rack = el("div", "hzmap__rack");
  rack.setAttribute("role", "group");
  rack.setAttribute("aria-label", "Hazard overlay channels");
  const channels = new Map<string, Channel>();
  let index = 0;
  for (const group of groups) {
    const section = el("div", "rack-group");
    const heading = el("p", "rack-group__label");
    heading.innerHTML = `<span>${escapeHtml(group.label)}</span><span class="rack-group__n">${group.layers.length}</span>`;
    section.append(heading);
    for (const layer of group.layers) {
      const channel = buildChannelRow(layer, index++);
      channels.set(layer.id, channel);
      section.append(channel.row);
    }
    rack.append(section);
  }
  if (excluded.length > 0) {
    const note = el("p", "rack-excluded");
    note.innerHTML = `${ICON_OFF}<span>${excluded.length} datasets publish no drawable service — open them from their catalogue card.</span>`;
    rack.append(note);
  }

  // --- stage ----------------------------------------------------------
  const stage = el("div", "hzmap__stage");
  const canvas = el("div", "hzmap__canvas");
  const hud = el("div", "hzmap__hud");
  const status = el("span", "hzmap__status", "Standing by");
  const coords = el("span", "hzmap__coords", "—°S  —°E");
  hud.append(status, coords);
  const skeletonHost = el("div", "hzmap__skeleton");
  skeletonHost.innerHTML = skeletonMarkup();
  stage.append(canvas, skeletonHost, hud);

  const body = el("div", "hzmap__body");
  body.append(rack, stage);

  const foot = el("footer", "hzmap__foot");
  foot.innerHTML = `<span>Basemap CARTO / OpenStreetMap · overlays served live from each publisher's ArcGIS REST endpoint.</span>`;

  const live = el("p", "hzmap__live");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");

  panel.append(head, body, foot, live);
  root.append(panel);

  return {
    root: panel,
    stage,
    canvas,
    skeleton: skeletonHost,
    count,
    coords,
    status,
    live,
    channels,
  };
}

// ---------------------------------------------------------------------------
// Channel status rendering
// ---------------------------------------------------------------------------

function setChannelStatus(
  channel: Channel,
  status: ChannelStatus,
  detail?: { count?: number | null; reason?: string },
): void {
  channel.status = status;
  if (detail && "count" in detail) channel.featureCount = detail.count ?? null;
  if (status === "idle") channel.featureCount = null;

  channel.row.dataset.status = status;
  channel.toggle.setAttribute("aria-pressed", String(status !== "idle"));
  channel.readout.textContent = statusReadout(status, channel.layer.kind, channel.featureCount);

  if (status === "blocked") {
    const href = channel.layer.sourceUrl ?? channel.layer.serviceUrl ?? "";
    const reason = detail?.reason ?? "This host refused the browser's request";
    channel.note.innerHTML = `${ICON_ALERT}<span>${escapeHtml(reason)} — ${
      href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">open at source ${ARROW}</a>` : "no public link"
    }</span>`;
    channel.note.hidden = false;
  } else {
    channel.note.hidden = true;
    channel.note.textContent = "";
  }
  syncCounters();
}

function syncCounters(): void {
  if (!shell) return;
  let live = 0;
  for (const channel of shell.channels.values()) if (channel.status === "live") live += 1;
  if (shell.count.textContent !== String(live)) {
    shell.count.textContent = String(live);
    shell.count.classList.remove("is-tick");
    // Force a reflow so the tick animation restarts on a repeat value change.
    void shell.count.offsetWidth;
    shell.count.classList.add("is-tick");
  }
}

function announce(message: string): void {
  if (shell) shell.live.textContent = message;
}

// ---------------------------------------------------------------------------
// Network probe — the resilience boundary
// ---------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean;
  reason?: string;
}

/** Ask a service for its own metadata before pointing a layer at it. This is
 * the one place a host's refusal is caught: a CORS rejection surfaces as a
 * TypeError from fetch, a dead service as a 4xx/5xx, an ArcGIS-level refusal
 * as an `error` object inside a 200, and a wedged host as an abort. Any of
 * those degrade this one channel and leave the map and every other channel
 * alone. */
async function probeService(url: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}?f=json`, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return { ok: false, reason: `Source returned HTTP ${response.status}` };
    const body: unknown = await response.json();
    const error = (body as { error?: { message?: string } } | null)?.error;
    if (error) return { ok: false, reason: error.message || "Source rejected the request" };
    return { ok: true };
  } catch {
    if (controller.signal.aborted) return { ok: false, reason: "Source timed out" };
    // A cross-origin block is indistinguishable from an offline network at
    // this layer by design — the browser hides the difference — so the copy
    // names the outcome, not a guess at the cause.
    return { ok: false, reason: "Blocked in-browser (no cross-origin access)" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Leaflet runtime — dynamically imported
// ---------------------------------------------------------------------------

/** Leaflet (~42KB gzip) and esri-leaflet come in through import() so neither
 * is in the initial bundle; the map's own CSS rides the same chunk. */
async function loadRuntime(): Promise<MapRuntime | null> {
  if (runtime) return runtime;
  if (runtimeLoad) return runtimeLoad;
  runtimeLoad = (async () => {
    try {
      const [leafletModule, esriModule] = await Promise.all([
        import("leaflet"),
        import("esri-leaflet"),
        // Leaflet's own stylesheet rides the same lazy chunk as its code, so
        // it stays out of the initial CSS payload. Vite resolves and splits
        // this; tsc can't, because this repo doesn't pull in vite/client's
        // ambient `*.css` declarations — hence the expected-error marker
        // rather than a cast that would also hide a real typo.
        // @ts-expect-error -- CSS side-effect module: resolved by Vite, not tsc
        import("leaflet/dist/leaflet.css"),
      ]);
      const L = ((leafletModule as { default?: LeafletNS }).default ?? leafletModule) as LeafletNS;
      const esri = esriModule as unknown as EsriModule;
      runtime = { L, esri };
      return runtime;
    } catch {
      runtimeLoad = null;
      return null;
    }
  })();
  return runtimeLoad;
}

const BASEMAPS = {
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
} as const;

const BASEMAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>';

let basemapLayer: L.TileLayer | null = null;

function formatCoords(lat: number, lng: number): string {
  const ns = lat < 0 ? "S" : "N";
  const ew = lng < 0 ? "W" : "E";
  return `${Math.abs(lat).toFixed(4)}°${ns}  ${Math.abs(lng).toFixed(4)}°${ew}`;
}

async function initMap(): Promise<void> {
  if (!shell || leafletMap !== null) return;
  leafletMap = "pending";
  shell.status.textContent = "Loading map engine";
  const loaded = await loadRuntime();
  if (!shell) return;
  if (!loaded) {
    leafletMap = null;
    shell.root.dataset.ready = "failed";
    shell.status.textContent = "Map engine unavailable";
    shell.skeleton.innerHTML = `<p class="hzmap__fallback">${ICON_ALERT}<span>The map engine could not be downloaded. Every dataset is still listed below and links to its source.</span></p>`;
    announce("The map engine could not be downloaded.");
    return;
  }

  const { L } = loaded;
  const reduce = prefersReducedMotion();
  const map = L.map(shell.canvas, {
    center: WELLINGTON,
    zoom: INITIAL_ZOOM,
    minZoom: 9,
    maxZoom: 18,
    maxBounds: L.latLngBounds(REGION_BOUNDS[0], REGION_BOUNDS[1]),
    maxBoundsViscosity: 0.65,
    zoomControl: false,
    fadeAnimation: !reduce,
    zoomAnimation: !reduce,
    markerZoomAnimation: !reduce,
    attributionControl: true,
  });
  leafletMap = map;

  basemapLayer = L.tileLayer(prefersDark() ? BASEMAPS.dark : BASEMAPS.light, {
    subdomains: "abcd",
    maxZoom: 19,
    attribution: BASEMAP_ATTRIBUTION,
  }).addTo(map);

  // The basemap is a third-party tile host like any other source. If it is
  // blocked the hazard overlays still draw over an empty canvas, so this
  // reports the gap in the HUD instead of leaving a silently blank map — and
  // clears itself the moment tiles start arriving again.
  let tileFailures = 0;
  basemapLayer.on("tileerror", () => {
    tileFailures += 1;
    if (tileFailures >= 4 && shell) {
      shell.root.dataset.basemap = "failed";
      shell.status.textContent = "Basemap unavailable";
    }
  });
  basemapLayer.on("load", () => {
    tileFailures = 0;
    if (shell && shell.root.dataset.basemap === "failed") {
      delete shell.root.dataset.basemap;
      shell.status.textContent = "Live";
    }
  });

  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);
  map.attributionControl.setPrefix("");

  // The basemap follows the OS theme for as long as the page is open, so the
  // map never ends up as a white slab inside a dark panel.
  if (typeof matchMedia === "function") {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const swap = (): void => {
      basemapLayer?.setUrl(query.matches ? BASEMAPS.dark : BASEMAPS.light);
    };
    if (typeof query.addEventListener === "function") query.addEventListener("change", swap);
  }

  map.on("mousemove", (event: L.LeafletMouseEvent) => {
    if (shell) shell.coords.textContent = formatCoords(event.latlng.lat, event.latlng.lng);
  });
  map.on("mouseout", () => {
    if (shell) shell.coords.textContent = formatCoords(WELLINGTON[0], WELLINGTON[1]);
  });

  shell.coords.textContent = formatCoords(WELLINGTON[0], WELLINGTON[1]);
  shell.root.dataset.ready = "true";
  shell.status.textContent = "Live";
  shell.skeleton.hidden = true;
  // Leaflet measures the container on creation; it was hidden behind the
  // skeleton until this frame on narrow layouts.
  requestAnimationFrame(() => map.invalidateSize());

  // Anything the URL asked for before the engine arrived is drawn now.
  for (const id of activeIds) void activateChannel(id);
}

// ---------------------------------------------------------------------------
// Per-channel activation
// ---------------------------------------------------------------------------

async function activateChannel(id: string): Promise<void> {
  const channel = shell?.channels.get(id);
  if (!channel || channel.handle) return;
  if (!runtime || typeof leafletMap !== "object" || leafletMap === null) {
    // The engine isn't up yet and this function must not pull it in — that
    // would defeat the lazy import for a reader who never scrolls this far.
    // initMap() replays activeIds the moment it finishes.
    setChannelStatus(channel, "loading");
    return;
  }
  const { L, esri } = runtime;
  const map = leafletMap as L.Map;
  const descriptor = channel.layer;
  const url = descriptor.serviceUrl;
  if (!url) {
    setChannelStatus(channel, "blocked", { reason: "No service endpoint" });
    return;
  }

  const epoch = ++channel.epoch;
  setChannelStatus(channel, "loading");

  const probe = await probeService(url);
  // The reader may have switched this channel off (or the panel been rebuilt)
  // while the probe was in flight.
  if (channel.epoch !== epoch || !shell?.channels.has(id)) return;
  if (!probe.ok) {
    setChannelStatus(channel, "blocked", { reason: probe.reason });
    announce(`${descriptor.label} could not be loaded in-browser.`);
    return;
  }

  const color = themeColor(descriptor.theme);
  const attribution = `<span class="hz-credit">${escapeHtml(descriptor.attribution)}</span>`;

  try {
    if (descriptor.kind === "feature") {
      const handle = esri.featureLayer({
        url,
        attribution,
        simplifyFactor: 0.6,
        precision: 6,
        style: () => ({
          color,
          weight: 2,
          opacity: 0.95,
          fillColor: color,
          fillOpacity: 0.22,
        }),
        // Leaflet's default marker icon depends on image paths a bundler
        // rewrites; a circle marker needs no asset and reads better against a
        // hazard polygon anyway.
        pointToLayer: (_feature: unknown, latlng: L.LatLngExpression) =>
          L.circleMarker(latlng, {
            radius: 5,
            color,
            weight: 2,
            fillColor: color,
            fillOpacity: 0.6,
          }),
        // Popups are bound per child layer rather than on the feature layer
        // itself, so each drawn geometry carries its own attributes.
        onEachFeature: (feature: { properties?: Record<string, unknown> }, child: L.Layer) => {
          child.bindPopup(popupHtml(descriptor, feature?.properties ?? {}), {
            className: "hz-popup",
            maxWidth: 320,
            autoPanPadding: L.point(24, 24),
          });
        },
      });
      channel.handle = handle;
      handle.on("load", () => {
        if (channel.epoch !== epoch) return;
        let count = 0;
        handle.eachFeature(() => {
          count += 1;
        });
        setChannelStatus(channel, "live", { count });
      });
      // esri-leaflet propagates its service's request failures to the layer,
      // so a host that passes the probe but fails a later tile-extent query
      // still degrades this channel instead of failing silently.
      handle.on("requesterror", () => {
        if (channel.epoch !== epoch) return;
        setChannelStatus(channel, "blocked", { reason: "Source refused a data request" });
      });
      handle.addTo(map);
    } else {
      const options: L.esri.DynamicMapLayerOptions = {
        url,
        attribution,
        opacity: 0.72,
        format: "png32",
        transparent: true,
      };
      if (descriptor.sublayers) options.layers = descriptor.sublayers;
      const handle = esri.dynamicMapLayer(options);
      channel.handle = handle;
      handle.on("load", () => {
        if (channel.epoch !== epoch) return;
        setChannelStatus(channel, "live", { count: null });
      });
      handle.on("requesterror", () => {
        if (channel.epoch !== epoch) return;
        setChannelStatus(channel, "blocked", { reason: "Source refused the image request" });
      });
      handle.addTo(map);
    }
    announce(`${descriptor.label} overlay added.`);
  } catch {
    channel.handle = null;
    setChannelStatus(channel, "blocked", { reason: "Layer could not be created" });
  }
}

function deactivateChannel(id: string): void {
  const channel = shell?.channels.get(id);
  if (!channel) return;
  channel.epoch += 1;
  const handle = channel.handle as L.Layer | null;
  if (handle && typeof leafletMap === "object" && leafletMap !== null) {
    (leafletMap as L.Map).removeLayer(handle);
  }
  channel.handle = null;
  setChannelStatus(channel, "idle");
}

/** Bring the map's drawn layers in line with the ids the URL is asking for. */
function syncLayers(ids: string[]): void {
  if (!shell) return;
  const wanted = new Set(ids);
  activeIds = ids;
  for (const [id, channel] of shell.channels) {
    const on = wanted.has(id);
    if (on && channel.status === "idle") void activateChannel(id);
    else if (!on && channel.status !== "idle") deactivateChannel(id);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function currentIds(): string[] {
  if (!shell) return [];
  const out: string[] = [];
  for (const [id, channel] of shell.channels) if (channel.status !== "idle") out.push(id);
  return out;
}

function toggleLayer(id: string): void {
  const next = new Set(currentIds());
  if (next.has(id)) next.delete(id);
  else next.add(id);
  // The URL is the source of truth: write it and let the router's own
  // notification drive syncLayers, exactly like the filter console does.
  setState(patchForLayerIds([...next]));
}

const wiredRoots = new WeakSet<HTMLElement>();

function wire(panel: MapShell): void {
  if (wiredRoots.has(panel.root)) return;
  wiredRoots.add(panel.root);

  panel.root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const toggle = target.closest<HTMLButtonElement>(".chan__toggle");
    if (toggle?.dataset.id) {
      void initMap();
      toggleLayer(toggle.dataset.id);
      return;
    }
    // Popups live in Leaflet's own pane, which is inside this panel.
    const open = target.closest<HTMLElement>(".hz-pop__open");
    if (open?.dataset.dataset) selectDataset(open.dataset.dataset);
  });

  // First view or first intent, whichever lands first: the engine download
  // only starts when the map is about to matter.
  const start = (): void => void initMap();
  panel.stage.addEventListener("pointerenter", start, { once: true });
  panel.root.addEventListener("focusin", start, { once: true });

  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          start();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(panel.stage);
  } else {
    start();
  }
}

/** Paint the selected dataset into the rack, so a card click, a search
 * selection or a pasted deep link all point at the same channel. */
function syncSelection(id: string | undefined): void {
  if (!shell) return;
  for (const [channelId, channel] of shell.channels) {
    channel.row.classList.toggle("is-selected", channelId === id);
  }
}

/** The FeatureModule main.ts registers against `#map-root`. Built once, then
 * patched in place on every route change — rebuilding would tear down the
 * Leaflet instance and every layer on it. */
export default function renderMap(root: HTMLElement, state: RouteState): void {
  if (typeof document === "undefined") return;
  if (!shell || shell.root.parentElement !== root) {
    shell = buildShell(root);
    wire(shell);
    // Reflect the first-visit defaults into the URL so what's drawn and what
    // the address bar says never disagree, and so the view is copyable
    // straight away.
    const initial = layerIdsFromRoute(state, [...shell.channels.values()].map((c) => c.layer));
    if (!state.layers) setState(patchForLayerIds(initial), { replace: true });
    syncLayers(initial);
    syncSelection(state.dataset);
    return;
  }
  syncLayers(layerIdsFromRoute(state, [...shell.channels.values()].map((c) => c.layer)));
  syncSelection(state.dataset);
}

/** Look a descriptor up by dataset id. */
export function layerById(id: string): LayerDescriptor | undefined {
  const dataset = findById(id);
  return dataset ? describeLayer(dataset) : undefined;
}
