import { describe, expect, it } from "vitest";
import renderMap, {
  WELLINGTON_VIEW,
  geoJsonQueryUrl,
  layerGroups,
  layersFromRoute,
  patchForLayers,
  themeColor,
  toggleLayerId,
} from "./map";
import { datasets, findById, mappableDatasets, type Dataset } from "./catalogue";
import { mergeHash, parseHash, toHash } from "./router";

/** A catalogue row, by id, that the test can rely on existing. */
function row(id: string): Dataset {
  const d = findById(id);
  if (!d) throw new Error(`catalogue row ${id} missing — fixture assumption broken`);
  return d;
}

describe("geoJsonQueryUrl", () => {
  it("builds a WGS84 geojson query against the resolved layer", () => {
    const d = row("coastal-inundation-medium");
    expect(d.resolved_layer).toBe(39);
    expect(geoJsonQueryUrl(d)).toBe(
      "https://gis.wcc.govt.nz/arcgis/rest/services/DistrictPlanProposed/DistrictPlanProposed/MapServer/39/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
    );
  });

  it("prefers resolved_layer over default_child and layer_id", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), resolved_layer: 7, default_child: 8, layer_id: 9 };
    expect(geoJsonQueryUrl(d)).toContain("/MapServer/7/query?");
  });

  it("falls back to default_child on real rows whose own layer is not queryable", () => {
    // flood-depths carries no resolved_layer; the upstream conversion points
    // it at sibling layer 15 instead.
    const d = row("flood-depths");
    expect(d.resolved_layer).toBeNull();
    expect(d.default_child).toBe(15);
    expect(geoJsonQueryUrl(d)).toBe(`${d.service_root}/15/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`);
  });

  it("falls back to layer_id only when resolved_layer and default_child are both absent", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), resolved_layer: null, default_child: null, layer_id: 3 };
    expect(geoJsonQueryUrl(d)).toContain("/MapServer/3/query?");
  });

  it("returns null for datasets that are not feature-queryable", () => {
    const raster = datasets().find((d) => d.raster_only && !d.feature_queryable);
    expect(raster).toBeDefined();
    expect(geoJsonQueryUrl(raster!)).toBeNull();
  });

  it("returns null when there is no service to query", () => {
    const linkless = datasets().find((d) => d.service_root === null);
    expect(linkless).toBeDefined();
    expect(geoJsonQueryUrl(linkless!)).toBeNull();
  });

  it("returns null when no layer index resolves at all", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), resolved_layer: null, default_child: null, layer_id: null };
    expect(geoJsonQueryUrl(d)).toBeNull();
  });

  it("resolves a URL for every dataset the map offers as a layer", () => {
    for (const d of mappableDatasets()) {
      const url = geoJsonQueryUrl(d);
      expect(url, `${d.id} should be queryable`).not.toBeNull();
      expect(url).toMatch(/\/\d+\/query\?where=1%3D1&outFields=\*&outSR=4326&f=geojson$/);
    }
  });
});

