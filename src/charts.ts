// The projection strip: the climate-charts surface for whichever catalogue row
// is selected (`#dataset=<id>` in the router's hash). Only the 21 rows under
// the `climate` theme have anything to chart — every other selection, and no
// selection at all, leaves this mount genuinely empty (hidden), because a
// permanent "nothing to chart here" placard under the dossier would be noise
// on 46 of the 67 datasets.
//
// What it charts: each climate variable's parent layer on GWRC's
// ClimateChange/Modelled_Climate_Change MapServer is a group whose children are
// the modelled scenario × time-horizon rasters (climate-mean-temp → layer 126,
// children 127…). We read that group's child list from the service, then sample
// every child raster at one fixed point — Wellington city centre — with a single
// MapServer `identify` call, and draw the resulting series as a zero-baselined
// bar chart. The zero line is the whole point: these layers are *changes* from
// the modelled baseline, so a bar below the line is a projected decrease.
//
// Two halves, the same split src/detail.ts and src/map.ts document at their top:
//   - pure functions (the decision to chart at all, the URL builders, the
//     layer-tree walk, the identify parser, the unit wording, the chart model
//     and the bar geometry) with no `document`/`window`/`fetch` reference at
//     all, so src/charts.test.ts exercises them directly in the node test
//     environment;
//   - DOM rendering + the live sample behind a `typeof document === "undefined"`
//     guard, the same way src/main.ts gates boot(), so importing this module in
//     a test never touches a browser global or issues a request.
//
// This module deliberately imports nothing from main.ts — see the FeatureModule
// doc there for the import-cycle hazard that would create.
import "./charts.css";
import { findById, label, type Dataset } from "./catalogue";
import type { RouteState } from "./router";

// ---------------------------------------------------------------------------
// Pure logic — no DOM, no fetch
// ---------------------------------------------------------------------------

/** The catalogue `theme` key whose rows this module charts. */
export const CLIMATE_THEME = "climate";

/** The single point every scenario raster is sampled at. Wellington city
 * centre (Te Ngākau / Civic Square), in WGS84 — one fixed point rather than a
 * regional average, so every bar in the chart is the same place under a
 * different scenario and the bars are actually comparable. */
export const SAMPLE_POINT = {
  lat: -41.2866,
  lon: 174.7756,
  label: "Wellington city centre",
} as const;

/** Half-width, in degrees, of the map extent sent with an identify request.
 * ArcGIS resolves `tolerance` in screen pixels against `mapExtent`/
 * `imageDisplay`, so this is what makes the sample a ~point sample rather than
 * a whole-region one. */
const IDENTIFY_HALF_SPAN = 0.02;

/** The group layer that holds a climate variable's scenario children. For
 * every climate row upstream records the group in `layer_id` and its first
 * child in `default_child` (climate-mean-temp → 126 / 127), so `layer_id` is
 * the one to walk from; the other two are fallbacks for a row that ever grows
 * a different shape. Null when none of the three resolves. */
export function parentLayerIndex(d: Dataset): number | null {
  return d.layer_id ?? d.resolved_layer ?? d.default_child ?? null;
}

/** Why this route state charts nothing, or null when it does. */
export type ChartBlockReason =
  | "no-selection"
  | "unknown-dataset"
  | "not-climate"
  | "no-service"
  | "no-parent-layer";

export interface ChartDecision {
  show: boolean;
  /** Null exactly when `show` is true. Not rendered anywhere — the mount stays
   * empty — but it names the branch for the tests and for debugging. */
  reason: ChartBlockReason | null;
}

/** Whether a given route state + the catalogue row it points at should render a
 * chart. The single gate the module's render path and its tests share, so
 * "which datasets get a chart" is answerable without a DOM. */
export function chartDecision(state: RouteState, dataset: Dataset | null | undefined): ChartDecision {
  if (!state.dataset) return { show: false, reason: "no-selection" };
  if (!dataset || dataset.id !== state.dataset) return { show: false, reason: "unknown-dataset" };
  if (dataset.theme !== CLIMATE_THEME) return { show: false, reason: "not-climate" };
  if (!dataset.service_root) return { show: false, reason: "no-service" };
  if (parentLayerIndex(dataset) == null) return { show: false, reason: "no-parent-layer" };
  return { show: true, reason: null };
}

/** The layer document of the variable's group layer — the cheapest description
 * of the scenario children (`subLayers: [{id, name}, …]`), rather than pulling
 * the whole 190-layer service tree down to read eight names off it. Null for a
 * dataset chartDecision() would have rejected. */
export function scenarioTreeUrl(d: Dataset): string | null {
  const parent = parentLayerIndex(d);
  if (!d.service_root || parent == null) return null;
  return `${d.service_root}/${parent}?f=json`;
}

/** One `identify` call that samples every scenario raster at SAMPLE_POINT.
 * `layers=all:<ids>` asks for those layers regardless of scale/visibility;
 * `mapExtent` + `imageDisplay` + `tolerance` are what give the point its
 * resolution. Null when there is no service or no layer to sample. */
