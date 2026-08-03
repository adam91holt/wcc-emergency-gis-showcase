// Pure-layer coverage for src/map.ts. Everything asserted here runs with no
// DOM and no network: the classifier, the service-URL builder, the rack
// grouping, the `#layers=` encoding and the popup content are all functions of
// the bundled catalogue, so these tests are deterministic and offline by
// construction. The Leaflet half of map.ts is never touched — importing the
// module must not reach for `document`, `fetch` or a browser global, which is
// itself part of what this file proves.
import { describe, expect, it } from "vitest";
import {
  serverTypeOf,
  resolvedLayerIndex,
  serviceUrlFor,
  imageSublayers,
  classifyLayer,
  exclusionReason,
  attributionFor,
  describeLayer,
  describeAllLayers,
  toggleableLayers,
  groupLayersByTheme,
  layerIdsFromRoute,
  patchForLayerIds,
  popupFields,
  humaniseField,
  escapeHtml,
  popupHtml,
  statusReadout,
  layerById,
  THEME_ORDER,
  DEFAULT_LAYER_IDS,
  NO_LAYERS,
  type LayerDescriptor,
} from "./map";
import { datasets, findById, mappableDatasets, type Dataset } from "./catalogue";

function row(id: string): Dataset {
  const d = findById(id);
  if (!d) throw new Error(`catalogue row ${id} is missing — fixture is stale`);
  return d;
}

/** A synthetic row for the shapes the bundled catalogue happens not to
 * contain. Only the fields the map's pure functions read are set. */
function synthetic(overrides: Partial<Dataset>): Dataset {
  return {
    id: "synthetic",
    scope: "wcc",
    authority: "Test Authority",
    theme: "flood",
    theme_label: "Flood data",
    name: "Synthetic",
    description: null,
    display_name: null,
    year: null,
    coverage: null,
    url: null,
    link_type: "arcgis_rest",
    feature_queryable: true,
    host: "example.test",
    service_root: "https://example.test/arcgis/rest/services/X/MapServer",
    server_type: "MapServer",
    layer_id: 0,
    resolved_layer: 0,
    default_child: null,
    layer_type: "Feature Layer",
    raster_only: false,
    empty_service: false,
    ...overrides,
  };
}

describe("serverTypeOf", () => {
  it("uses the catalogue's own server_type when it has one", () => {
    expect(serverTypeOf(row("coastal-inundation-high"))).toBe("MapServer");
    expect(serverTypeOf(row("earthquake-prone-buildings"))).toBe("FeatureServer");
  });

  it("falls back to the service_root suffix for rows with no server_type", () => {
    // These `link_type: "web"` / null rows carry a service_root but no
    // server_type field at all.
    const rainfall = row("rainfall-observations");
    expect(rainfall.server_type).toBeUndefined();
    expect(serverTypeOf(rainfall)).toBe("MapServer");
    expect(serverTypeOf(row("soil-classification-regional"))).toBe("MapServer");
  });

  it("reads a FeatureServer suffix without a server_type field", () => {
    const d = synthetic({
      server_type: undefined,
      service_root: "https://example.test/arcgis/rest/services/X/FeatureServer",
    });
    expect(serverTypeOf(d)).toBe("FeatureServer");
  });

  it("is null when there is no service and null for an unrecognised suffix", () => {
    expect(serverTypeOf(row("flood-exposure-map"))).toBeNull();
    expect(
      serverTypeOf(
        synthetic({ server_type: undefined, service_root: "https://example.test/wms" }),
      ),
    ).toBeNull();
  });
});

describe("resolvedLayerIndex", () => {
  it("prefers resolved_layer", () => {
    expect(resolvedLayerIndex(row("coastal-inundation-medium"))).toBe(39);
    expect(resolvedLayerIndex(row("active-faults"))).toBe(0);
  });

  it("falls back to default_child when resolved_layer is null", () => {
    // Fault Hazard Overlays' own layer 45 is a group; 46 is the queryable
    // sibling the upstream conversion recorded.
    const faults = row("fault-hazard-overlay");
    expect(faults.resolved_layer).toBeNull();
    expect(faults.default_child).toBe(46);
    expect(resolvedLayerIndex(faults)).toBe(46);
  });

  it("falls back to layer_id only when both resolved fields are absent", () => {
    const d = synthetic({ resolved_layer: null, default_child: null, layer_id: 7 });
    expect(resolvedLayerIndex(d)).toBe(7);
  });

  it("is null when the row names no layer at all", () => {
    const d = synthetic({ resolved_layer: null, default_child: null, layer_id: null });
    expect(resolvedLayerIndex(d)).toBeNull();
  });
});

