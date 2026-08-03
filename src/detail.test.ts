import { describe, expect, it, vi } from "vitest";
import renderDetail, {
  detailModel,
  esriLabel,
  featureCountUrl,
  hostOf,
  layerFieldsUrl,
  layerPageUrl,
  metadataRows,
  parseFeatureCount,
  parseLayerFields,
  parseLayerInfo,
  previewUnavailableReason,
  resolveLayerIndex,
  serviceErrorMessage,
} from "./detail";
import { datasets, findById, label, layerQueryUrl, type Dataset } from "./catalogue";

/** A catalogue row, by id, that the test can rely on existing. */
function row(id: string): Dataset {
  const d = findById(id);
  if (!d) throw new Error(`catalogue row ${id} missing — fixture assumption broken`);
  return d;
}

describe("resolveLayerIndex", () => {
  it("prefers resolved_layer over default_child and layer_id", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), resolved_layer: 7, default_child: 8, layer_id: 9 };
    expect(resolveLayerIndex(d)).toBe(7);
  });

  it("falls back to default_child when resolved_layer is absent", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), resolved_layer: null, default_child: 8, layer_id: 9 };
    expect(resolveLayerIndex(d)).toBe(8);
  });

  it("falls back to layer_id only when the other two are absent", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), resolved_layer: null, default_child: null, layer_id: 9 };
    expect(resolveLayerIndex(d)).toBe(9);
  });

  it("keeps layer 0 rather than treating it as absent", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), resolved_layer: 0, default_child: 5, layer_id: 6 };
    expect(resolveLayerIndex(d)).toBe(0);
  });

  it("is null when no index resolves at all", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), resolved_layer: null, default_child: null, layer_id: null };
    expect(resolveLayerIndex(d)).toBeNull();
  });
});

describe("featureCountUrl", () => {
  it("asks the resolved layer for a count and nothing else", () => {
    const d = row("coastal-inundation-medium");
    expect(d.resolved_layer).toBe(39);
    expect(featureCountUrl(d)).toBe(
      "https://gis.wcc.govt.nz/arcgis/rest/services/DistrictPlanProposed/DistrictPlanProposed/MapServer/39/query?where=1%3D1&returnCountOnly=true&f=json",
    );
  });

  it("uses default_child on a real row whose own layer is not queryable", () => {
    // flood-depths carries no resolved_layer; the upstream conversion points
    // it at sibling layer 15 instead.
    const d = row("flood-depths");
    expect(d.resolved_layer).toBeNull();
    expect(d.default_child).toBe(15);
    expect(featureCountUrl(d)).toBe(`${d.service_root}/15/query?where=1%3D1&returnCountOnly=true&f=json`);
  });

  it("falls back to layer_id only when resolved_layer and default_child are both absent", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), resolved_layer: null, default_child: null, layer_id: 3 };
    expect(featureCountUrl(d)).toContain("/MapServer/3/query?");
  });

  it("returns null for datasets that are not feature-queryable", () => {
    const raster = datasets().find((d) => d.raster_only && !d.feature_queryable);
    expect(raster).toBeDefined();
    expect(featureCountUrl(raster!)).toBeNull();
  });

  it("returns null when there is no service to query", () => {
    const linkless = datasets().find((d) => d.service_root === null);
    expect(linkless).toBeDefined();
    expect(featureCountUrl(linkless!)).toBeNull();
  });

  it("returns null when no layer index resolves at all", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), resolved_layer: null, default_child: null, layer_id: null };
    expect(featureCountUrl(d)).toBeNull();
  });

  it("targets the same layer as catalogue.layerQueryUrl for every queryable dataset", () => {
    const queryable = datasets().filter((d) => featureCountUrl(d) !== null);
    expect(queryable.length).toBeGreaterThan(0);
    for (const d of queryable) {
      const catalogueLayer = layerQueryUrl(d)!.split("/query?")[0];
      expect(featureCountUrl(d)!.split("/query?")[0], `${d.id} probes a different layer`).toBe(catalogueLayer);
    }
  });
});

