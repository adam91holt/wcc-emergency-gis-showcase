import { describe, expect, it } from "vitest";
import {
  datasets,
  findById,
  byScope,
  themes,
  scopes,
  mappableDatasets,
  climateDatasets,
  layerQueryUrl,
} from "./catalogue";

describe("findById", () => {
  it("finds a known dataset by id", () => {
    const d = findById("active-faults");
    expect(d).toBeDefined();
    expect(d!.id).toBe("active-faults");
  });

  it("returns undefined for an unknown id", () => {
    expect(findById("does-not-exist")).toBeUndefined();
  });
});

describe("byScope", () => {
  it("matches the bundled counts (23 wcc / 33 regional / 11 national)", () => {
    expect(byScope("wcc").length).toBe(23);
    expect(byScope("regional").length).toBe(33);
    expect(byScope("national").length).toBe(11);
  });

  it("every row it returns actually has that scope", () => {
    for (const d of byScope("regional")) expect(d.scope).toBe("regional");
  });
});

describe("scopes", () => {
  it("returns wcc/regional/national counts that sum to the total", () => {
    const summary = scopes();
    expect(summary).toEqual([
      { scope: "wcc", count: 23 },
      { scope: "regional", count: 33 },
      { scope: "national", count: 11 },
    ]);
    expect(summary.reduce((n, s) => n + s.count, 0)).toBe(datasets().length);
  });
});

describe("themes", () => {
  it("excludes the untethered national rows and sums to the themed subset", () => {
    const list = themes();
    expect(list.length).toBeGreaterThan(0);
    const total = list.reduce((n, t) => n + t.count, 0);
    const themedRows = datasets().filter((d) => d.theme);
    expect(total).toBe(themedRows.length);
    expect(total).toBeLessThan(datasets().length); // the 11 national rows have no theme
  });

  it("includes climate with its real count and label", () => {
    const climate = themes().find((t) => t.theme === "climate");
    expect(climate).toBeDefined();
    expect(climate!.theme_label).toBe("Climate Data");
    expect(climate!.count).toBe(21);
  });

  it("every entry's count matches a direct filter over datasets()", () => {
    for (const t of themes()) {
      expect(datasets().filter((d) => d.theme === t.theme).length).toBe(t.count);
    }
  });
});

describe("mappableDatasets", () => {
  it("only returns feature-queryable, non-raster Feature Layers", () => {
    const list = mappableDatasets();
    expect(list.length).toBe(32);
    for (const d of list) {
      expect(d.feature_queryable).toBe(true);
      expect(d.raster_only).toBe(false);
      expect(d.layer_type).toBe("Feature Layer");
    }
  });

  it("excludes raster-only and non-queryable rows that would otherwise slip through", () => {
    const mappableIds = new Set(mappableDatasets().map((d) => d.id));
    for (const d of datasets()) {
      if (d.raster_only || !d.feature_queryable) expect(mappableIds.has(d.id)).toBe(false);
    }
  });
});

describe("climateDatasets", () => {
  it("returns exactly the 21 climate-theme rows", () => {
    const list = climateDatasets();
    expect(list.length).toBe(21);
    for (const d of list) expect(d.theme).toBe("climate");
    expect(list.map((d) => d.id)).toContain("climate-mean-temp");
  });
});

describe("layerQueryUrl", () => {
  it("builds a /query URL against the resolved layer for a queryable dataset", () => {
    const d = findById("coastal-inundation-medium")!;
    const url = layerQueryUrl(d);
    expect(url).toBe(
      "https://gis.wcc.govt.nz/arcgis/rest/services/DistrictPlanProposed/DistrictPlanProposed/MapServer/39/query?where=1%3D1&outFields=*&f=json",
    );
  });

  it("returns null when the dataset has no resolved or fallback layer index", () => {
    // shaking-layers is feature_queryable but both resolved_layer and
    // layer_id are null in the bundled data — there's nothing to query.
    const d = findById("shaking-layers")!;
    expect(layerQueryUrl(d)).toBeNull();
  });

  it("returns null for a dataset that isn't feature_queryable", () => {
    const d = datasets().find((x) => !x.feature_queryable);
    expect(d).toBeDefined();
    expect(layerQueryUrl(d!)).toBeNull();
  });
});

describe("named datasets per hazard family (sanity check for sibling tickets)", () => {
  it("coastal inundation", () => {
    const d = findById("coastal-inundation-high")!;
    expect(d.theme).toBe("coastal_inundation");
  });

  it("flood", () => {
    const d = findById("stream-corridor")!;
    expect(d.theme).toBe("flood");
  });

  it("active faults", () => {
    const d = findById("active-faults")!;
    expect(d.theme).toBe("earthquake");
  });

  it("landslide", () => {
    const d = findById("landslide-features")!;
    expect(d.theme).toBe("landslide");
  });
});