describe("serviceUrlFor", () => {
  it("appends the resolved layer index to a MapServer root", () => {
    expect(serviceUrlFor(row("coastal-inundation-high"))).toBe(
      "https://gis.wcc.govt.nz/arcgis/rest/services/DistrictPlanProposed/DistrictPlanProposed/MapServer/40",
    );
  });

  it("appends the resolved layer index to a FeatureServer root", () => {
    expect(serviceUrlFor(row("earthquake-prone-buildings"))).toBe(
      "https://services1.arcgis.com/CPYspmTk3abe6d7i/arcgis/rest/services/MBIE_EPB_WCC_VW/FeatureServer/0",
    );
  });

  it("uses default_child for a group layer with no resolved_layer", () => {
    expect(serviceUrlFor(row("fault-hazard-overlay"))).toBe(
      "https://gis.wcc.govt.nz/arcgis/rest/services/DistrictPlanProposed/DistrictPlanProposed/MapServer/46",
    );
    expect(serviceUrlFor(row("flood-hazard-areas"))).toBe(
      "https://mapping1.gw.govt.nz/arcgis/rest/services/GW/Flood_Hazards_Areas/MapServer/0",
    );
  });

  it("points an image layer at the bare service root, with no index", () => {
    const stormSurge = row("storm-surge");
    expect(classifyLayer(stormSurge)).toBe("image");
    expect(serviceUrlFor(stormSurge)).toBe(
      "https://mapping1.gw.govt.nz/arcgis/rest/services/Hazards/Storm_Surge/MapServer",
    );
  });

  it("normalises a trailing slash rather than emitting a double slash", () => {
    const d = synthetic({
      service_root: "https://example.test/arcgis/rest/services/X/MapServer/",
      resolved_layer: 3,
    });
    expect(serviceUrlFor(d)).toBe("https://example.test/arcgis/rest/services/X/MapServer/3");
  });

  it("is null for link-only rows and for a feature row that names no layer", () => {
    expect(serviceUrlFor(row("flood-exposure-map"))).toBeNull();
    const noIndex = synthetic({ resolved_layer: null, default_child: null, layer_id: null });
    // Classified as an image (a MapServer can still draw itself), but asked
    // for a feature URL there is no index to append.
    expect(serviceUrlFor(noIndex, "feature")).toBeNull();
  });
});

describe("imageSublayers", () => {
  it("draws only the resolved child of a group service", () => {
    expect(imageSublayers(row("sea-level-rise"))).toEqual([1]);
    expect(imageSublayers(row("storm-surge"))).toEqual([1]);
  });

  it("is null when the service names no sublayer, meaning 'draw all of it'", () => {
    const d = synthetic({ resolved_layer: null, default_child: null, layer_id: null });
    expect(imageSublayers(d)).toBeNull();
  });
});