export function identifyUrl(d: Dataset, layerIds: number[]): string | null {
  if (!d.service_root || layerIds.length === 0) return null;
  const { lat, lon } = SAMPLE_POINT;
  const h = IDENTIFY_HALF_SPAN;
  const params = new URLSearchParams({
    f: "json",
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    layers: `all:${layerIds.join(",")}`,
    tolerance: "2",
    mapExtent: `${lon - h},${lat - h},${lon + h},${lat + h}`,
    imageDisplay: "512,512,96",
    returnGeometry: "false",
  });
  return `${d.service_root}/identify?${params.toString()}`;
}

// --- the layer tree -------------------------------------------------------

export interface ScenarioLayer {
  /** The sub-layer's own index on the MapServer — what identify keys on. */
  id: number;
  /** The name exactly as the service reports it. */
  name: string;
  /** `name` with the parent group's name stripped off the front, so a chart of
   * "Mean temperature" isn't eight bars all labelled "Mean temperature …". */
  label: string;
  /** Emissions scenario parsed out of the name ("RCP 8.5"), null when the name
   * doesn't carry one. */
  scenario: string | null;
  /** Time horizon as written ("2031–2050"), null when the name carries none. */
  horizon: string | null;
  /** First year of `horizon`, used only for ordering. */
  horizonYear: number | null;
}