describe("themeColor", () => {
  const known = ["coastal_inundation", "sea_level_rise", "flood", "landslide", "earthquake", "climate", "other"];

  it("returns a distinct colour for each known theme", () => {
    const colours = known.map(themeColor);
    expect(new Set(colours).size).toBe(known.length);
    for (const c of colours) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("is stable across calls", () => {
    for (const theme of known) expect(themeColor(theme)).toBe(themeColor(theme));
  });

  it("falls back to one shared colour for unknown, empty and missing themes", () => {
    const fallback = themeColor("no-such-theme");
    expect(themeColor("")).toBe(fallback);
    expect(themeColor(null)).toBe(fallback);
    expect(themeColor(undefined)).toBe(fallback);
    expect(known.map(themeColor)).not.toContain(fallback);
  });

  it("colours every theme present in the catalogue", () => {
    for (const d of datasets()) {
      if (!d.theme) continue;
      expect(themeColor(d.theme), `${d.theme} has no colour`).not.toBe(themeColor("no-such-theme"));
    }
  });
});

describe("layerGroups", () => {
  it("covers every mappable dataset exactly once", () => {
    const grouped = layerGroups().flatMap((g) => g.datasets.map((d) => d.id));
    expect(grouped.sort()).toEqual(mappableDatasets().map((d) => d.id).sort());
  });

  it("merges the catalogue's two flood labels into one colour-keyed group", () => {
    const flood = layerGroups().filter((g) => g.theme === "flood");
    expect(flood).toHaveLength(1);
    expect(flood[0].color).toBe(themeColor("flood"));
    expect(flood[0].datasets.length).toBeGreaterThan(1);
  });

  it("labels the unthemed national rows rather than dropping them", () => {
    const unthemed = layerGroups().find((g) => g.theme === "");
    expect(unthemed).toBeDefined();
    expect(unthemed!.label).toBe("Uncategorised");
    expect(unthemed!.color).toBe(themeColor(undefined));
  });
});

describe("layersFromRoute", () => {
  it("keeps mappable ids in hash order", () => {
    const state = parseHash("#layers=active-faults,coastal-inundation-high");
    expect(layersFromRoute(state)).toEqual(["active-faults", "coastal-inundation-high"]);
  });

  it("drops ids that are not mappable datasets", () => {
    // sea-level-rise is a real catalogue id, but raster-only — not drawable.
    expect(findById("sea-level-rise")).toBeDefined();
    expect(mappableDatasets().some((d) => d.id === "sea-level-rise")).toBe(false);
    const state = parseHash("#layers=sea-level-rise,not-a-dataset,active-faults");
    expect(layersFromRoute(state)).toEqual(["active-faults"]);
  });

  it("collapses duplicates", () => {
    const state = parseHash("#layers=active-faults,active-faults");
    expect(layersFromRoute(state)).toEqual(["active-faults"]);
  });

  it("returns nothing for a hash with no layers key", () => {
    expect(layersFromRoute(parseHash("#theme=flood"))).toEqual([]);
  });
});

describe("toggleLayerId", () => {
  it("appends a newly switched-on layer", () => {
    expect(toggleLayerId(["a"], "b", true)).toEqual(["a", "b"]);
  });

  it("never duplicates an already-on layer", () => {
    expect(toggleLayerId(["a", "b"], "b", true)).toEqual(["a", "b"]);
  });

  it("removes a switched-off layer and keeps the order of the rest", () => {
    expect(toggleLayerId(["a", "b", "c"], "b", false)).toEqual(["a", "c"]);
  });
});

describe("layers ↔ hash round trip", () => {
  it("survives a toggle → hash → parse → toggle-list round trip", () => {
    const ids = ["coastal-inundation-high", "active-faults"];
    const hash = toHash({ layers: ids });
    expect(hash).toBe("#layers=coastal-inundation-high%2Cactive-faults");
    expect(layersFromRoute(parseHash(hash))).toEqual(ids);
  });

  it("writes a toggle into the hash without touching other route keys", () => {
    const start = "#dataset=active-faults&theme=earthquake";
    const next = mergeHash(start, patchForLayers(toggleLayerId([], "liquefaction-overlay", true)));
    expect(parseHash(next)).toEqual({
      dataset: "active-faults",
      theme: "earthquake",
      layers: ["liquefaction-overlay"],
    });
  });

  it("removes the layers key entirely once the last layer is switched off", () => {
    const start = mergeHash("#theme=flood", patchForLayers(["stream-corridor"]));
    expect(parseHash(start).layers).toEqual(["stream-corridor"]);
    const cleared = mergeHash(start, patchForLayers(toggleLayerId(["stream-corridor"], "stream-corridor", false)));
    expect(cleared).not.toContain("layers");
    expect(parseHash(cleared)).toEqual({ theme: "flood" });
  });

  it("restores a deep link's layers, ignoring the unknown ids in it", () => {
    const pasted = "#layers=coastal-inundation-high,ghost-layer,stream-corridor&scope=wcc";
    const state = parseHash(pasted);
    expect(state.layers).toEqual(["coastal-inundation-high", "ghost-layer", "stream-corridor"]);
    expect(layersFromRoute(state)).toEqual(["coastal-inundation-high", "stream-corridor"]);
  });
});

describe("node-environment safety", () => {
  it("has no document to render into, and does nothing rather than throwing", () => {
    // The module is imported at the top of this file: if any DOM or Leaflet
    // work happened at module scope, or renderMap skipped its guard, this
    // suite would never have got this far.
    expect(typeof document).toBe("undefined");
    expect(() => renderMap(null as unknown as HTMLElement, { layers: ["active-faults"] })).not.toThrow();
  });
});

describe("WELLINGTON_VIEW", () => {
  it("frames Wellington city at a street-legible zoom", () => {
    expect(WELLINGTON_VIEW.lat).toBeCloseTo(-41.29, 2);
    expect(WELLINGTON_VIEW.lon).toBeCloseTo(174.78, 2);
    expect(WELLINGTON_VIEW.zoom).toBe(12);
  });
});