describe("classifyLayer", () => {
  it("classifies the epic's headline hazards as queryable feature layers", () => {
    for (const id of [
      "coastal-inundation-medium",
      "coastal-inundation-high",
      "stream-corridor",
      "overland-flowpath",
      "flood-hazard-areas",
      "active-faults",
      "fault-hazard-overlay",
      "landslide-features",
      "landslide-lines",
    ]) {
      expect(classifyLayer(row(id)), id).toBe("feature");
    }
  });

  it("classifies raster-only MapServer rows as image layers", () => {
    for (const id of ["sea-level-rise", "storm-surge", "climate-hot-days", "slope-degrees"]) {
      expect(classifyLayer(row(id)), id).toBe("image");
      expect(row(id).raster_only).toBe(true);
    }
  });

  it("classifies an ArcGIS Online web map as link-only — it is a viewer, not a service", () => {
    const portal = row("flood-exposure-map");
    expect(portal.link_type).toBe("arcgis_portal");
    expect(portal.service_root).toBeNull();
    expect(classifyLayer(portal)).toBe("link");
    expect(serviceUrlFor(portal)).toBeNull();
  });

  it("still draws a portal-linked row that resolved to a real REST service", () => {
    // link_type describes the row's human-facing url. The NIWA coastal rows
    // point at an opendata portal page *and* carry a resolved service_root;
    // treating link_type as the test would drop four drawable datasets,
    // including the coastal sensitivity inundation index.
    for (const id of ["beach-exposure", "coastal-inundation-index", "coastal-erosion-index"]) {
      const d = row(id);
      expect(d.link_type, id).toBe("arcgis_portal");
      expect(d.service_root, id).toBeTruthy();
      expect(classifyLayer(d), id).toBe("feature");
    }
  });

  it("classifies rows with no service endpoint as link-only", () => {
    expect(classifyLayer(synthetic({ service_root: null, server_type: undefined }))).toBe("link");
  });

  it("classifies an empty service as link-only even when it looks queryable", () => {
    expect(classifyLayer(synthetic({ empty_service: true }))).toBe("link");
  });

  it("classifies a raster-only FeatureServer as link-only — there is no export endpoint", () => {
    const d = synthetic({
      raster_only: true,
      feature_queryable: false,
      server_type: "FeatureServer",
      service_root: "https://example.test/arcgis/rest/services/X/FeatureServer",
    });
    expect(classifyLayer(d)).toBe("link");
  });

  it("classifies a non-queryable FeatureServer group as link-only", () => {
    const d = synthetic({
      feature_queryable: false,
      server_type: "FeatureServer",
      service_root: "https://example.test/arcgis/rest/services/X/FeatureServer",
      layer_type: "Group Layer",
    });
    expect(classifyLayer(d)).toBe("link");
  });

  it("never narrows the catalogue's own vector-mappable set", () => {
    // catalogue.mappableDatasets() certifies queryable, non-raster, resolved
    // Feature Layers. The map's classifier widens that set; if it ever drops
    // one of these the rack would silently lose a layer the data says works.
    for (const d of mappableDatasets()) {
      expect(classifyLayer(d), d.id).toBe("feature");
    }
  });

  it("accounts for every catalogue row exactly once", () => {
    const kinds = datasets().map(classifyLayer);
    expect(kinds.length).toBe(datasets().length);
    const tally = {
      feature: kinds.filter((k) => k === "feature").length,
      image: kinds.filter((k) => k === "image").length,
      link: kinds.filter((k) => k === "link").length,
    };
    expect(tally.feature + tally.image + tally.link).toBe(67);
    expect(tally.feature).toBeGreaterThan(mappableDatasets().length - 1);
    expect(tally.link).toBeGreaterThan(0);
  });
});

describe("exclusionReason", () => {
  it("explains a portal link and stays null for drawable layers", () => {
    expect(exclusionReason(row("flood-exposure-map"))).toMatch(/web map/i);
    expect(exclusionReason(row("active-faults"))).toBeNull();
    expect(exclusionReason(row("storm-surge"))).toBeNull();
  });

  it("explains a missing endpoint and an empty service distinctly", () => {
    expect(exclusionReason(synthetic({ service_root: null }))).toMatch(/no service endpoint/i);
    expect(exclusionReason(synthetic({ empty_service: true }))).toMatch(/no layers/i);
  });
});

describe("attributionFor", () => {
  it("credits the publisher and the host that served the data", () => {
    const faults = row("active-faults");
    const credit = attributionFor(faults);
    expect(credit).toContain(faults.authority!);
    expect(credit).toContain("gis.gns.cri.nz");
  });

  it("degrades to whichever half it has", () => {
    expect(attributionFor(synthetic({ authority: null, host: "only.host" }))).toBe("only.host");
    expect(attributionFor(synthetic({ authority: "Only Authority", host: undefined }))).toBe(
      "Only Authority",
    );
    expect(attributionFor(synthetic({ authority: null, host: undefined }))).toBe(
      "Source unattributed",
    );
  });
});

describe("describeLayer", () => {
  it("builds a complete feature descriptor from a catalogue row", () => {
    const desc = describeLayer(row("coastal-inundation-high"));
    expect(desc).toMatchObject({
      id: "coastal-inundation-high",
      theme: "coastal_inundation",
      themeLabel: "Coastal Inundation",
      kind: "feature",
      serverType: "MapServer",
      layerIndex: 40,
      host: "gis.wcc.govt.nz",
      excludedReason: null,
      sublayers: null,
    });
    expect(desc.label).toBe("High Coastal Inundation Hazard (Proposed District Plan)");
    expect(desc.serviceUrl!.endsWith("/MapServer/40")).toBe(true);
  });

  it("builds an image descriptor with sublayers and no feature index", () => {
    const desc = describeLayer(row("sea-level-rise"));
    expect(desc.kind).toBe("image");
    expect(desc.layerIndex).toBeNull();
    expect(desc.sublayers).toEqual([1]);
    expect(desc.serviceUrl).toBe(
      "https://mapping1.gw.govt.nz/arcgis/rest/services/Hazards/Sea_Level_Rise/MapServer",
    );
  });

  it("buckets the untethered national rows under one labelled theme", () => {
    const desc = describeLayer(row("shaking-layers"));
    expect(desc.theme).toBe("uncategorised");
    expect(desc.themeLabel).toBe("National & other feeds");
  });

  it("pins one label per theme even where upstream spells it two ways", () => {
    // "Flood data" and "Flood Data" both appear upstream under theme "flood".
    const floodLabels = new Set(
      describeAllLayers()
        .filter((l) => l.theme === "flood")
        .map((l) => l.themeLabel),
    );
    expect(floodLabels.size).toBe(1);
  });
});