interface TreeNode {
  id: number;
  name: string;
  parentId: number | null;
  childIds: number[];
  group: boolean;
  /** True for a node known only as a `{id, name}` entry inside another node's
   * subLayers — a full document for the same id supersedes it. */
  stub: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function childIdsOf(record: Record<string, unknown>): number[] {
  const out: number[] = [];
  // Root-service shape: subLayerIds: [127, 128, …]
  const ids = record.subLayerIds;
  if (Array.isArray(ids)) {
    for (const id of ids) if (typeof id === "number" && Number.isInteger(id)) out.push(id);
  }
  // Layer-document shape: subLayers: [{ id, name }, …]
  const subs = record.subLayers;
  if (Array.isArray(subs)) {
    for (const sub of subs) {
      const child = asRecord(sub);
      const id = child?.id;
      if (typeof id === "number" && Number.isInteger(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Index every layer mentioned anywhere in a service body — the `layers` array
 * of `{service_root}/layers?f=json` (or of the service root document), a single
 * layer document, and the `{id, name}` stubs nested in either one's subLayers.
 * Full documents win over stubs for the same id, so a body that carries both
 * describes each layer once. */
function collectTree(body: unknown): Map<number, TreeNode> {
  const nodes = new Map<number, TreeNode>();

  const add = (node: TreeNode): void => {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
      return;
    }
    // A stub never supersedes a full layer document; a full document does
    // supersede a stub, keeping whatever the stub had already established.
    if (existing.stub && !node.stub) {
      nodes.set(node.id, { ...node, group: node.group || existing.group });
    }
  };

  const visit = (value: unknown, parentFallback: number | null, stub: boolean): void => {
    const record = asRecord(value);
    if (!record) return;
    const id = record.id;
    if (typeof id !== "number" || !Number.isInteger(id)) return;

    const rawParent = record.parentLayerId;
    const parentObject = asRecord(record.parentLayer);
    let parentId: number | null = parentFallback;
    if (typeof rawParent === "number" && Number.isInteger(rawParent)) parentId = rawParent < 0 ? null : rawParent;
    else if (parentObject && typeof parentObject.id === "number") parentId = parentObject.id;

    const childIds = childIdsOf(record);
    const type = typeof record.type === "string" ? record.type : "";
    const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim() : `Layer ${id}`;

    add({ id, name, parentId, childIds, group: childIds.length > 0 || /group/i.test(type), stub });

    for (const sub of Array.isArray(record.subLayers) ? record.subLayers : []) visit(sub, id, true);
  };

  const root = asRecord(body);
  if (!root) return nodes;
  if (Array.isArray(root.layers)) for (const entry of root.layers) visit(entry, null, false);
  visit(body, null, false);
  return nodes;
}

/** "RCP8.5", "RCP 8.5", "rcp-8_5" — services are inconsistent about the
 * separator on both sides of the first digit, so both are a loose class. */
const SCENARIO_RE = /\b(RCP|SSP)\s*[-_ ]?(\d)\s*[.,_-]?\s*(\d)\b/i;
/** A projection year: 1900–2199, which covers both the modelled baseline
 * period and every horizon these services publish (including a range that ends
 * in 2100 — `20\d\d` alone would silently drop that half of "2081-2100"). */
const YEAR = String.raw`(?:19|20|21)\d{2}`;
const HORIZON_RE = new RegExp(String.raw`\b(${YEAR})\s*(?:[-–—]|\bto\b)\s*(${YEAR})\b|\b(${YEAR})\b`);

/** "RCP8.5", "rcp 8_5" → "RCP 8.5". Null when the name carries no scenario. */
export function parseScenario(name: string): string | null {
  const m = SCENARIO_RE.exec(name);
  return m ? `${m[1]!.toUpperCase()} ${m[2]}.${m[3]}` : null;
}

/** "2031-2050" → "2031–2050" (en dash), "2040" → "2040", plus the first year
 * for ordering. Null/null when the name carries no year. */
export function parseHorizon(name: string): { horizon: string | null; year: number | null } {
  const m = HORIZON_RE.exec(name);
  if (!m) return { horizon: null, year: null };
  if (m[1] && m[2]) return { horizon: `${m[1]}–${m[2]}`, year: Number(m[1]) };
  const single = m[3] ?? m[1]!;
  return { horizon: single, year: Number(single) };
}

/** A child's name with the group's name stripped off the front (plus whatever
 * separator joined them), falling back to the full name when that would leave
 * nothing behind. */
export function shortLayerLabel(name: string, parentName: string | null): string {
  const full = name.trim();
  let text = full;
  const parent = parentName?.trim() ?? "";
  if (parent !== "" && text.toLowerCase().startsWith(parent.toLowerCase())) text = text.slice(parent.length);
  text = text.replace(/^[\s\-–—:_·|,/]+/, "").replace(/[\s\-–—:_·|,/]+$/, "").trim();
  return text === "" ? full : text;
}

/** The chartable descendants of `parentId`: every non-group layer under it,
 * nested groups walked through rather than charted. Ordered by time horizon
 * then scenario when the service names carry both (so the chart reads left to
 * right through the projections), and in service order otherwise. Never
 * throws — a malformed body yields an empty list, which the panel renders as
 * its "no chartable sub-layers" state. */
export function selectScenarioLayers(body: unknown, parentId: number): ScenarioLayer[] {
  const nodes = collectTree(body);
  const parent = nodes.get(parentId);
  if (!parent) return [];
  const parentName = parent.name;

  const out: ScenarioLayer[] = [];
  const seen = new Set<number>([parentId]);

  const walk = (node: TreeNode): void => {
    const declared = node.childIds.filter((id) => nodes.has(id));
    const implied = [...nodes.values()]
      .filter((n) => n.parentId === node.id && !declared.includes(n.id))
      .map((n) => n.id);
    for (const id of [...declared, ...implied]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const child = nodes.get(id)!;
      if (child.group) {
        walk(child);
        continue;
      }
      const { horizon, year } = parseHorizon(child.name);
      out.push({
        id: child.id,
        name: child.name,
        label: shortLayerLabel(child.name, parentName),
        scenario: parseScenario(child.name),
        horizon,
        horizonYear: year,
      });
    }
  };
  walk(parent);

  const ordered = out.every((l) => l.horizonYear !== null)
    ? [...out].sort(
        (a, b) =>
          a.horizonYear! - b.horizonYear! || (a.scenario ?? "").localeCompare(b.scenario ?? "") || a.id - b.id,
      )
    : out;
  return ordered;
}

// --- the identify response ------------------------------------------------

const NODATA_RE = /^(nodata|no\s*data|null|none|n\/a|-{1,2}|-?9{4}(\.0+)?)$/i;

/** One raster reading from an identify result, or null when the service has no
 * value at the sample point. ArcGIS reports a raster miss as the *string*
 * "NoData" (and, on some services, a -9999 sentinel) with an otherwise healthy
 * HTTP 200, so a naive Number() would chart 0 or NaN where there is simply no
 * modelled cell. */
export function parseIdentifyValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "" || NODATA_RE.test(text)) return null;
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

const PIXEL_KEY_RE = /(pixel\s*value|^value$|service\s*pixel\s*value)/i;

/** Some MapServers leave `value` empty and carry the reading in the result's
 * attributes ("Pixel Value", "Raster.ServicePixelValue", …) instead. */
function pixelValueFromAttributes(attributes: unknown): number | null {
  const record = asRecord(attributes);
  if (!record) return null;
  for (const [key, raw] of Object.entries(record)) {
    if (!PIXEL_KEY_RE.test(key.replace(/^.*\./, "").trim())) continue;
    const value = parseIdentifyValue(raw);
    if (value !== null) return value;
  }
  return null;
}

/** Layer id → sampled value, for every identify result that carries a real
 * reading. Results with no value (NoData, a missing field, a malformed body)
 * are skipped rather than charted as zero; the first usable result per layer
 * wins, since identify can return several hits inside the tolerance. */
export function parseIdentifyValues(body: unknown): Map<number, number> {
  const out = new Map<number, number>();
  const record = asRecord(body);
  const results = record?.results;
  if (!Array.isArray(results)) return out;
  for (const entry of results) {
    const result = asRecord(entry);
    if (!result) continue;
    const layerId = result.layerId;
    if (typeof layerId !== "number" || !Number.isInteger(layerId) || out.has(layerId)) continue;
    const value = parseIdentifyValue(result.value) ?? pixelValueFromAttributes(result.attributes);
    if (value === null) continue;
    out.set(layerId, value);
  }
  return out;
}

// --- unit wording ---------------------------------------------------------

export interface Unit {
  /** The upstream wording, verbatim: "annual changes in deg C". */
  phrase: string | null;
  /** The short form for a value label: "°C", "days", "%", "mm", "GDD". */
  symbol: string | null;
}

const UNIT_RULES: [RegExp, string][] = [
  [/\bdeg(rees)?\s*c\b|°\s*c\b/i, "°C"],
  [/\bgdd\b/i, "GDD"],
  [/%/, "%"],
  [/\bdays?\b/i, "days"],
  [/\bmm\b/i, "mm"],
];

/** The unit these projections are measured in, read out of the upstream
 * description's trailing parenthesis — "Mean temperature (annual changes in
 * deg C)" → phrase "annual changes in deg C", symbol "°C". The catalogue has no
 * unit field, and this wording is the only place the unit is recorded. */
export function unitFromDescription(description: string | null | undefined): Unit {
  const text = description?.trim() ?? "";
  if (text === "") return { phrase: null, symbol: null };
  const matches = text.match(/\(([^()]*)\)/g);
  const phrase = matches?.length ? matches[matches.length - 1]!.slice(1, -1).trim() : null;
  const source = phrase && phrase !== "" ? phrase : text;
  for (const [pattern, symbol] of UNIT_RULES) {
    if (pattern.test(source)) return { phrase: phrase || null, symbol };
  }
  return { phrase: phrase || null, symbol: null };
}

/** A signed, unit-suffixed value label. Precision follows magnitude so a
 * +0.65 °C and a +124 GDD both read at the right resolution, and the sign is
 * always explicit — every one of these layers is a *change*, so "1.4" alone
 * would be ambiguous. Uses a true minus sign (U+2212) so the bars' labels line
 * up in the tabular mono face. */
export function formatChange(value: number, symbol: string | null): string {
  const magnitude = Math.abs(value);
  const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  const rounded = magnitude.toFixed(digits);
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return symbol ? `${sign}${rounded} ${symbol}` : `${sign}${rounded}`;
}

// --- the chart model ------------------------------------------------------

export interface ChartPoint {
  layerId: number;
  /** Full sub-layer label, used for the bar's tooltip and the text summary. */
  label: string;
  /** First tick line: the scenario, or the whole label when none parses. */
  primary: string;
  /** Second tick line: the time horizon, or "" when none parses. */
  secondary: string;
  value: number;
  /** The formatted value label, e.g. "+1.40 °C". */
  text: string;
}

export interface ChartModel {
  id: string;
  title: string;
  unit: Unit;
  points: ChartPoint[];
  /** The largest change by magnitude — the panel's headline readout. */
  peak: ChartPoint | null;
  /** Sub-layers that exist but returned no value at the sample point. */
  skipped: number;
  /** Sub-layers found on the service, charted or not. */
  total: number;
  /** The full text summary read out to screen readers in place of the SVG. */
  summary: string;
}

/** Everything the panel draws, derived in one place from the two service
 * responses, so the markup below is a pure projection of it (and so the whole
 * model is unit-testable without a DOM or a network). */
export function buildChartModel(
  d: Dataset,
  layers: ScenarioLayer[],
  values: Map<number, number>,
): ChartModel {
  const unit = unitFromDescription(d.description);
  const points: ChartPoint[] = [];
  for (const layer of layers) {
    const value = values.get(layer.id);
    if (value === undefined) continue;
    points.push({
      layerId: layer.id,
      label: layer.label,
      // With no scenario in the name the label is all there is, and it already
      // carries the horizon — so the second tick line would just repeat it.
      primary: layer.scenario ?? layer.label,
      secondary: layer.scenario ? layer.horizon ?? "" : "",
      value,
      text: formatChange(value, unit.symbol),
    });
  }

  let peak: ChartPoint | null = null;
  for (const point of points) {
    if (!peak || Math.abs(point.value) > Math.abs(peak.value)) peak = point;
  }

  const title = label(d);
  const skipped = layers.length - points.length;
  const readings = points.map((p) => `${p.label}: ${p.text}`).join("; ");
  const summary =
    points.length === 0
      ? `${title}: the service returned no modelled value at ${SAMPLE_POINT.label}.`
      : `${title} — modelled change at ${SAMPLE_POINT.label}${unit.phrase ? `, ${unit.phrase}` : ""}. ${readings}.` +
        (skipped > 0 ? ` ${skipped} further scenario ${skipped === 1 ? "layer" : "layers"} returned no value.` : "");

  return { id: d.id, title, unit, points, peak, skipped, total: layers.length, summary };
}

// --- bar geometry ---------------------------------------------------------

export interface ChartGeometryOptions {
  /** Horizontal slot per bar, bar plus gutter. */
  slot?: number;
  barWidth?: number;
  /** Left gutter, where the zero-line label sits. */
  left?: number;
  right?: number;
  /** Headroom above the plot for the positive bars' value labels. */
  top?: number;
  plotHeight?: number;
  /** Band under the plot for the negative bars' value labels. */
  valuePad?: number;
  /** Band under that for the two-line scenario/horizon ticks. */
  tickBand?: number;
}

export interface ChartBar {
  index: number;
  value: number;
  /** True for a bar drawn below the zero line. */
  negative: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Horizontal centre — where the value and tick labels are anchored. */
  center: number;
  /** Baseline y of the value label: above a positive bar, below a negative. */
  labelY: number;
}

export interface ChartGeometry {
  width: number;
  height: number;
  /** Horizontal slot each bar owns — the width of its hover/tooltip target. */
  slot: number;
  plot: { x: number; y: number; width: number; height: number };
  /** y of the zero line — bars grow up from it, or down from it. */
  baselineY: number;
  domain: { min: number; max: number };
  /** Baselines of the two tick label lines under the plot. */
  ticks: { y1: number; y2: number };
  bars: ChartBar[];
}

/** So a real-but-tiny change is still a visible bar rather than a hairline
 * that reads as "no data". Only ever applied to a non-zero value. */
const MIN_BAR_HEIGHT = 2;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Map a value series onto bar rectangles around a zero baseline. The domain
 * always includes zero (so a series of only-positive changes still baselines at
 * the foot of the plot, and a mixed series puts the line where zero actually
 * falls); an all-zero or empty series gets a symmetric nominal domain so the
 * line lands in the middle instead of dividing by zero. */
export function chartGeometry(values: number[], options: ChartGeometryOptions = {}): ChartGeometry {
  const slot = options.slot ?? 68;
  const barWidth = options.barWidth ?? 30;
  const left = options.left ?? 38;
  const right = options.right ?? 14;
  const top = options.top ?? 26;
  const plotHeight = options.plotHeight ?? 152;
  const valuePad = options.valuePad ?? 20;
  const tickBand = options.tickBand ?? 36;

  const plotWidth = Math.max(slot * values.length, slot);
  const width = left + plotWidth + right;
  const plotBottom = top + plotHeight;
  const height = plotBottom + valuePad + tickBand;

  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const flat = rawMax - rawMin === 0;
  const min = flat ? -1 : rawMin;
  const max = flat ? 1 : rawMax;
  const span = max - min;
  const yFor = (value: number): number => top + (plotHeight * (max - value)) / span;
  const baselineY = yFor(0);

  const bars = values.map((value, index) => {
    const negative = value < 0;
    const edge = yFor(value);
    let barTop = negative ? baselineY : edge;
    let barHeight = Math.abs(edge - baselineY);
    if (value !== 0 && barHeight < MIN_BAR_HEIGHT) {
      barHeight = MIN_BAR_HEIGHT;
      if (!negative) barTop = baselineY - MIN_BAR_HEIGHT;
    }
    const center = left + slot * index + slot / 2;
    return {
      index,
      value,
      negative,
      x: round(center - barWidth / 2),
      y: round(barTop),
      width: barWidth,
      height: round(barHeight),
      center: round(center),
      labelY: round(negative ? barTop + barHeight + 13 : barTop - 8),
    };
  });

  return {
    width,
    height,
    slot,
    plot: { x: left, y: top, width: plotWidth, height: plotHeight },
    baselineY: round(baselineY),
    domain: { min, max },
    ticks: { y1: round(plotBottom + valuePad + 12), y2: round(plotBottom + valuePad + 26) },
    bars,
  };
}

// ---------------------------------------------------------------------------
// Icon set — same family as src/filters.ts, src/map.ts and src/detail.ts:
// solid paths on a 16px grid, drawn in currentColor. No second icon library,
// no emoji.
// ---------------------------------------------------------------------------

function svg(path: string, size = 14): string {
  return `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="${path}" fill="currentColor"/></svg>`;
}

const ICON_CHART = svg(
  "M2 1a1 1 0 0 1 1 1v11h11a1 1 0 1 1 0 2H2.5A1.5 1.5 0 0 1 1 13.5V2a1 1 0 0 1 1-1Zm3.5 6a1 1 0 0 1 1 1v3a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1Zm3.5-4a1 1 0 0 1 1 1v7a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Zm3.5 2a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Z",
  13,
);
const ICON_ALERT = svg(
  "M8 1.5a1.2 1.2 0 0 1 1.04.6l6 10.3A1.2 1.2 0 0 1 14 14.2H2a1.2 1.2 0 0 1-1.04-1.8l6-10.3A1.2 1.2 0 0 1 8 1.5Zm0 3.6a.9.9 0 0 0-.9.97l.25 3a.65.65 0 0 0 1.3 0l.25-3A.9.9 0 0 0 8 5.1Zm0 5.4a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Z",
  12,
);
const ICON_RETRY = svg(
  "M8 2a6 6 0 1 0 5.65 8 1 1 0 1 0-1.88-.67A4 4 0 1 1 8 4a3.96 3.96 0 0 1 2.6.98L9.3 6.29A.7.7 0 0 0 9.8 7.5H13a1 1 0 0 0 1-1V3.3a.7.7 0 0 0-1.2-.5l-.79.79A5.97 5.97 0 0 0 8 2Z",
  12,
);
const ICON_PIN = svg(
  "M8 1a5 5 0 0 0-5 5c0 3.6 4.3 8.5 4.48 8.71a.7.7 0 0 0 1.04 0C8.7 14.5 13 9.6 13 6a5 5 0 0 0-5-5Zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z",
  12,
);

// ---------------------------------------------------------------------------
// The live sample — fetch, memoised per dataset id
// ---------------------------------------------------------------------------

export interface ChartSeries {
  layers: ScenarioLayer[];
  values: Map<number, number>;
}

const seriesCache = new Map<string, ChartSeries>();
const inflight = new Map<string, { promise: Promise<ChartSeries>; controller: AbortController }>();

/** GWRC's own live ArcGIS endpoint — occasionally slow, briefly offline, or
 * unreachable from a given network. Without a bound, a stalled request would
 * leave the skeleton shimmering forever instead of reaching the error state. */
const SAMPLE_TIMEOUT_MS = 20_000;

function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "the request timed out";
  return error instanceof Error && error.message ? error.message : "Request failed";
}

/** An ArcGIS REST error body's message, or null. ArcGIS reports failures as
 * HTTP 200 with an `error` object, so a status check alone would read a failure
 * as a successful empty response. */
export function serviceErrorMessage(body: unknown): string | null {
  const record = asRecord(body);
  const error = asRecord(record?.error);
  if (!error) return null;
  const message = error.message;
  return typeof message === "string" && message.trim() !== "" ? message.trim() : "service error";
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`service responded ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("service returned a non-JSON response");
  }
  const message = serviceErrorMessage(body);
  if (message) throw new Error(message);
  return body;
}

/** Read the variable's scenario children, then sample them all at once. The
 * second request depends on the first (identify needs the layer ids), so this
 * is a genuine two-step; a variable whose group turns out to have no chartable
 * children skips the sample entirely and resolves with an empty series, which
 * the panel renders as its "no chartable sub-layers" state. */
async function sample(d: Dataset, signal: AbortSignal): Promise<ChartSeries> {
  const treeUrl = scenarioTreeUrl(d);
  const parent = parentLayerIndex(d);
  if (!treeUrl || parent == null) throw new Error("no scenario layers to sample");

  const layers = selectScenarioLayers(await fetchJson(treeUrl, signal), parent);
  if (layers.length === 0) return { layers, values: new Map() };

  const url = identifyUrl(d, layers.map((l) => l.id));
  if (!url) return { layers, values: new Map() };
  return { layers, values: parseIdentifyValues(await fetchJson(url, signal)) };
}

function abortInflight(id: string): void {
  inflight.get(id)?.controller.abort();
  inflight.delete(id);
}

/** Load (and memoise) one variable's series. Concurrent loads of the same id
 * share one pair of requests; a failed load is never cached, so Retry really
 * retries. Bounded by SAMPLE_TIMEOUT_MS so a stalled service always eventually
 * reaches the error state. */
function loadSeries(d: Dataset, refresh = false): Promise<ChartSeries> {
  if (refresh) {
    seriesCache.delete(d.id);
    abortInflight(d.id);
  }
  const cached = seriesCache.get(d.id);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(d.id);
  if (existing) return existing.promise;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Timed out", "AbortError")),
    SAMPLE_TIMEOUT_MS,
  );
  const request = sample(d, controller.signal)
    .then((series) => {
      clearTimeout(timer);
      seriesCache.set(d.id, series);
      inflight.delete(d.id);
      return series;
    })
    .catch((error) => {
      clearTimeout(timer);
      inflight.delete(d.id);
      throw error;
    });
  inflight.set(d.id, { promise: request, controller });
  return request;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** The sample point, written the way a map reads it. */
function coordText(): string {
  const { lat, lon } = SAMPLE_POINT;
  return `${Math.abs(lat).toFixed(3)}°S ${Math.abs(lon).toFixed(3)}°E`;
}

/** Skeleton shapes that match what replaces them: a readout block at the size
 * of the peak readout, then bars standing on the same baseline the real chart
 * draws, at the heights a projection series actually makes. Never a spinner,
 * never a blank flash. */
function chartSkeleton(): string {
  const heights = [38, 52, 61, 74, 58, 79, 96, 112];
  return `<div class="clm__skeleton" aria-hidden="true">
      <span class="cskel cskel--readout"></span>
      <div class="clm__skelbars">
        ${heights.map((h) => `<span class="cskel cskel--bar" style="height:${h}px"></span>`).join("")}
      </div>
      <span class="cskel cskel--axis"></span>
    </div>`;
}

/** The chart itself: one `<g>` per scenario standing on a dashed zero line,
 * each with a `<title>` tooltip, and the whole series described in words on the
 * `<svg>`'s aria-label for anyone who can't see the bars. Exported (unlike the
 * rest of the markup here) because it is a pure string builder — src/charts
 * .test.ts asserts the drawn geometry and labelling through it without needing
 * a DOM. */
export function chartHtml(model: ChartModel): string {
  const geometry = chartGeometry(model.points.map((p) => p.value));
  const { plot, baselineY, ticks } = geometry;
  const bars = geometry.bars
    .map((bar, i) => {
      const point = model.points[i]!;
      const tooltip = `${point.label}: ${point.text}`;
      return `<g class="clm__barg${bar.negative ? " clm__barg--down" : ""}" style="--i:${i}">
        <title>${escapeHtml(tooltip)}</title>
        <rect class="clm__hit" x="${round(bar.center - geometry.slot / 2)}" y="${plot.y}" width="${geometry.slot}" height="${plot.height}"></rect>
        <rect class="clm__bar" x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" rx="3"></rect>
        <text class="clm__value" x="${bar.center}" y="${bar.labelY}" text-anchor="middle">${escapeHtml(point.text)}</text>
        <text class="clm__tick" x="${bar.center}" y="${ticks.y1}" text-anchor="middle">${escapeHtml(point.primary)}</text>
        ${
          point.secondary
            ? `<text class="clm__tick clm__tick--2" x="${bar.center}" y="${ticks.y2}" text-anchor="middle">${escapeHtml(point.secondary)}</text>`
            : ""
        }
      </g>`;
    })
    .join("");

  // The series is ordered by time horizon, so a hairline wherever the horizon
  // changes turns eight bars into two readable blocks ("what 2040 looks like"
  // vs "what 2090 looks like") without a legend.
  const splits = geometry.bars
    .map((bar, i) => {
      const previous = model.points[i - 1];
      const point = model.points[i]!;
      if (!previous || !point.secondary || previous.secondary === point.secondary) return "";
      const x = round(bar.center - geometry.slot / 2);
      return `<line class="clm__split" x1="${x}" y1="${plot.y}" x2="${x}" y2="${ticks.y2 + 4}"></line>`;
    })
    .join("");

  return `<figure class="clm__figure">
      <div class="clm__scroll">
        <svg class="clm__chart" viewBox="0 0 ${geometry.width} ${geometry.height}" style="min-width:${geometry.width}px"
             role="img" aria-label="${escapeHtml(model.summary)}" preserveAspectRatio="xMidYMid meet">
          ${splits}
          <line class="clm__zero" x1="${plot.x - 8}" y1="${baselineY}" x2="${plot.x + plot.width}" y2="${baselineY}"></line>
          <text class="clm__zerolabel" x="${plot.x - 12}" y="${round(baselineY + 3.5)}" text-anchor="end">0</text>
          ${bars}
        </svg>
      </div>
      <figcaption class="clm__caption">
        ${ICON_PIN}<span>Each bar samples that scenario's raster at ${escapeHtml(SAMPLE_POINT.label)} — <span class="clm__coord">${coordText()}</span>${
          model.skipped > 0
            ? ` · <span class="clm__skip">${model.skipped} scenario ${model.skipped === 1 ? "layer" : "layers"} returned no value here</span>`
            : ""
        }</span>
      </figcaption>
    </figure>`;
}

function readoutHtml(model: ChartModel): string {
  const peak = model.peak;
  if (!peak) return "";
  const rest = [peak.primary, peak.secondary].filter(Boolean).join(" · ");
  return `<p class="clm__readout">
      <span class="clm__peak">${escapeHtml(peak.text)}</span>
      <span class="clm__sep"></span>
      <span class="clm__peaklabel">strongest projected change<span class="clm__peakscenario">${escapeHtml(rest)}</span></span>
      <span class="clm__n">${model.points.length}<span class="clm__unit">scenarios</span></span>
    </p>`;
}

function readyHtml(model: ChartModel): string {
  return `<div class="clm__result">
      ${readoutHtml(model)}
      ${chartHtml(model)}
    </div>`;
}

function noteHtml(kind: "empty" | "nodata" | "error", title: string, body: string): string {
  return `<div class="clm__note clm__note--${kind}">
      <p class="clm__notetitle">${ICON_ALERT}<span>${escapeHtml(title)}</span></p>
      <p class="clm__notebody">${escapeHtml(body)}</p>
    </div>`;
}

function panelHtml(d: Dataset, unit: Unit): string {
  return `<section class="clm" data-status="loading" data-id="${escapeHtml(d.id)}">
    <span class="clm__rail" aria-hidden="true"></span>
    <header class="clm__head">
      <div class="clm__ident">
        <p class="clm__label">${ICON_CHART}<span>Projected change · modelled scenarios</span></p>
        <h2 class="clm__title">${escapeHtml(label(d))}</h2>
      </div>
      <div class="clm__aside">
        ${unit.phrase ? `<span class="clm__unitchip">${escapeHtml(unit.phrase)}</span>` : ""}
        <button type="button" class="clm__retry" data-action="resample" hidden>${ICON_RETRY}<span>Retry</span></button>
      </div>
    </header>
    <div class="clm__stage"></div>
    <p class="sr-only" role="status" aria-live="polite"></p>
  </section>`;
}

interface ChartView {
  root: HTMLElement;
  id: string | undefined;
  dataset: Dataset | null;
  panel: HTMLElement | null;
  stage: HTMLElement | null;
  retry: HTMLButtonElement | null;
  live: HTMLElement | null;
}

let view: ChartView | null = null;
/** Bumped on every load, so a response for a dataset the user has already
 * navigated away from is dropped instead of painting the wrong bars. */
let loadToken = 0;

function setStatus(status: "loading" | "ready" | "empty" | "error", html: string): void {
  if (!view?.panel || !view.stage) return;
  view.panel.dataset.status = status;
  view.stage.innerHTML = html;
  if (view.retry) view.retry.hidden = status === "loading";
}

function announce(text: string): void {
  if (view?.live) view.live.textContent = text;
}

function startLoad(d: Dataset, refresh = false): void {
  const token = ++loadToken;
  setStatus("loading", chartSkeleton());
  announce(`Sampling the modelled climate scenarios for ${label(d)} at ${SAMPLE_POINT.label}…`);
  void loadSeries(d, refresh)
    .then((series) => {
      if (token !== loadToken || view?.id !== d.id) return;
      const model = buildChartModel(d, series.layers, series.values);
      if (model.total === 0) {
        setStatus(
          "empty",
          noteHtml(
            "empty",
            "No chartable scenario layers",
            "This variable's group layer on the service exposes no scenario sub-layers, so there is no projection series to chart.",
          ),
        );
        announce(`${label(d)} has no chartable scenario layers.`);
        return;
      }
      if (model.points.length === 0) {
        setStatus(
          "empty",
          noteHtml(
            "nodata",
            "No modelled value at this point",
            `All ${model.total} scenario ${model.total === 1 ? "layer" : "layers"} returned NoData at ${SAMPLE_POINT.label}, so there is nothing to plot. The rasters cover the wider region — the modelled grid simply has no cell here.`,
          ),
        );
        announce(model.summary);
        return;
      }
      setStatus("ready", readyHtml(model));
      announce(model.summary);
    })
    .catch((error) => {
      if (token !== loadToken || view?.id !== d.id) return;
      const message = errorText(error);
      setStatus(
        "error",
        noteHtml(
          "error",
          "The climate service did not answer",
          `${message}. This is Greater Wellington's own live ArcGIS endpoint — occasionally slow, briefly offline, or unreachable from this network. The dataset record above is unaffected.`,
        ),
      );
      announce(`The climate projections for ${label(d)} could not be loaded: ${message}.`);
    });
}

