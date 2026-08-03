// The dataset dossier: the detail view for whichever catalogue row is
// currently selected (`#dataset=<id>` in the router's hash — a card click,
// Enter in the search combobox, a pasted deep link or Back/Forward all land
// here the same way, because selection lives in the URL and nowhere else).
//
// Two halves, the same split src/map.ts documents at its top:
//   - pure functions (the preview URL builders, the ArcGIS count/fields
//     response parsers, and the metadata-row model for a dataset) with no
//     `document`/`window`/`fetch` reference at all, so src/detail.test.ts
//     exercises them directly in the node test environment;
//   - DOM rendering + the live service probe behind a
//     `typeof document === "undefined"` guard, the same way src/main.ts gates
//     boot(), so importing this module in a test never touches a browser
//     global or issues a request.
//
// This module deliberately imports nothing from main.ts — see the
// FeatureModule doc there for the import-cycle hazard that would create.
import "./detail.css";
import { findById, label, type Dataset } from "./catalogue";
import { selectDataset } from "./filters";
import type { RouteState } from "./router";

// ---------------------------------------------------------------------------
// Pure logic — no DOM, no fetch
// ---------------------------------------------------------------------------

const SCOPE_LABEL: Record<Dataset["scope"], string> = {
  wcc: "WCC",
  regional: "Regional",
  national: "National",
};

/** The layer index to query a dataset's service against. Same fallback order
 * as catalogue.layerQueryUrl (and map.geoJsonQueryUrl): `resolved_layer` is
 * the upstream-resolved, already-correct index; `default_child` is the
 * documented sibling to use when this row's own layer is a non-queryable
 * group; only then does the raw `layer_id` apply. Null when none of the three
 * resolves. */
export function resolveLayerIndex(d: Dataset): number | null {
  return d.resolved_layer ?? d.default_child ?? d.layer_id ?? null;
}

/** The `/query` URL that asks the service for a feature count and nothing
 * else — `returnCountOnly=true` keeps the response to a single integer rather
 * than pulling every geometry down just to length-check it. Null for the same
 * datasets layerQueryUrl returns null for. */
export function featureCountUrl(d: Dataset): string | null {
  if (!d.feature_queryable || !d.service_root) return null;
  const layer = resolveLayerIndex(d);
  if (layer == null) return null;
  return `${d.service_root}/${layer}/query?where=1%3D1&returnCountOnly=true&f=json`;
}

/** The layer's own JSON endpoint — the document that carries the layer name,
 * geometry type and the field list this panel shows. Same guard and same
 * layer-index fallback order as featureCountUrl. */
export function layerFieldsUrl(d: Dataset): string | null {
  if (!d.feature_queryable || !d.service_root) return null;
  const layer = resolveLayerIndex(d);
  if (layer == null) return null;
  return `${d.service_root}/${layer}?f=json`;
}

/** The ArcGIS REST HTML page for the probed layer — the human-readable twin
 * of layerFieldsUrl, offered as a link so a reader can check our numbers
 * against the service itself. */
export function layerPageUrl(d: Dataset): string | null {
  if (!d.feature_queryable || !d.service_root) return null;
  const layer = resolveLayerIndex(d);
  if (layer == null) return null;
  return `${d.service_root}/${layer}`;
}

/** Why this dataset has no live preview, or null when it can be probed. The
 * order matters: a raster row is also `feature_queryable: false`, and "this is
 * imagery" is a far better explanation than "not queryable". */
export function previewUnavailableReason(d: Dataset): string | null {
  if (!d.service_root) {
    return "This record links to a portal or web page rather than an ArcGIS service, so there is nothing to query.";
  }
  if (d.raster_only) {
    return "This is a raster service — imagery, not features — so it has no feature count or field list to read.";
  }
  if (!d.feature_queryable) {
    return "This service's layer is not feature-queryable, so no live preview can be fetched for it.";
  }
  if (resolveLayerIndex(d) == null) {
    return "No layer index resolves on this service, so there is no layer to query.";
  }
  return null;
}

/** An ArcGIS REST error body's message, or null when the body carries no
 * error. ArcGIS reports failures as HTTP 200 with an `error` object, so a
 * status check alone would read a failure as a successful empty response. */
export function serviceErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() !== "" ? message.trim() : "service error";
}

/** The feature count from a `returnCountOnly=true` response, or null when the
 * body is malformed (an error object, a missing/`NaN`/negative count, HTML
 * from a proxy, …) — callers surface that as a failed probe rather than
 * printing a confident zero the service never claimed. */
