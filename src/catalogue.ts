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
  link_type: string | null;
  feature_queryable?: boolean;
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