describe("layerFieldsUrl / layerPageUrl", () => {
  it("points at the layer document of the same resolved layer", () => {
    const d = row("coastal-inundation-medium");
    expect(layerFieldsUrl(d)).toBe(`${d.service_root}/39?f=json`);
    expect(layerPageUrl(d)).toBe(`${d.service_root}/39`);
  });

  it("shares featureCountUrl's fallback order", () => {
    const d = row("flood-depths");
    expect(layerFieldsUrl(d)).toBe(`${d.service_root}/15?f=json`);
    expect(layerPageUrl(d)).toBe(`${d.service_root}/15`);
  });

  it("is null for every dataset that has no live preview", () => {
    for (const d of datasets()) {
      if (previewUnavailableReason(d) === null) continue;
      expect(layerFieldsUrl(d), `${d.id} should not resolve a layer document`).toBeNull();
      expect(layerPageUrl(d), `${d.id} should not resolve a layer page`).toBeNull();
    }
  });
});

describe("previewUnavailableReason", () => {
  it("is null for a queryable feature layer", () => {
    expect(previewUnavailableReason(row("coastal-inundation-medium"))).toBeNull();
  });

  it("explains a raster service as imagery rather than 'not queryable'", () => {
    const raster = row("slope-degrees");
    expect(raster.raster_only).toBe(true);
    expect(previewUnavailableReason(raster)).toMatch(/raster/i);
  });

  it("explains a row with no ArcGIS service at all", () => {
    const linkless = datasets().find((d) => d.service_root === null)!;
    expect(previewUnavailableReason(linkless)).toMatch(/portal|web page/i);
  });

  it("explains a queryable-flagged row whose layer index does not resolve", () => {
    const d: Dataset = {
      ...row("coastal-inundation-medium"),
      resolved_layer: null,
      default_child: null,
      layer_id: null,
    };
    expect(previewUnavailableReason(d)).toMatch(/layer index/i);
  });

  it("agrees with the URL builders on every catalogue row", () => {
    for (const d of datasets()) {
      const probeable = previewUnavailableReason(d) === null;
      expect(featureCountUrl(d) !== null, `${d.id} disagrees about being probeable`).toBe(probeable);
    }
  });
});

describe("serviceErrorMessage", () => {
  it("surfaces an ArcGIS error body served with HTTP 200", () => {
    expect(serviceErrorMessage({ error: { code: 400, message: "Invalid or missing input parameters." } })).toBe(
      "Invalid or missing input parameters.",
    );
  });

  it("names an error object that carries no message", () => {
    expect(serviceErrorMessage({ error: { code: 500 } })).toBe("service error");
  });

  it("is null for a healthy body and for junk", () => {
    expect(serviceErrorMessage({ count: 12 })).toBeNull();
    expect(serviceErrorMessage(null)).toBeNull();
    expect(serviceErrorMessage("<html>gateway timeout</html>")).toBeNull();
    expect(serviceErrorMessage({ error: "nope" })).toBeNull();
  });
});

describe("parseFeatureCount", () => {
  it("reads the count from a returnCountOnly response", () => {
    expect(parseFeatureCount({ count: 1204 })).toBe(1204);
    expect(parseFeatureCount({ count: 0 })).toBe(0);
  });

  it("returns null rather than a confident zero for malformed bodies", () => {
    expect(parseFeatureCount(null)).toBeNull();
    expect(parseFeatureCount(undefined)).toBeNull();
    expect(parseFeatureCount("<html>502</html>")).toBeNull();
    expect(parseFeatureCount({})).toBeNull();
    expect(parseFeatureCount({ count: "1204" })).toBeNull();
    expect(parseFeatureCount({ count: Number.NaN })).toBeNull();
    expect(parseFeatureCount({ count: -3 })).toBeNull();
    expect(parseFeatureCount({ error: { message: "Layer not found" } })).toBeNull();
  });
});