export function parseFeatureCount(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const count = (body as { count?: unknown }).count;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
  return Math.trunc(count);
}

export interface LayerField {
  name: string;
  alias: string;
  type: string;
}

/** Turn an Esri constant into something readable: strip the
 * `esriFieldType`/`esriGeometry` prefix and split the remaining CamelCase
 * ("esriFieldTypeSmallInteger" → "Small Integer"). Anything that isn't a
 * usable string falls back rather than rendering "undefined". */
export function esriLabel(raw: unknown, fallback = "Unknown"): string {
  if (typeof raw !== "string") return fallback;
  const stripped = raw.replace(/^esri(FieldType|Geometry)/, "").trim();
  if (stripped === "") return fallback;
  return stripped.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** The field list from a layer's JSON endpoint. Entries without a usable name
 * are dropped instead of rendering blank rows; a malformed body yields an
 * empty list rather than throwing. */
export function parseLayerFields(body: unknown): LayerField[] {
  if (typeof body !== "object" || body === null) return [];
  const fields = (body as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  const out: LayerField[] = [];
  for (const entry of fields) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || name.trim() === "") continue;
    const alias = (entry as { alias?: unknown }).alias;
    out.push({
      name: name.trim(),
      alias: typeof alias === "string" && alias.trim() !== "" ? alias.trim() : name.trim(),
      type: esriLabel((entry as { type?: unknown }).type, "Field"),
    });
  }
  return out;
}

export interface LayerInfo {
  /** The layer's own name, as the service reports it (null when absent). */
  name: string | null;
  /** "Polygon", "Polyline", … — null when the layer declares no geometry. */
  geometry: string | null;
  fields: LayerField[];
}

/** The whole layer document, parsed. Never throws: a malformed body simply
 * yields nulls and an empty field list. */
export function parseLayerInfo(body: unknown): LayerInfo {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim() : null;
  const geometry =
    typeof record.geometryType === "string" ? esriLabel(record.geometryType, "Unknown") : null;
  return { name, geometry, fields: parseLayerFields(body) };
}

export interface MetaRow {
  /** Stable key, used as the row's data attribute so CSS/tests can target it. */
  key: string;
  label: string;
  value: string;
  /** Numbers, ids and endpoints render in the mono face. */
  mono: boolean;
  /** True when upstream simply has no value — the row still renders (the
   * dossier's shape must not change from dataset to dataset), dimmed. */
  missing: boolean;
}

function row(key: string, rowLabel: string, value: string | null | undefined, mono = false): MetaRow {
  const text = typeof value === "string" ? value.trim() : "";
  return { key, label: rowLabel, value: text === "" ? "—" : text, mono, missing: text === "" };
}

/** The fixed metadata ladder every dataset renders, in one order, whether or
 * not the upstream row filled each cell in. Absent values become a dimmed
 * "—" rather than a dropped row, so scanning two datasets in a row compares
 * like with like. */
export function metadataRows(d: Dataset): MetaRow[] {
  const layer = resolveLayerIndex(d);
  const service =
    d.server_type == null ? null : layer == null ? d.server_type : `${d.server_type} · layer ${layer}`;
  return [
    row("theme", "Theme", d.theme_label || d.theme),
    row("scope", "Scope", SCOPE_LABEL[d.scope]),
    row("authority", "Authority", d.authority),
    row("year", "Year", d.year, true),
    row("coverage", "Coverage", d.coverage),
    row("layer", "Layer type", d.layer_type),
    row("service", "Service", service, true),
    row("host", "Host", d.host, true),
    row("id", "Catalogue id", d.id, true),
  ];
}

export interface DetailModel {
  id: string;
  title: string;
  themeLabel: string;
  scopeLabel: string;
  /** Trimmed upstream description, or null where there is none (11 of the 67
   * rows) — the panel prints an explicit note in that case rather than
   * leaving a hole. */
  description: string | null;
  year: string | null;
  sourceUrl: string | null;
  /** Host of the source link, the honest label for an external link. */
  sourceHost: string | null;
  rows: MetaRow[];
  /** Whether a live service probe is possible at all. */
  probeable: boolean;
  /** Null when probeable; the explanation to render otherwise. */
  unavailableReason: string | null;
}

