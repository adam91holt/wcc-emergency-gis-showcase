// The dataset dossier: the selected dataset's full catalogue record plus a
// live probe of its ArcGIS REST layer (geometry, feature count, fields).
//
// Registered against `#detail-root` from src/main.ts (`registerMount("detail",
// renderDetail)`) — this module never imports main.ts, see the FeatureModule
// doc there for why that direction matters.
//
// Split the same way src/filters.ts is:
//   - pure functions (URL building, ArcGIS JSON parsing, HTML serialisation,
//     and the preview controller's stale-response logic) with no `document`/
//     `window`/`fetch` reference of their own, so detail.test.ts exercises
//     them directly in this repo's DOM-less node test environment;
//   - a thin DOM layer at the bottom that only owns element identity, event
//     delegation and which subtree gets repainted.
import "./detail.css";
import { findById, label, type Dataset } from "./catalogue";
import { selectDataset } from "./filters";
import type { RouteState } from "./router";

// ---------------------------------------------------------------------------
// Layer endpoints
// ---------------------------------------------------------------------------

/** The layer index to probe, using the same fallback order (and for the same
 * reasons) as catalogue.layerQueryUrl: `resolved_layer` is the upstream-
 * resolved, already-correct index; `default_child` is the documented sibling
 * to use when this row's own service/layer_id is a non-queryable group; only
 * then does the raw `layer_id` apply. */
export function resolvedLayerIndex(d: Dataset): number | null {
  return d.resolved_layer ?? d.default_child ?? d.layer_id ?? null;
}

/** `<service_root>/<layer>?f=json` — the layer's own metadata document
 * (geometry type, field list, layer type). Null for exactly the datasets
 * catalogue.layerQueryUrl returns null for: not feature-queryable, no service
 * root, or no usable layer index. */
export function layerInfoUrl(d: Dataset): string | null {
  if (!d.feature_queryable || !d.service_root) return null;
  const layer = resolvedLayerIndex(d);
  if (layer == null) return null;
  return `${d.service_root}/${layer}?f=json`;
}

/** The cheap `returnCountOnly` query — a feature count without dragging a
 * single geometry over the wire. Null under the same conditions as
 * layerInfoUrl. */
export function layerCountUrl(d: Dataset): string | null {
  if (!d.feature_queryable || !d.service_root) return null;
  const layer = resolvedLayerIndex(d);
  if (layer == null) return null;
  return `${d.service_root}/${layer}/query?where=1%3D1&returnCountOnly=true&f=json`;
}

// ---------------------------------------------------------------------------
// ArcGIS response parsing
// ---------------------------------------------------------------------------

export interface LayerField {
  name: string;
  alias: string | null;
  type: string | null;
}