describe("esriLabel", () => {
  it("strips the esri prefix and splits CamelCase", () => {
    expect(esriLabel("esriFieldTypeSmallInteger")).toBe("Small Integer");
    expect(esriLabel("esriFieldTypeString")).toBe("String");
    expect(esriLabel("esriGeometryPolygon")).toBe("Polygon");
    expect(esriLabel("esriGeometryPolyline")).toBe("Polyline");
  });

  it("leaves acronyms intact", () => {
    expect(esriLabel("esriFieldTypeOID")).toBe("OID");
  });

  it("falls back rather than rendering undefined", () => {
    expect(esriLabel(undefined)).toBe("Unknown");
    expect(esriLabel(null)).toBe("Unknown");
    expect(esriLabel(42)).toBe("Unknown");
    expect(esriLabel("esriFieldType")).toBe("Unknown");
    expect(esriLabel(undefined, "Field")).toBe("Field");
  });
});

describe("parseLayerFields", () => {
  const body = {
    name: "Medium Coastal Inundation",
    geometryType: "esriGeometryPolygon",
    fields: [
      { name: "OBJECTID", alias: "Object ID", type: "esriFieldTypeOID" },
      { name: "SCENARIO", alias: "Scenario", type: "esriFieldTypeString" },
      { name: "DEPTH_M", type: "esriFieldTypeDouble" },
    ],
  };

  it("reads name, alias and a readable type for each field", () => {
    expect(parseLayerFields(body)).toEqual([
      { name: "OBJECTID", alias: "Object ID", type: "OID" },
      { name: "SCENARIO", alias: "Scenario", type: "String" },
      { name: "DEPTH_M", alias: "DEPTH_M", type: "Double" },
    ]);
  });

  it("drops entries with no usable name instead of rendering blank rows", () => {
    const parsed = parseLayerFields({
      fields: [{ name: "KEEP", type: "esriFieldTypeString" }, { name: "  " }, { alias: "orphan" }, null, "SHAPE", 7],
    });
    expect(parsed.map((f) => f.name)).toEqual(["KEEP"]);
  });

  it("labels a field with no declared type rather than dropping it", () => {
    expect(parseLayerFields({ fields: [{ name: "GLOBALID" }] })).toEqual([
      { name: "GLOBALID", alias: "GLOBALID", type: "Field" },
    ]);
  });

  it("returns an empty list for malformed bodies", () => {
    expect(parseLayerFields(null)).toEqual([]);
    expect(parseLayerFields(undefined)).toEqual([]);
    expect(parseLayerFields("<html>404</html>")).toEqual([]);
    expect(parseLayerFields({})).toEqual([]);
    expect(parseLayerFields({ fields: "OBJECTID,SHAPE" })).toEqual([]);
    expect(parseLayerFields({ error: { message: "Layer not found" } })).toEqual([]);
  });

  it("parses the whole layer document, geometry included", () => {
    expect(parseLayerInfo(body)).toEqual({
      name: "Medium Coastal Inundation",
      geometry: "Polygon",
      fields: parseLayerFields(body),
    });
  });

  it("nulls the layer name and geometry when the document is malformed", () => {
    expect(parseLayerInfo({ name: "   ", fields: [] })).toEqual({ name: null, geometry: null, fields: [] });
    expect(parseLayerInfo("not json at all")).toEqual({ name: null, geometry: null, fields: [] });
  });
});

describe("metadataRows", () => {
  it("keeps the same nine rows in the same order for every dataset", () => {
    const keys = ["theme", "scope", "authority", "year", "coverage", "layer", "service", "host", "id"];
    for (const d of datasets()) {
      expect(metadataRows(d).map((r) => r.key), `${d.id} has a different record shape`).toEqual(keys);
    }
  });

  it("fills the rows from the catalogue row", () => {
    const rows = metadataRows(row("coastal-inundation-medium"));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("theme")!.value).toBe("Coastal Inundation");
    expect(byKey.get("scope")!.value).toBe("WCC");
    expect(byKey.get("authority")!.value).toBe("Wellington City Council");
    expect(byKey.get("year")!.value).toBe("2021");
    expect(byKey.get("layer")!.value).toBe("Feature Layer");
    expect(byKey.get("service")!.value).toBe("MapServer · layer 39");
    expect(byKey.get("host")!.value).toBe("gis.wcc.govt.nz");
    expect(byKey.get("id")!.value).toBe("coastal-inundation-medium");
    expect(rows.every((r) => r.missing === false)).toBe(false); // coverage is absent upstream
    expect(byKey.get("coverage")!.missing).toBe(true);
    expect(byKey.get("coverage")!.value).toBe("—");
  });

  it("marks an absent year as missing rather than dropping the row", () => {
    const d = row("stream-corridor");
    expect(d.year).toBeNull();
    const year = metadataRows(d).find((r) => r.key === "year")!;
    expect(year).toMatchObject({ label: "Year", value: "—", missing: true, mono: true });
  });

  it("renders numbers, ids and endpoints in the mono half of the type pairing", () => {
    const rows = metadataRows(row("coastal-inundation-medium"));
    const mono = rows.filter((r) => r.mono).map((r) => r.key);
    expect(mono).toEqual(["year", "service", "host", "id"]);
  });

  it("still reports the server type when no layer index resolves", () => {
    const d: Dataset = {
      ...row("coastal-inundation-medium"),
      resolved_layer: null,
      default_child: null,
      layer_id: null,
    };
    expect(metadataRows(d).find((r) => r.key === "service")!.value).toBe("MapServer");
  });
});