/** Everything the panel needs about one dataset, derived in one place so the
 * markup below is a pure projection of it (and so the whole model is unit
 * testable without a DOM). */
export function detailModel(d: Dataset): DetailModel {
  const description = d.description?.trim() || null;
  const url = d.url?.trim() || null;
  const reason = previewUnavailableReason(d);
  return {
    id: d.id,
    title: label(d),
    themeLabel: d.theme_label?.trim() || d.theme?.trim() || "Uncategorised",
    scopeLabel: SCOPE_LABEL[d.scope],
    description,
    year: d.year?.trim() || null,
    sourceUrl: url,
    sourceHost: url ? hostOf(url) : null,
    rows: metadataRows(d),
    probeable: reason === null,
    unavailableReason: reason,
  };
}

/** Host of an absolute URL, or null if it isn't parseable — used for the
 * source link's label, never for a request. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Icon set — same family as src/filters.ts and src/map.ts: solid paths on a
// 16px grid, drawn in currentColor. No second icon library, no emoji.
// ---------------------------------------------------------------------------

function svg(path: string, size = 14): string {
  return `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="${path}" fill="currentColor"/></svg>`;
}

const ICON_CLOSE = svg(
  "M3.3 3.3a1 1 0 0 1 1.4 0L8 6.6l3.3-3.3a1 1 0 1 1 1.4 1.4L9.4 8l3.3 3.3a1 1 0 0 1-1.4 1.4L8 9.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L6.6 8 3.3 4.7a1 1 0 0 1 0-1.4Z",
  12,
);
const ICON_RETRY = svg(
  "M8 2a6 6 0 1 0 5.65 8 1 1 0 1 0-1.88-.67A4 4 0 1 1 8 4a3.96 3.96 0 0 1 2.6.98L9.3 6.29A.7.7 0 0 0 9.8 7.5H13a1 1 0 0 0 1-1V3.3a.7.7 0 0 0-1.2-.5l-.79.79A5.97 5.97 0 0 0 8 2Z",
  12,
);
const ICON_ALERT = svg(
  "M8 1.5a1.2 1.2 0 0 1 1.04.6l6 10.3A1.2 1.2 0 0 1 14 14.2H2a1.2 1.2 0 0 1-1.04-1.8l6-10.3A1.2 1.2 0 0 1 8 1.5Zm0 3.6a.9.9 0 0 0-.9.97l.25 3a.65.65 0 0 0 1.3 0l.25-3A.9.9 0 0 0 8 5.1Zm0 5.4a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Z",
  12,
);
const ICON_EXTERNAL = svg(
  "M9 1a1 1 0 0 0 0 2h2.59L6.29 8.29a1 1 0 0 0 1.42 1.42L13 4.41V7a1 1 0 1 0 2 0V2a1 1 0 0 0-1-1H9ZM2.5 3A1.5 1.5 0 0 0 1 4.5v9A1.5 1.5 0 0 0 2.5 15h9a1.5 1.5 0 0 0 1.5-1.5V10a1 1 0 1 0-2 0v3H3V5h3.5a1 1 0 0 0 0-2H2.5Z",
  12,
);
const ICON_TARGET = svg(
  "M8 0a1 1 0 0 1 1 1v1.07a6 6 0 0 1 4.93 4.93H15a1 1 0 1 1 0 2h-1.07A6 6 0 0 1 9 13.93V15a1 1 0 1 1-2 0v-1.07A6 6 0 0 1 2.07 9H1a1 1 0 0 1 0-2h1.07A6 6 0 0 1 7 2.07V1a1 1 0 0 1 1-1Zm0 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z",
  13,
);

// ---------------------------------------------------------------------------
// The live service probe — fetch, memoised per dataset id
// ---------------------------------------------------------------------------

export interface PreviewData {
  count: number | null;
  info: LayerInfo;
  /** Set when one half of the probe failed but the other landed, so the panel
   * can show what it does know instead of collapsing to an error. */
  note: string | null;
}

const previewCache = new Map<string, PreviewData>();
const inflight = new Map<string, Promise<PreviewData>>();

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Request failed";
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
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

/** Probe one dataset: the count and the layer document in parallel, each
 * allowed to fail on its own. Only when *both* fail is the probe an error —
 * a service that answers the schema request but times out the count is still
 * worth showing. */