export interface LayerInfo {
  name: string | null;
  geometryType: string | null;
  layerType: string | null;
  fields: LayerField[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** ArcGIS REST reports service-side failures as HTTP 200 with an `error`
 * object, so a "successful" response still has to be checked for one. Returns
 * the service's own message, or null when the payload isn't an error. */
export function arcgisError(json: unknown): string | null {
  if (!isRecord(json) || !isRecord(json.error)) return null;
  const message = str(json.error.message) ?? "Unknown service error";
  const code = typeof json.error.code === "number" ? ` (${json.error.code})` : "";
  return `${message}${code}`;
}

/** Read an ArcGIS layer metadata document. Returns null for anything that
 * isn't recognisably layer metadata (null, a string, an array, an error
 * payload, an empty object) so a malformed response becomes a visible error
 * state rather than a panel full of blanks. */
export function parseLayerInfo(json: unknown): LayerInfo | null {
  if (!isRecord(json) || arcgisError(json)) return null;
  const rawFields = Array.isArray(json.fields) ? json.fields : null;
  const name = str(json.name);
  const geometryType = str(json.geometryType);
  const layerType = str(json.type);
  if (!rawFields && !name && !geometryType) return null;

  const fields: LayerField[] = [];
  for (const raw of rawFields ?? []) {
    if (!isRecord(raw)) continue;
    const fieldName = str(raw.name);
    if (!fieldName) continue;
    fields.push({ name: fieldName, alias: str(raw.alias), type: str(raw.type) });
  }
  return { name, geometryType, layerType, fields };
}

/** Read a `returnCountOnly=true` response. Null (rather than 0) when the
 * service didn't send a usable count — "unknown" and "empty layer" are
 * different facts and the panel says so. */
export function parseFeatureCount(json: unknown): number | null {
  if (!isRecord(json)) return null;
  const count = json.count;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
  return Math.trunc(count);
}

const GEOMETRY_LABEL: Record<string, string> = {
  esriGeometryPoint: "Point",
  esriGeometryMultipoint: "Multipoint",
  esriGeometryPolyline: "Polyline",
  esriGeometryPolygon: "Polygon",
  esriGeometryEnvelope: "Envelope",
};

/** `esriGeometryPolygon` → `Polygon`; unknown values are shown as-is minus
 * the vendor prefix rather than hidden. */
export function geometryLabel(geometryType: string | null): string {
  if (!geometryType) return EM_DASH;
  return GEOMETRY_LABEL[geometryType] ?? geometryType.replace(/^esriGeometry/, "");
}

/** Grouped by thousands without depending on the host's ICU data, so the
 * readout is identical in the browser and under vitest. */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---------------------------------------------------------------------------
// Fetching — injectable, so tests never touch the network
// ---------------------------------------------------------------------------

/** The slice of `Response` this module actually uses. Structural on purpose:
 * `globalThis.fetch` satisfies it, and so does a three-line test double. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

const PREVIEW_TIMEOUT_MS = 8000;

/** Resolved lazily (not captured at module load) so importing this module in
 * an environment without `fetch` is harmless — the failure only happens if a
 * probe is actually attempted, and it surfaces as the panel's error state. */
const defaultFetch: FetchLike = (url, init) => {
  const impl = globalThis.fetch;
  if (typeof impl !== "function") return Promise.reject(new Error("fetch is unavailable"));
  return impl(url, init);
};

function timeoutError(): Error {
  return Object.assign(new Error("The layer service did not respond in time."), { name: "TimeoutError" });
}

/** A request-scoped timeout signal, plus the teardown for it. Prefers the
 * native `AbortSignal.timeout` (self-clearing); on a runtime that lacks it
 * (older Node, older Safari), falls back to a manual `AbortController` +
 * `setTimeout` so the 8s ceiling still holds — otherwise a hanging request
 * would never resolve on such a runtime, leaving the panel's loading
 * skeleton on screen forever. The timer is `unref`'d and always cleared by
 * the caller once the request settles, so it can't keep a Node process (or a
 * test) alive past the request it belongs to. */
function withTimeout(): { signal: AbortSignal | undefined; clear: () => void } {
  const ctor = globalThis.AbortSignal;
  if (ctor && typeof ctor.timeout === "function") {
    return { signal: ctor.timeout(PREVIEW_TIMEOUT_MS), clear: () => {} };
  }
  const ControllerCtor = globalThis.AbortController;
  if (!ControllerCtor) return { signal: undefined, clear: () => {} };
  const controller = new ControllerCtor();
  const timer = setTimeout(() => controller.abort(timeoutError()), PREVIEW_TIMEOUT_MS);
  const unrefable = timer as unknown as { unref?: () => void };
  unrefable.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const { signal, clear } = withTimeout();
  try {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clear();
  }
}

/** Turn whatever the fetch layer threw into one sentence a non-developer can
 * act on. */
export function describeFetchError(err: unknown): string {
  const name = isRecord(err) ? err.name : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return "The layer service did not respond in time.";
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/^HTTP \d+$/.test(message)) return `The layer service returned ${message}.`;
  return "Could not reach the layer service — it may be offline or blocking this browser.";
}

export type PreviewState =
  | { status: "idle" }
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "ready"; info: LayerInfo; count: number | null }
  | { status: "error"; message: string };