describe("detailModel", () => {
  it("models a fully populated, probeable dataset", () => {
    const d = row("active-faults");
    const model = detailModel(d);
    expect(model.id).toBe("active-faults");
    expect(model.title).toBe(label(d));
    expect(model.scopeLabel).toBe({ wcc: "WCC", regional: "Regional", national: "National" }[d.scope]);
    expect(model.themeLabel).toBe(d.theme_label);
    expect(model.sourceUrl).toBe(d.url);
    expect(model.sourceHost).toBe(hostOf(d.url!));
    expect(model.probeable).toBe(previewUnavailableReason(d) === null);
    expect(model.unavailableReason).toBeNull();
    expect(model.rows).toEqual(metadataRows(d));
  });

  it("nulls the description for the rows upstream left empty", () => {
    const d = row("coastal-inundation-medium");
    expect(d.description).toBeNull();
    expect(detailModel(d).description).toBeNull();
  });

  it("keeps a real description, trimmed", () => {
    const d: Dataset = { ...row("coastal-inundation-medium"), description: "  Modelled inundation extents.  " };
    expect(detailModel(d).description).toBe("Modelled inundation extents.");
  });

  it("nulls the year when upstream has none", () => {
    expect(detailModel(row("stream-corridor")).year).toBeNull();
    expect(detailModel(row("coastal-inundation-medium")).year).toBe("2021");
  });

  it("nulls the source link, and its host, for the row with no url", () => {
    const d = row("soil-classification-regional");
    expect(d.url).toBeNull();
    const model = detailModel(d);
    expect(model.sourceUrl).toBeNull();
    expect(model.sourceHost).toBeNull();
  });

  it("carries the reason instead of a probe for a non-queryable dataset", () => {
    const model = detailModel(row("slope-degrees"));
    expect(model.probeable).toBe(false);
    expect(model.unavailableReason).toMatch(/raster/i);
  });

  it("falls back to a label for a dataset with no theme", () => {
    const unthemed = datasets().find((d) => !d.theme_label && !d.theme);
    expect(unthemed).toBeDefined();
    expect(detailModel(unthemed!).themeLabel).toBe("Uncategorised");
  });

  it("models every catalogue row without throwing or leaving an empty title", () => {
    for (const d of datasets()) {
      const model = detailModel(d);
      expect(model.title.length, `${d.id} has no title`).toBeGreaterThan(0);
      expect(model.rows).toHaveLength(9);
      expect(model.probeable === (model.unavailableReason === null)).toBe(true);
    }
  });
});

describe("hostOf", () => {
  it("reads the host of an absolute url", () => {
    expect(hostOf("https://gis.wcc.govt.nz/arcgis/rest/services/X/MapServer/0")).toBe("gis.wcc.govt.nz");
  });

  it("is null for something that is not a url", () => {
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("node-environment safety", () => {
  it("has no document to render into, and probes nothing rather than throwing", () => {
    // The module is imported at the top of this file: if any DOM work or
    // fetch happened at module scope, or renderDetail skipped its guard,
    // this suite would never have got this far.
    expect(typeof document).toBe("undefined");
    const spy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      expect(() =>
        renderDetail(null as unknown as HTMLElement, { dataset: "coastal-inundation-medium" }),
      ).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
