// Typed access to the bundled WCC Emergency Management GIS catalogue. The JSON
// is the verbatim upstream artifact (data/catalogue.json, sourced from
// claudecommunity-nz/wcc-emergency-gis-data) — this module gives it a shape and
// a few pure selectors the UI builds on.
import raw from "../data/catalogue.json";

export interface Dataset {
  id: string;
  scope: "wcc" | "regional" | "national";
  authority: string | null;
  theme: string;
  theme_label: string;
  name: string;
  description: string | null;
  display_name: string | null;
  year: string | null;
  coverage: string | null;
  url: string | null;
  // Upstream has no "wfs" link type — every link is one of these three, or
  // null where the source row had no link at all.
  link_type: "arcgis_rest" | "arcgis_portal" | "web" | null;
  feature_queryable?: boolean;
  /** Present on all but one row (missing, not null, for the one exception). */
  host?: string;
  /** The service's base REST endpoint. Null only where there is no link. */
  service_root: string | null;
  /** service_root's path component, e.g. "Environment/Slope". Absent for
   * datasets with no ArcGIS REST service (arcgis_portal / web links). */
  service_path?: string;
  /** Absent for the same non-REST datasets as service_path. */
  server_type?: "MapServer" | "FeatureServer";
  /** The layer index as read from the source spreadsheet cell. */
  layer_id?: number | null;
  /** The layer index the upstream conversion resolved to query against —
   * prefer this over layer_id when building a query URL. */
  resolved_layer: number | null;
  /** Sibling layer id to fall back to when this row's own service is a
   * group with no directly queryable layer. */
  default_child: number | null;
  layer_type: "Feature Layer" | "Raster Layer" | "Group Layer" | null;
  raster_only: boolean;
  empty_service: boolean;
}

export interface Catalogue {
  description: string;
  counts: { total: number; wcc: number; regional: number; national: number };
  datasets: Dataset[];
}

export const catalogue = raw as unknown as Catalogue;

export function datasets(): Dataset[] {
  return catalogue.datasets;
}

/** Datasets grouped by theme_label, insertion order preserved. */
export function byTheme(list: Dataset[] = datasets()): Map<string, Dataset[]> {
  const out = new Map<string, Dataset[]>();
  for (const d of list) {
    const key = d.theme_label || d.theme || "Uncategorised";
    (out.get(key) ?? out.set(key, []).get(key)!).push(d);
  }
  return out;
}

/** Case-insensitive substring search over the fields a person would scan. */
export function search(term: string, list: Dataset[] = datasets()): Dataset[] {
  const q = term.trim().toLowerCase();
  if (q === "") return list;
  return list.filter((d) =>
    [d.display_name, d.name, d.theme_label, d.authority, d.id]
      .some((f) => (f ?? "").toLowerCase().includes(q)),
  );
}

/** The human label for a dataset — display_name when curated, else the raw name. */
export function label(d: Dataset): string {
  return d.display_name?.trim() || d.name;
}

/** Look up a single dataset by its stable id. */
export function findById(id: string, list: Dataset[] = datasets()): Dataset | undefined {
  return list.find((d) => d.id === id);
}

/** Datasets in a single scope (wcc / regional / national). */
export function byScope(scope: Dataset["scope"], list: Dataset[] = datasets()): Dataset[] {
  return list.filter((d) => d.scope === scope);
}

export interface ThemeSummary {
  theme: string;
  theme_label: string;
  count: number;
}

/** Distinct themes with a display label and dataset count, in first-seen
 * order. Datasets with no theme (the national-scope rows) are excluded —
 * they have no theme_label either, so byTheme() buckets them separately. */
export function themes(list: Dataset[] = datasets()): ThemeSummary[] {
  const order: string[] = [];
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const d of list) {
    if (!d.theme) continue;
    if (!counts.has(d.theme)) {
      order.push(d.theme);
      labels.set(d.theme, d.theme_label || d.theme);
    }
    counts.set(d.theme, (counts.get(d.theme) ?? 0) + 1);
  }
  return order.map((theme) => ({ theme, theme_label: labels.get(theme)!, count: counts.get(theme)! }));
}

export interface ScopeSummary {
  scope: Dataset["scope"];
  count: number;
}

/** Dataset counts for each of the three scopes, in wcc/regional/national order. */
export function scopes(list: Dataset[] = datasets()): ScopeSummary[] {
  const order: Dataset["scope"][] = ["wcc", "regional", "national"];
  return order.map((scope) => ({ scope, count: byScope(scope, list).length }));
}

/** Datasets that can actually be drawn on a map: queryable, vector (not a
 * raster-only service), and resolved to a real Feature Layer. */
export function mappableDatasets(list: Dataset[] = datasets()): Dataset[] {
  return list.filter((d) => d.feature_queryable && !d.raster_only && d.layer_type === "Feature Layer");
}

/** Datasets under the climate theme (the time-series data the charts ticket needs). */
export function climateDatasets(list: Dataset[] = datasets()): Dataset[] {
  return list.filter((d) => d.theme === "climate");
}

/** The ArcGIS REST `/query` URL for a dataset's resolved layer, or null when
 * the dataset isn't queryable (no service_root, or no usable layer index).
 * Fallback order matches the fields' own semantics: resolved_layer is the
 * upstream-resolved, already-correct index; when that's absent, default_child
 * is the documented sibling to use when this row's own service/layer_id is a
 * non-queryable group; only then does the raw layer_id apply. Skipping
 * default_child would either return null for rows that do have a queryable
 * child, or build a URL against a Group Layer, which ArcGIS REST rejects. */
export function layerQueryUrl(d: Dataset): string | null {
  if (!d.feature_queryable || !d.service_root) return null;
  const layer = d.resolved_layer ?? d.default_child ?? d.layer_id;
  if (layer == null) return null;
  return `${d.service_root}/${layer}/query?where=1%3D1&outFields=*&f=json`;
}