/** Probe a dataset's layer: metadata first, then (once it's back) the feature
 * count — deliberately sequential, not parallel, so a metadata failure skips
 * the count round-trip entirely rather than racing a request whose result
 * would just be discarded. The count is best-effort (some services publish
 * layer metadata but reject `query`), so a failed count degrades to "unknown"
 * while the rest of the preview still renders; a failed metadata request is
 * the error state. */
export async function fetchLayerPreview(
  d: Dataset,
  fetchImpl: FetchLike = defaultFetch,
): Promise<PreviewState> {
  const infoUrl = layerInfoUrl(d);
  if (!infoUrl) return { status: "unavailable" };
  const countUrl = layerCountUrl(d);

  let infoJson: unknown;
  try {
    infoJson = await getJson(fetchImpl, infoUrl);
  } catch (err) {
    return { status: "error", message: describeFetchError(err) };
  }

  const serviceError = arcgisError(infoJson);
  if (serviceError) return { status: "error", message: `The layer service refused the request: ${serviceError}` };

  const info = parseLayerInfo(infoJson);
  if (!info) {
    return { status: "error", message: "The layer responded, but not with layer metadata this panel can read." };
  }

  let count: number | null = null;
  if (countUrl) {
    try {
      count = parseFeatureCount(await getJson(fetchImpl, countUrl));
    } catch {
      count = null;
    }
  }
  return { status: "ready", info, count };
}

/** Whether a paint issued for dataset `id` still belongs on screen, given the
 * dataset currently selected. Compared against the selected *dataset*, not the
 * id in the URL: an unknown deep-linked id selects no dataset, and its
 * "no such dataset" paint carries `undefined` — matching on the raw URL id
 * would suppress it and leave the previous panel on screen. */
export function isCurrentPaint(id: string | undefined, selected: Dataset | undefined): boolean {
  return id === selected?.id;
}

export interface PreviewController {
  /** Start (or clear) a probe for a dataset. Paints a synchronous
   * loading/unavailable/idle state immediately, then the resolved state. */
  select(d: Dataset | undefined): void;
  /** The most recently painted state — the panel's source of truth for a
   * repaint that isn't driven by a probe. */
  state(): PreviewState;
}

/** Owns the one piece of genuinely asynchronous state in this module, and the
 * stale-response guard that goes with it: every probe records the dataset id
 * *and* a generation counter it was started for, and a response whose id or
 * generation no longer matches the latest select() call is dropped without
 * painting. The id alone isn't enough — an A → B → A sequence reselects the
 * same id, so an id-only check would let A's first (now-stale) probe paint
 * over the second, current one if it happens to resolve later. The
 * generation counter distinguishes those two probes even though they share
 * an id. Without either half of this guard, clicking through cards faster
 * than the services answer could paint stale geometry under the wrong (or a
 * since-superseded) dataset's title. */