const wiredRoots = new WeakSet<HTMLElement>();

/** One delegated listener per mount: the panel's innerHTML is replaced
 * wholesale on every selection change, so per-element listeners would be
 * rebound (and leaked) on every climate dataset visited in a session. */
function wireRoot(root: HTMLElement): void {
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);
  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action='resample']");
    if (target && view?.dataset) startLoad(view.dataset, true);
  });
}

/** The FeatureModule registered against `#charts-root` in src/main.ts. Called
 * once at boot and again on every route change; anything other than a change of
 * selected dataset is a no-op, so a theme/search/layer change never rebuilds
 * this panel (which would restart its mount animation and re-run a sample that
 * has already landed). */
export default function renderCharts(root: HTMLElement, state: RouteState): void {
  if (typeof document === "undefined") return;
  wireRoot(root);

  const id = state.dataset;
  if (view && view.root === root && view.id === id) return;

  // Navigating away from a variable whose sample hadn't settled yet: cancel the
  // in-flight requests rather than leaving them running for a selection nobody
  // is looking at anymore.
  if (view?.id && view.id !== id) abortInflight(view.id);

  const dataset = id ? findById(id) ?? null : null;
  const decision = chartDecision(state, dataset);
  if (!decision.show || !dataset) {
    root.innerHTML = "";
    root.hidden = true;
    view = { root, id, dataset: null, panel: null, stage: null, retry: null, live: null };
    return;
  }

  root.hidden = false;
  root.innerHTML = panelHtml(dataset, unitFromDescription(dataset.description));
  view = {
    root,
    id,
    dataset,
    panel: root.querySelector<HTMLElement>(".clm"),
    stage: root.querySelector<HTMLElement>(".clm__stage"),
    retry: root.querySelector<HTMLButtonElement>(".clm__retry"),
    live: root.querySelector<HTMLElement>(".sr-only"),
  };
  startLoad(dataset);
}