async function probe(d: Dataset): Promise<PreviewData> {
  const countUrl = featureCountUrl(d);
  const fieldsUrl = layerFieldsUrl(d);
  if (!countUrl || !fieldsUrl) throw new Error("no queryable layer");

  const [countResult, layerResult] = await Promise.allSettled([fetchJson(countUrl), fetchJson(fieldsUrl)]);

  let count: number | null = null;
  let countError: string | null = null;
  if (countResult.status === "fulfilled") {
    count = parseFeatureCount(countResult.value);
    if (count === null) countError = "the service returned no count";
  } else {
    countError = errorText(countResult.reason);
  }

  let info: LayerInfo = { name: null, geometry: null, fields: [] };
  let fieldsError: string | null = null;
  if (layerResult.status === "fulfilled") {
    info = parseLayerInfo(layerResult.value);
    if (info.fields.length === 0) fieldsError = "the layer reported no fields";
  } else {
    fieldsError = errorText(layerResult.reason);
  }

  if (countError && fieldsError) throw new Error(countError);
  const note = countError
    ? `Feature count unavailable — ${countError}.`
    : fieldsError
      ? `Field list unavailable — ${fieldsError}.`
      : null;
  return { count, info, note };
}

/** Load (and memoise) a dataset's preview. Concurrent probes of the same id
 * share one pair of requests; a failed probe is never cached, so Re-probe
 * really re-probes. */