export function createPreviewController(
  paint: (id: string | undefined, state: PreviewState) => void,
  fetchImpl: FetchLike = defaultFetch,
): PreviewController {
  let activeId: string | undefined;
  let activeGeneration = 0;
  let current: PreviewState = { status: "idle" };

  const settle = (id: string, generation: number, next: PreviewState): void => {
    // stale: this dataset is no longer selected, or a newer probe for the
    // same dataset has since started.
    if (activeId !== id || activeGeneration !== generation) return;
    current = next;
    paint(id, next);
  };

  return {
    state: () => current,
    select(d) {
      activeGeneration += 1;
      const generation = activeGeneration;
      activeId = d?.id;
      if (!d) {
        current = { status: "idle" };
        paint(undefined, current);
        return;
      }
      current = layerInfoUrl(d) ? { status: "loading" } : { status: "unavailable" };
      paint(d.id, current);
      if (current.status !== "loading") return;
      const id = d.id;
      void fetchLayerPreview(d, fetchImpl).then(
        (next) => settle(id, generation, next),
        (err) => settle(id, generation, { status: "error", message: describeFetchError(err) }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Icon set — the same family as the discovery console: one 16px grid, solid
// paths in currentColor. No second icon library, no emoji.
// ---------------------------------------------------------------------------

function svg(path: string, size = 14): string {
  return `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="${path}" fill="currentColor"/></svg>`;
}

const ICON_CLOSE = svg(
  "M3.3 3.3a1 1 0 0 1 1.4 0L8 6.6l3.3-3.3a1 1 0 1 1 1.4 1.4L9.4 8l3.3 3.3a1 1 0 0 1-1.4 1.4L8 9.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L6.6 8 3.3 4.7a1 1 0 0 1 0-1.4Z",
  12,
);
const ICON_EXTERNAL = svg(
  "M9 2a1 1 0 0 0 0 2h1.59L6.3 8.29a1 1 0 1 0 1.42 1.42L12 5.41V7a1 1 0 1 0 2 0V3a1 1 0 0 0-1-1H9ZM3 4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3a1 1 0 1 0-2 0v2H4V6h2a1 1 0 0 0 0-2H3Z",
  12,
);
const ICON_ALERT = svg(
  "M7.13 2.5a1 1 0 0 1 1.74 0l5.13 9a1 1 0 0 1-.87 1.5H2.87a1 1 0 0 1-.87-1.5l5.13-9ZM8 5.5a.9.9 0 0 0-.9.98l.25 2.6a.65.65 0 0 0 1.3 0l.25-2.6A.9.9 0 0 0 8 5.5Zm0 5a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z",
  13,
);
const ICON_INFO = svg(
  "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 2.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM6.9 7.1h1.6a.7.7 0 0 1 .7.7v3.1h.6a.65.65 0 0 1 0 1.3H6.6a.65.65 0 0 1 0-1.3h.9V8.4h-.6a.65.65 0 0 1 0-1.3Z",
  13,
);
const ICON_RETRY = svg(
  "M8 2a6 6 0 1 0 5.65 8 1 1 0 1 0-1.88-.67A4 4 0 1 1 8 4a3.96 3.96 0 0 1 2.6.98L9.3 6.29A.7.7 0 0 0 9.8 7.5H13a1 1 0 0 0 1-1V3.3a.7.7 0 0 0-1.2-.5l-.79.79A5.97 5.97 0 0 0 8 2Z",
  13,
);
const ICON_LAYERS = svg(
  "M7.55 1.1a1 1 0 0 1 .9 0l6 3a1 1 0 0 1 0 1.8l-6 3a1 1 0 0 1-.9 0l-6-3a1 1 0 0 1 0-1.8l6-3ZM2.1 8.55l1.6.8L8 11.5l4.3-2.15 1.6-.8a1 1 0 0 1 .9 1.79l-6 3a1 1 0 0 1-.9 0l-6-3a1 1 0 0 1 .9-1.79Z",
  13,
);

// ---------------------------------------------------------------------------
// HTML — pure serialisation, no DOM APIs, so every state is unit-testable
// ---------------------------------------------------------------------------

const EM_DASH = "—";
const MAX_FIELDS = 10;

const SCOPE_LABEL: Record<Dataset["scope"], string> = {
  wcc: "WCC",
  regional: "Regional",
  national: "National",
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Catalogue text is upstream-owned prose (ampersands, quotes, angle
 * brackets) that is written into innerHTML — escape every interpolation. */
function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Only ever emit an http(s) href, so a hostile/odd `url` in the data can't
 * become a `javascript:` link. */
function safeHref(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** The source button's label, matched to what it actually opens. "Open
 * source layer" is only true for `arcgis_rest` datasets — a portal item or a
 * plain web source isn't a layer, and a button that claims otherwise
 * contradicts the metadata sitting right above it (and, for a non-queryable
 * dataset, the probe's own "no live preview" note below it). */
export function sourceCtaLabel(linkType: Dataset["link_type"]): string {
  switch (linkType) {
    case "arcgis_rest":
      return "Open source layer";
    case "arcgis_portal":
      return "Open portal item";
    case "web":
    default:
      return "Open source";
  }
}

function value(text: string | null | undefined): string {
  const trimmed = text?.trim();
  return trimmed ? esc(trimmed) : `<span class="dossier__nil">${EM_DASH}</span>`;
}

function specRow(term: string, html: string, mono = true): string {
  return `<div class="spec__row">
      <dt class="spec__key">${esc(term)}</dt>
      <dd class="spec__val${mono ? " spec__val--mono" : ""}">${html}</dd>
    </div>`;
}

function statusChip(status: PreviewState["status"], text: string): string {
  return `<span class="probe__status" data-status="${status}">
      <span class="probe__led" aria-hidden="true"></span>${esc(text)}
    </span>`;
}

function probeHead(status: PreviewState["status"], text: string): string {
  return `<div class="probe__head">
      <p class="probe__label">${ICON_LAYERS}<span>Live layer probe</span></p>
      ${statusChip(status, text)}
    </div>`;
}

/** Skeleton shapes that match the readout/spec/field-chip geometry they are
 * about to be replaced by — never a spinner, never a blank gap. */
const SKELETON_FIELD_WIDTHS = [76, 108, 62, 94, 130, 70, 116, 88];

function probeSkeleton(): string {
  return `<div class="probe__body">
      <span class="dsk dsk--readout" aria-hidden="true"></span>
      <dl class="spec spec--probe">
        <div class="spec__row"><dt class="spec__key">Geometry</dt><dd class="spec__val"><span class="dsk dsk--val" aria-hidden="true"></span></dd></div>
        <div class="spec__row"><dt class="spec__key">Layer</dt><dd class="spec__val"><span class="dsk dsk--val dsk--wide" aria-hidden="true"></span></dd></div>
      </dl>
      <div class="probe__fields">
        ${SKELETON_FIELD_WIDTHS.map((w) => `<span class="dsk dsk--field" style="width:${w}px" aria-hidden="true"></span>`).join("")}
      </div>
    </div>`;
}

function fieldChips(fields: LayerField[]): string {
  if (fields.length === 0) {
    return `<p class="probe__note">${ICON_INFO}<span>This layer publishes no attribute fields.</span></p>`;
  }
  const shown = fields.slice(0, MAX_FIELDS);
  const rest = fields.length - shown.length;
  const chips = shown
    .map((f) => {
      const title = f.alias && f.alias !== f.name ? ` title="${esc(f.alias)}"` : "";
      return `<span class="fld"${title}>${esc(f.name)}</span>`;
    })
    .join("");
  const more = rest > 0 ? `<span class="fld fld--more">+${rest} more</span>` : "";
  return `<div class="probe__fields">${chips}${more}</div>`;
}

/** The probe subtree on its own: the panel swaps just this block as a probe
 * resolves, so the dossier around it keeps its element identity (and the
 * user's focus). */
export function probeHtml(d: Dataset, preview: PreviewState): string {
  switch (preview.status) {
    case "loading":
      return `${probeHead("loading", "Probing")}${probeSkeleton()}
        <p class="sr-only" role="status">Probing the live layer for ${esc(label(d))}…</p>`;

    case "ready": {
      const { info, count } = preview;
      const readout =
        count === null
          ? `<span class="probe__count probe__count--nil">${EM_DASH}</span><span class="probe__unit">count unavailable</span>`
          : `<span class="probe__count">${formatCount(count)}</span><span class="probe__unit">${count === 1 ? "feature" : "features"}</span>`;
      return `${probeHead("ready", "Online")}
        <div class="probe__body">
          <p class="probe__readout">${readout}</p>
          <dl class="spec spec--probe">
            ${specRow("Geometry", esc(geometryLabel(info.geometryType)))}
            ${specRow("Layer", value(info.name))}
            ${specRow("Kind", value(info.layerType))}
            ${specRow("Fields", `${info.fields.length}`)}
          </dl>
          ${fieldChips(info.fields)}
        </div>
        <p class="sr-only" role="status">Live layer online: ${esc(geometryLabel(info.geometryType))} geometry, ${
          count === null ? "feature count unavailable" : `${formatCount(count)} ${count === 1 ? "feature" : "features"}`
        }, ${info.fields.length} fields.</p>`;
    }

    case "error":
      return `${probeHead("error", "Unreachable")}
        <div class="probe__body">
          <p class="probe__error">${ICON_ALERT}<span>${esc(preview.message)}</span></p>
          <button type="button" class="btn-probe" data-action="detail-retry">${ICON_RETRY}<span>Probe again</span></button>
        </div>
        <p class="sr-only" role="status">Live layer probe failed: ${esc(preview.message)}</p>`;

    // `idle` is not reachable through the controller with a defined dataset
    // (select() only ever paints `idle` alongside no dataset, and detailHtml
    // skips this subtree entirely when there's no dataset) — but probeHtml is
    // an exported, independently unit-testable function per the ticket, so a
    // direct `probeHtml(d, { status: "idle" })` call is a legal invocation.
    // Render nothing rather than folding it into "unavailable": that status
    // is a specific, factual claim (this dataset isn't feature-queryable)
    // that isn't true just because no probe has run yet.
    case "idle":
      return "";

    case "unavailable":
    default:
      return `${probeHead("unavailable", "No live layer")}
        <div class="probe__body">
          <p class="probe__note">${ICON_INFO}<span>This dataset points at ${
            d.link_type === "arcgis_portal" ? "a portal item" : d.raster_only ? "a raster-only service" : "a source"
          } rather than a queryable feature layer, so no live preview is available. The source link above opens it at the publisher.</span></p>
        </div>`;
  }
}

function emptyHtml(requestedId?: string): string {
  const unknown = Boolean(requestedId);
  return `<section class="dossier dossier--empty" data-dossier="">
      <span class="dossier__rail" aria-hidden="true"></span>
      <p class="dossier__eyebrow">Dataset dossier</p>
      ${
        unknown
          ? `<p class="dossier__lede">No dataset in this catalogue has the id <code class="dossier__code">${esc(requestedId)}</code>.</p>
             <p class="dossier__hint">The link may be out of date. Pick any dataset below to open its record.</p>
             <button type="button" class="btn-probe" data-action="detail-close">${ICON_RETRY}<span>Clear selection</span></button>`
          : `<p class="dossier__lede">Nothing selected yet.</p>
             <p class="dossier__hint">Choose a dataset — click a card, or hit <kbd>/</kbd> and press <kbd>Enter</kbd> on a search result — to read its full record here and probe its live ArcGIS layer for geometry, feature count and fields.</p>`
      }
    </section>`;
}

/** The whole panel for a given selection + probe state. `requestedId` is the
 * id from the URL, used only to tell "nothing selected" apart from "that
 * deep link names a dataset this catalogue doesn't have". */
export function detailHtml(
  d: Dataset | undefined,
  preview: PreviewState,
  requestedId?: string,
): string {
  if (!d) return emptyHtml(requestedId);

  const href = safeHref(d.url);
  const source = href
    ? `<a class="dossier__source" href="${esc(href)}" target="_blank" rel="noreferrer">${ICON_EXTERNAL}<span>${esc(sourceCtaLabel(d.link_type))}</span></a>`
    : `<p class="dossier__note">${ICON_INFO}<span>No public source link in the catalogue for this dataset.</span></p>`;

  return `<section class="dossier" data-dossier="${esc(d.id)}">
      <span class="dossier__rail" aria-hidden="true"></span>
      <header class="dossier__head">
        <div class="dossier__ident">
          <p class="dossier__eyebrow">
            <span class="dossier__scope" data-scope="${esc(d.scope)}">${esc(SCOPE_LABEL[d.scope])}</span>
            <span>${value(d.theme_label)}</span>
          </p>
          <h2 class="dossier__title">${esc(label(d))}</h2>
          <p class="dossier__code">${esc(d.id)}</p>
        </div>
        <button type="button" class="dossier__close" data-action="detail-close" aria-label="Close dataset detail">
          ${ICON_CLOSE}
        </button>
      </header>
      <p class="dossier__desc">${value(d.description)}</p>
      <dl class="spec">
        ${specRow("Theme", value(d.theme_label), false)}
        ${specRow("Scope", esc(SCOPE_LABEL[d.scope]), false)}
        ${specRow("Authority", value(d.authority), false)}
        ${specRow("Year", value(d.year))}
        ${specRow("Coverage", value(d.coverage), false)}
        ${specRow("Service", value(d.host ?? null))}
      </dl>
      ${source}
      <div class="probe" data-probe>${probeHtml(d, preview)}</div>
    </section>`;
}

// ---------------------------------------------------------------------------
// DOM layer — element identity, event delegation, repaint scope
// ---------------------------------------------------------------------------

let currentRoot: HTMLElement | null = null;
let currentId: string | undefined;
let currentDataset: Dataset | undefined;
let hasRenderedOnce = false;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** #detail-root sits above the catalogue in index.html, so a card click deep
 * in a long, scrolled list renders the dossier *above* the viewport while
 * main.ts's own highlightSelection scrolls the clicked *card* into view
 * instead — the panel this ticket exists to show never becomes visible.
 * Bring the dossier itself into view on every user-driven selection change
 * (see the `hasRenderedOnce`/id-changed guard at the call site, which skips
 * this on first mount so a fresh deep link doesn't force an unnecessary
 * jump). Smooth by default, instant under prefers-reduced-motion — same
 * rule main.ts's card-scroll follows. */
function scrollDetailIntoView(root: HTMLElement): void {
  root.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

/** Repaint. `id` is the dataset the paint is *for* — compared against the
 * selected dataset (not the requested id, which may name a dataset that isn't
 * in the catalogue) so a late probe can never paint over a newer selection.
 * When the dossier on screen is already this dataset's, only the probe subtree
 * is rewritten — a full innerHTML swap would restart the panel's mount
 * animation and drop focus off the close button mid-probe. */
function paint(id: string | undefined, preview: PreviewState): void {
  if (!currentRoot || !isCurrentPaint(id, currentDataset)) return;
  const probe = currentRoot.querySelector<HTMLElement>("[data-probe]");
  const panel = currentRoot.querySelector<HTMLElement>("[data-dossier]");
  if (currentDataset && probe && panel?.dataset.dossier === currentDataset.id) {
    probe.innerHTML = probeHtml(currentDataset, preview);
    return;
  }
  currentRoot.innerHTML = detailHtml(currentDataset, preview, currentId);
}

const controller = createPreviewController(paint);

const wiredRoots = new WeakSet<HTMLElement>();

function wireRoot(root: HTMLElement): void {
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);
  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    if (target.dataset.action === "detail-close") selectDataset(undefined);
    else if (target.dataset.action === "detail-retry" && currentDataset) controller.select(currentDataset);
  });
}

/** The FeatureModule this ticket registers against `#detail-root` (see
 * src/main.ts's registerMount). Called at boot with the deep-linked state and
 * again on every route change; a change that doesn't touch the selection
 * (theme/scope/query) is a no-op here, so filtering never re-probes the
 * layer or restarts the panel's animation. */
export default function renderDetail(root: HTMLElement, state: RouteState): void {
  wireRoot(root);
  const id = state.dataset;
  if (root === currentRoot && id === currentId) return;
  const previousId = currentId;
  const isFirstRender = !hasRenderedOnce;
  hasRenderedOnce = true;
  currentRoot = root;
  currentId = id;
  currentDataset = id ? findById(id) : undefined;
  // select() paints synchronously (loading / unavailable / idle) and again
  // when the probe resolves; an unknown id has no dataset, so it lands on the
  // idle paint and detailHtml renders the "no such dataset" hint.
  controller.select(currentDataset);
  // Only for a genuine, user-driven selection change to a real dataset — not
  // the first render (a fresh deep link is already at the top of the page,
  // nothing to scroll to) and not a close (id -> undefined leaves the reader
  // exactly where they were).
  if (currentDataset && !isFirstRender && id !== previousId) {
    scrollDetailIntoView(root);
  }
}