describe("toggleableLayers", () => {
  const toggleable = toggleableLayers();
  const ids = new Set(toggleable.map((l) => l.id));

  it("offers a toggle for every hazard the ticket names", () => {
    for (const id of [
      "coastal-inundation-medium",
      "coastal-inundation-high",
      "stream-corridor",
      "overland-flowpath",
      "flood-hazard-areas",
      "active-faults",
      "fault-hazard-overlay",
      "landslide-features",
      "landslide-lines",
      "slope-failure",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("excludes every row that could not be drawn, rather than offering a dead toggle", () => {
    expect(ids.has("flood-exposure-map")).toBe(false);
    for (const layer of toggleable) {
      expect(layer.kind, layer.id).not.toBe("link");
      expect(layer.serviceUrl, layer.id).toBeTruthy();
      expect(layer.excludedReason, layer.id).toBeNull();
    }
  });

  it("leaves every excluded row a way out to its own source", () => {
    const excluded = describeAllLayers().filter((l) => l.kind === "link");
    expect(excluded.length).toBeGreaterThan(0);
    for (const layer of excluded) expect(layer.excludedReason).toBeTruthy();
  });
});

describe("groupLayersByTheme", () => {
  const groups = groupLayersByTheme(toggleableLayers());

  it("leads with coastal inundation and keeps the hazard themes ahead of climate", () => {
    const order = groups.map((g) => g.theme);
    expect(order[0]).toBe("coastal_inundation");
    expect(order.indexOf("flood")).toBeLessThan(order.indexOf("climate"));
    expect(order.indexOf("earthquake")).toBeLessThan(order.indexOf("climate"));
    expect(order.indexOf("landslide")).toBeLessThan(order.indexOf("climate"));
  });

  it("puts every layer in exactly one group and drops empty ones", () => {
    const total = groups.reduce((n, g) => n + g.layers.length, 0);
    expect(total).toBe(toggleableLayers().length);
    for (const group of groups) {
      expect(group.layers.length).toBeGreaterThan(0);
      for (const layer of group.layers) expect(layer.theme).toBe(group.theme);
    }
  });

  it("sorts any theme it does not know about after the ones it does", () => {
    const stranger: LayerDescriptor = { ...describeLayer(row("active-faults")), theme: "zzz-new" };
    const order = groupLayersByTheme([stranger, describeLayer(row("stream-corridor"))]).map(
      (g) => g.theme,
    );
    expect(order).toEqual(["flood", "zzz-new"]);
    expect(THEME_ORDER).not.toContain("zzz-new");
  });
});

describe("layerIdsFromRoute", () => {
  const available = toggleableLayers();

  it("gives a first-time visitor the coastal inundation and fault defaults", () => {
    expect(layerIdsFromRoute({}, available)).toEqual(DEFAULT_LAYER_IDS);
    for (const id of DEFAULT_LAYER_IDS) expect(layerById(id)!.kind).toBe("feature");
  });

  it("honours a deep link exactly", () => {
    expect(layerIdsFromRoute({ layers: ["active-faults", "storm-surge"] }, available)).toEqual([
      "active-faults",
      "storm-surge",
    ]);
  });

  it("treats the sentinel as a deliberately empty map, not a missing key", () => {
    expect(layerIdsFromRoute({ layers: [NO_LAYERS] }, available)).toEqual([]);
  });

  it("drops ids the catalogue no longer offers instead of failing later", () => {
    expect(
      layerIdsFromRoute({ layers: ["active-faults", "gone", "flood-exposure-map"] }, available),
    ).toEqual(["active-faults"]);
  });

  it("round-trips through patchForLayerIds", () => {
    const ids = ["stream-corridor", "landslide-lines"];
    const patch = patchForLayerIds(ids);
    expect(patch.layers).toEqual(ids);
    expect(layerIdsFromRoute({ layers: patch.layers }, available)).toEqual(ids);
  });

  it("round-trips an empty selection without falling back to the defaults", () => {
    const patch = patchForLayerIds([]);
    expect(patch.layers).toEqual([NO_LAYERS]);
    expect(layerIdsFromRoute({ layers: patch.layers }, available)).toEqual([]);
  });
});

describe("humaniseField", () => {
  it("makes ArcGIS column names readable", () => {
    expect(humaniseField("HAZARD_TYPE")).toBe("Hazard type");
    expect(humaniseField("faultName")).toBe("Fault name");
    expect(humaniseField("ari_years")).toBe("Ari years");
  });
});

describe("popupFields", () => {
  it("skips object ids, geometry measurements and editor plumbing", () => {
    const fields = popupFields(
      {
        OBJECTID: 12,
        Shape_Area: 44.2,
        GlobalID: "{abc}",
        last_edited_user: "gis_admin",
        HAZARD_TYPE: "Coastal inundation",
      },
      5,
    );
    expect(fields).toEqual([{ key: "Hazard type", value: "Coastal inundation" }]);
  });

  it("keeps a real field that merely starts with the same letters as a plumbing one", () => {
    const fields = popupFields({ fidelity: "high", shapefile_source: "LINZ" }, 5);
    expect(fields).toEqual([
      { key: "Fidelity", value: "high" },
      { key: "Shapefile source", value: "LINZ" },
    ]);
  });

  it("drops null, empty and literal-'null' values", () => {
    const fields = popupFields({ a: null, b: "  ", c: "null", d: "kept" }, 5);
    expect(fields).toEqual([{ key: "D", value: "kept" }]);
  });

  it("formats numbers and booleans for reading, not for debugging", () => {
    const fields = popupFields({ depth_m: 1.23456, count: 12345, flooded: true }, 5);
    expect(fields).toEqual([
      { key: "Depth m", value: "1.23" },
      { key: "Count", value: "12,345" },
      { key: "Flooded", value: "Yes" },
    ]);
  });

  it("stops at the requested field count", () => {
    expect(popupFields({ a: 1, b: 2, c: 3, d: 4 }).length).toBe(3);
    expect(popupFields({ a: 1, b: 2, c: 3, d: 4 }, 2).length).toBe(2);
  });

  it("truncates a runaway description rather than blowing out the popup", () => {
    const long = "x".repeat(400);
    const [field] = popupFields({ notes: long });
    expect(field.value.length).toBeLessThanOrEqual(90);
    expect(field.value.endsWith("…")).toBe(true);
  });
});

describe("escapeHtml", () => {
  it("neutralises markup from a third-party attribute table", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">&')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;",
    );
  });
});

describe("popupHtml", () => {
  const faults = describeLayer(row("active-faults"));

  it("names the dataset, its theme and a couple of its own attributes", () => {
    const html = popupHtml(faults, { OBJECTID: 4, NAME: "Wellington Fault", SLIPRATE: 6.5 });
    expect(html).toContain("NZ Active Faults (1:250k)");
    expect(html).toContain("Earthquake Hazard data");
    expect(html).toContain("Wellington Fault");
    expect(html).toContain("6.50");
    expect(html).not.toContain("OBJECTID");
  });

  it("carries the dataset id the detail view is opened with", () => {
    expect(popupHtml(faults, {})).toContain('data-dataset="active-faults"');
  });

  it("links out to the authoritative source when the row has one", () => {
    expect(popupHtml(faults, {})).toContain(faults.sourceUrl!);
    const noLink = { ...faults, sourceUrl: null };
    expect(popupHtml(noLink, {})).not.toContain("hz-pop__link");
  });

  it("says so plainly when a feature carries no descriptive attributes", () => {
    const html = popupHtml(faults, { OBJECTID: 1, Shape_Length: 2 });
    expect(html).toContain("no descriptive attributes");
  });

  it("escapes hostile attribute values instead of injecting them", () => {
    const html = popupHtml(faults, { NAME: '<script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("statusReadout", () => {
  it("reports a feature count once a vector channel is live", () => {
    expect(statusReadout("live", "feature", 1234)).toBe("1,234");
    expect(statusReadout("live", "feature", null)).toBe("live");
  });

  it("reports the render mode for an image channel, which has nothing to count", () => {
    expect(statusReadout("live", "image", null)).toBe("image");
  });

  it("distinguishes idle, acquiring and blocked", () => {
    expect(statusReadout("idle", "feature", null)).toBe("off");
    expect(statusReadout("loading", "feature", null)).toBe("···");
    expect(statusReadout("blocked", "feature", null)).toBe("blocked");
  });
});

describe("layerById", () => {
  it("resolves a catalogue id to its descriptor", () => {
    expect(layerById("active-faults")!.kind).toBe("feature");
    expect(layerById("does-not-exist")).toBeUndefined();
  });
});