function loadPreview(d: Dataset, refresh = false): Promise<PreviewData> {
  if (refresh) previewCache.delete(d.id);
  const cached = previewCache.get(d.id);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(d.id);
  if (existing && !refresh) return existing;
  const request = probe(d)
    .then((data) => {
      previewCache.set(d.id, data);
      inflight.delete(d.id);
      return data;
    })
    .catch((error) => {
      inflight.delete(d.id);
      throw error;
    });
  inflight.set(d.id, request);
  return request;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function formatCount(n: number): string {
  return n.toLocaleString("en-NZ");
}

/** Skeleton shapes that match the probe's real geometry — one readout block
 * and a rack of field pills at the widths real field names occupy — so the
 * async half of this panel is never a spinner or a blank flash. */
function probeSkeleton(): string {
  const widths = [104, 88, 132, 76, 118, 96, 140, 84, 110, 92];
  return `<div class="probe__skeleton" aria-hidden="true">
      <span class="dskel dskel--readout"></span>
      <div class="probe__pills">
        ${widths.map((w) => `<span class="dskel dskel--pill" style="width:${w}px"></span>`).join("")}
      </div>
    </div>`;
}

function metaRowsHtml(rows: MetaRow[]): string {
  return rows
    .map(
      (r) => `<div class="fact" data-key="${r.key}" data-missing="${r.missing}">
        <dt class="fact__key">${escapeHtml(r.label)}</dt>
        <dd class="fact__val${r.mono ? " fact__val--mono" : ""}">${escapeHtml(r.value)}</dd>
      </div>`,
    )
    .join("");
}

function sourceLinkHtml(model: DetailModel): string {
  if (!model.sourceUrl) {
    return `<p class="dossier__nosource">${ICON_ALERT}<span>No source link recorded for this dataset.</span></p>`;
  }
  return `<a class="dossier__source" href="${escapeHtml(model.sourceUrl)}" target="_blank" rel="noreferrer">
      ${ICON_EXTERNAL}<span>Open source</span>
      <span class="dossier__source-host">${escapeHtml(model.sourceHost ?? "external")}</span>
    </a>`;
}

/** The dossier for one dataset. The probe region starts in whichever state
 * this dataset is already in (cached, unavailable, or about to be fetched)
 * and is patched in place from there. */
function dossierHtml(d: Dataset, model: DetailModel): string {
  const endpoint = layerPageUrl(d);
  return `<article class="dossier" data-state="record" data-id="${escapeHtml(model.id)}">
    <span class="dossier__rail" aria-hidden="true"></span>
    <header class="dossier__head">
      <div class="dossier__ident">
        <p class="dossier__label">Dataset dossier</p>
        <h2 class="dossier__title">${escapeHtml(model.title)}</h2>
        <p class="dossier__tags">
          <span class="tag tag--theme">${escapeHtml(model.themeLabel)}</span>
          <span class="tag">${escapeHtml(model.scopeLabel)}</span>
          ${model.year ? `<span class="tag tag--num">${escapeHtml(model.year)}</span>` : ""}
        </p>
      </div>
      <button type="button" class="dossier__close" data-action="close-detail" aria-label="Close dataset detail">
        ${ICON_CLOSE}<span>Close</span>
      </button>
    </header>
    <div class="dossier__body">
      <div class="dossier__read">
        ${
          model.description
            ? `<p class="dossier__abstract">${escapeHtml(model.description)}</p>`
            : `<p class="dossier__abstract dossier__abstract--none">No description was recorded for this dataset upstream — the record below and the live service are all there is to go on.</p>`
        }
        ${sourceLinkHtml(model)}
      </div>
      <dl class="dossier__facts">${metaRowsHtml(model.rows)}</dl>
      <section class="probe" data-status="idle">
        <div class="probe__head">
          <p class="probe__label">${ICON_TARGET}<span>Live service probe</span></p>
          <span class="probe__pulse" aria-hidden="true"></span>
          <button type="button" class="probe__retry" data-action="reprobe" hidden>
            ${ICON_RETRY}<span>Re-probe</span>
          </button>
        </div>
        <div class="probe__stage"></div>
        ${
          endpoint
            ? `<a class="probe__endpoint" href="${escapeHtml(endpoint)}" target="_blank" rel="noreferrer">
                ${ICON_EXTERNAL}<span>${escapeHtml(endpoint.replace(/^https?:\/\//, ""))}</span>
              </a>`
            : ""
        }
      </section>
    </div>
    <p class="sr-only" role="status" aria-live="polite"></p>
  </article>`;
}

/** The unselected state: compact, never blank, and it never takes focus —
 * it simply says what a selection would do. */
function idleHtml(): string {
  return `<aside class="dossier dossier--idle" data-state="idle">
    <span class="dossier__rail" aria-hidden="true"></span>
    <p class="dossier__label">Dataset dossier</p>
    <p class="dossier__idle">Select a dataset to see its details — the full catalogue record, plus a live probe of the ArcGIS service behind it.</p>
  </aside>`;
}

/** A hash pointing at an id the catalogue doesn't have (a stale link, a typo)
 * — say so, and offer the one-click way out. */
function missingHtml(id: string): string {
  return `<aside class="dossier dossier--missing" data-state="missing">
    <span class="dossier__rail" aria-hidden="true"></span>
    <p class="dossier__label">Dataset dossier</p>
    <p class="dossier__idle">${ICON_ALERT}<span>No dataset in this catalogue has the id <code>${escapeHtml(id)}</code>. The link may be from an older version of the data.</span></p>
    <button type="button" class="dossier__close" data-action="close-detail" aria-label="Clear the selected dataset">
      ${ICON_CLOSE}<span>Clear selection</span>
    </button>
  </aside>`;
}

interface DetailView {
  root: HTMLElement;
  id: string | undefined;
  dataset: Dataset | null;
  probeEl: HTMLElement | null;
  stage: HTMLElement | null;
  retry: HTMLButtonElement | null;
  live: HTMLElement | null;
}

let view: DetailView | null = null;
/** Bumped on every probe start, so a response for a dataset the user has
 * already navigated away from is dropped instead of painting the wrong
 * numbers into the panel. */
let probeToken = 0;

function announce(text: string): void {
  if (view?.live) view.live.textContent = text;
}

function setProbeStatus(status: "loading" | "ready" | "error" | "unavailable", html: string): void {
  if (!view?.probeEl || !view.stage) return;
  view.probeEl.dataset.status = status;
  view.stage.innerHTML = html;
  if (view.retry) view.retry.hidden = status !== "error" && status !== "ready";
}

function fieldsHtml(fields: LayerField[]): string {
  return fields
    .map(
      (f, i) => `<li class="field" style="--i:${Math.min(i, 16)}" title="${escapeHtml(f.alias)}">
        <span class="field__name">${escapeHtml(f.name)}</span>
        <span class="field__type">${escapeHtml(f.type)}</span>
      </li>`,
    )
    .join("");
}

function readyHtml(data: PreviewData): string {
  const { count, info, note } = data;
  const fieldCount = info.fields.length;
  return `<div class="probe__result">
      <p class="probe__readout">
        <span class="probe__count">${count === null ? "—" : formatCount(count)}</span>
        <span class="probe__unit">features</span>
        <span class="probe__sep"></span>
        <span class="probe__fieldcount">${fieldCount}</span>
        <span class="probe__unit">fields</span>
      </p>
      <p class="probe__layer">
        <span class="probe__layer-name">${escapeHtml(info.name ?? "Layer")}</span>
        ${info.geometry ? `<span class="probe__geom">${escapeHtml(info.geometry)}</span>` : ""}
      </p>
      ${
        fieldCount > 0
          ? `<ul class="probe__fields">${fieldsHtml(info.fields)}</ul>`
          : `<p class="probe__note">${ICON_ALERT}<span>The layer answered, but reports no fields.</span></p>`
      }
      ${note ? `<p class="probe__note">${ICON_ALERT}<span>${escapeHtml(note)}</span></p>` : ""}
    </div>`;
}

function errorHtml(message: string): string {
  return `<div class="probe__fail">
      <p class="probe__failtitle">${ICON_ALERT}<span>The service did not answer</span></p>
      <p class="probe__failbody">${escapeHtml(message)}. These are the councils' own live ArcGIS endpoints — they are occasionally slow, briefly offline, or unreachable from this network. The record above is unaffected.</p>
    </div>`;
}

function unavailableHtml(reason: string): string {
  return `<div class="probe__fail probe__fail--none">
      <p class="probe__failtitle">${ICON_ALERT}<span>No live preview available</span></p>
      <p class="probe__failbody">${escapeHtml(reason)}</p>
    </div>`;
}

function startProbe(d: Dataset, refresh = false): void {
  const token = ++probeToken;
  const cached = !refresh ? previewCache.get(d.id) : undefined;
  if (cached) {
    setProbeStatus("ready", readyHtml(cached));
    announce(probeAnnouncement(d, cached));
    return;
  }
  setProbeStatus("loading", probeSkeleton());
  announce(`Probing the live service for ${label(d)}…`);
  void loadPreview(d, refresh)
    .then((data) => {
      if (token !== probeToken || view?.id !== d.id) return;
      setProbeStatus("ready", readyHtml(data));
      announce(probeAnnouncement(d, data));
    })
    .catch((error) => {
      if (token !== probeToken || view?.id !== d.id) return;
      const message = errorText(error);
      setProbeStatus("error", errorHtml(message));
      announce(`The live service for ${label(d)} could not be reached: ${message}.`);
    });
}

function probeAnnouncement(d: Dataset, data: PreviewData): string {
  const count = data.count === null ? "an unknown number of" : formatCount(data.count);
  return `${label(d)}: ${count} features, ${data.info.fields.length} fields on the live service.`;
}

const wiredRoots = new WeakSet<HTMLElement>();

/** One delegated listener per mount: the panel's innerHTML is replaced
 * wholesale on every selection change, so per-element listeners would be
 * rebound (and leaked) 67 times over a browsing session. */
function wireRoot(root: HTMLElement): void {
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);
  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    if (target.dataset.action === "close-detail") selectDataset(undefined);
    else if (target.dataset.action === "reprobe" && view?.dataset) startProbe(view.dataset, true);
  });
}

/** The FeatureModule registered against `#detail-root` in src/main.ts. Called
 * once at boot and again on every route change; anything other than a change
 * of selected dataset is a no-op, so a theme/search/layer change never
 * rebuilds this panel (which would restart its mount animation and re-run a
 * probe that has already landed). */
export default function renderDetail(root: HTMLElement, state: RouteState): void {
  if (typeof document === "undefined") return;
  wireRoot(root);

  const id = state.dataset;
  if (view && view.root === root && view.id === id) return;

  const dataset = id ? findById(id) ?? null : null;
  if (!id) {
    root.innerHTML = idleHtml();
    view = { root, id, dataset: null, probeEl: null, stage: null, retry: null, live: null };
    return;
  }
  if (!dataset) {
    root.innerHTML = missingHtml(id);
    view = { root, id, dataset: null, probeEl: null, stage: null, retry: null, live: null };
    return;
  }

  const model = detailModel(dataset);
  root.innerHTML = dossierHtml(dataset, model);
  view = {
    root,
    id,
    dataset,
    probeEl: root.querySelector<HTMLElement>(".probe"),
    stage: root.querySelector<HTMLElement>(".probe__stage"),
    retry: root.querySelector<HTMLButtonElement>(".probe__retry"),
    live: root.querySelector<HTMLElement>(".sr-only"),
  };

  if (model.unavailableReason) {
    setProbeStatus("unavailable", unavailableHtml(model.unavailableReason));
    announce(`${model.title} selected. No live preview is available for this dataset.`);
    if (view.retry) view.retry.hidden = true;
    return;
  }
  startProbe(dataset);
}
