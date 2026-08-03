import { describe, expect, it, vi } from "vitest";
import {
  arcgisError,
  createPreviewController,
  describeFetchError,
  detailHtml,
  fetchLayerPreview,
  formatCount,
  geometryLabel,
  isCurrentPaint,
  layerCountUrl,
  layerInfoUrl,
  parseFeatureCount,
  parseLayerInfo,
  probeHtml,
  resolvedLayerIndex,
  type FetchLike,
  type FetchResponseLike,
  type PreviewState,
} from "./detail";
import { datasets, findById, label, layerQueryUrl, type Dataset } from "./catalogue";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE: Dataset = {
  id: "fixture",
  scope: "wcc",
  authority: "Wellington City Council",
  theme: "flood",
  theme_label: "Flood data",
  name: "Fixture layer",
  description: "A fixture.",
  display_name: null,
  year: "2021",
  coverage: "Wellington city",
  url: "https://gis.example.govt.nz/arcgis/rest/services/Hazards/Flood/MapServer/3",
  link_type: "arcgis_rest",
  feature_queryable: true,
  host: "gis.example.govt.nz",
  service_root: "https://gis.example.govt.nz/arcgis/rest/services/Hazards/Flood/MapServer",
  service_path: "Hazards/Flood",
  server_type: "MapServer",
  layer_id: 3,
  resolved_layer: 3,
  default_child: null,
  layer_type: "Feature Layer",
  raster_only: false,
  empty_service: false,
};

function dataset(patch: Partial<Dataset>): Dataset {
  return { ...BASE, ...patch };
}

/** A representative trimmed ArcGIS `<service>/<layer>?f=json` payload. */
const ARCGIS_LAYER_JSON = {
  currentVersion: 10.91,
  id: 39,
  name: "Medium Coastal Inundation Hazard",
  type: "Feature Layer",
  geometryType: "esriGeometryPolygon",
  minScale: 0,
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID" },
    { name: "SCENARIO", type: "esriFieldTypeString", alias: "Scenario" },
    { name: "DEPTH_M", type: "esriFieldTypeDouble", alias: "Depth (m)" },
    { name: "Shape.STArea()", type: "esriFieldTypeDouble", alias: "Shape.STArea()" },
  ],
};

function response(json: unknown, init: { ok?: boolean; status?: number } = {}): FetchResponseLike {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => json };
}

/** A fetch double that answers from a url-substring → payload table and
 * records every url it was called with. */
function fakeFetch(routes: { match: string; body: unknown; ok?: boolean; status?: number }[]): {
  fetchImpl: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unrouted url: ${url}`);
    return response(route.body, { ok: route.ok, status: route.status });
  };
  return { fetchImpl, urls };
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

describe("resolvedLayerIndex / layerInfoUrl / layerCountUrl", () => {
  it("prefers resolved_layer over default_child and layer_id", () => {
    const d = dataset({ resolved_layer: 7, default_child: 15, layer_id: 2 });
    expect(resolvedLayerIndex(d)).toBe(7);
    expect(layerInfoUrl(d)).toBe(`${BASE.service_root}/7?f=json`);
  });

  it("falls back to default_child when resolved_layer is null", () => {
    const d = dataset({ resolved_layer: null, default_child: 15, layer_id: 2 });
    expect(resolvedLayerIndex(d)).toBe(15);
    expect(layerInfoUrl(d)).toBe(`${BASE.service_root}/15?f=json`);
  });

  it("falls back to layer_id only when both resolved_layer and default_child are null", () => {
    const d = dataset({ resolved_layer: null, default_child: null, layer_id: 2 });
    expect(resolvedLayerIndex(d)).toBe(2);
    expect(layerInfoUrl(d)).toBe(`${BASE.service_root}/2?f=json`);
  });

  it("keeps a layer index of 0 rather than treating it as absent", () => {
    const d = dataset({ resolved_layer: 0, default_child: 15, layer_id: 9 });
    expect(resolvedLayerIndex(d)).toBe(0);
    expect(layerInfoUrl(d)).toBe(`${BASE.service_root}/0?f=json`);
  });

  it("is null when the dataset is not feature-queryable", () => {
    const d = dataset({ feature_queryable: false, raster_only: true, layer_type: "Raster Layer" });
    expect(layerInfoUrl(d)).toBeNull();
    expect(layerCountUrl(d)).toBeNull();
  });

  it("is null when there is no service root (portal / web links)", () => {
    const d = dataset({ link_type: "web", service_root: null });
    expect(layerInfoUrl(d)).toBeNull();
    expect(layerCountUrl(d)).toBeNull();
  });

  it("is null when no layer index can be resolved at all", () => {
    const d = dataset({ resolved_layer: null, default_child: null, layer_id: null });
    expect(resolvedLayerIndex(d)).toBeNull();
    expect(layerInfoUrl(d)).toBeNull();
  });

  it("builds a returnCountOnly query against the same resolved layer", () => {
    const d = dataset({ resolved_layer: null, default_child: 15 });
    expect(layerCountUrl(d)).toBe(`${BASE.service_root}/15/query?where=1%3D1&returnCountOnly=true&f=json`);
  });

  it("is non-null for exactly the datasets catalogue.layerQueryUrl is non-null for", () => {
    const mismatched = datasets().filter((d) => (layerInfoUrl(d) === null) !== (layerQueryUrl(d) === null));
    expect(mismatched.map((d) => d.id)).toEqual([]);
    expect(datasets().filter((d) => layerInfoUrl(d) !== null).length).toBeGreaterThan(0);
  });

  it("resolves the real catalogue's group-layer row through default_child", () => {
    const d = findById("flood-depths")!;
    expect(d.resolved_layer).toBeNull();
    expect(layerInfoUrl(d)).toBe(`${d.service_root}/${d.default_child}?f=json`);
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseLayerInfo", () => {
  it("reads name, geometry type, layer kind and field names from a real payload", () => {
    const info = parseLayerInfo(ARCGIS_LAYER_JSON)!;
    expect(info.name).toBe("Medium Coastal Inundation Hazard");
    expect(info.geometryType).toBe("esriGeometryPolygon");
    expect(info.layerType).toBe("Feature Layer");
    expect(info.fields.map((f) => f.name)).toEqual([
      "OBJECTID",
      "SCENARIO",
      "DEPTH_M",
      "Shape.STArea()",
    ]);
    expect(info.fields[1]).toEqual({
      name: "SCENARIO",
      alias: "Scenario",
      type: "esriFieldTypeString",
    });
  });

  it("tolerates a payload with no fields array", () => {
    const info = parseLayerInfo({ name: "Group", type: "Group Layer" })!;
    expect(info.fields).toEqual([]);
    expect(info.geometryType).toBeNull();
  });

  it("skips field entries that are not objects with a name", () => {
    const info = parseLayerInfo({
      geometryType: "esriGeometryPoint",
      fields: [null, "OBJECTID", { alias: "no name" }, { name: "GOOD" }],
    })!;
    expect(info.fields.map((f) => f.name)).toEqual(["GOOD"]);
  });

  it("returns null for malformed input", () => {
    for (const bad of [null, undefined, 42, "not json", [], {}, { fields: "nope" }]) {
      expect(parseLayerInfo(bad)).toBeNull();
    }
  });

  it("returns null for an ArcGIS error payload served with HTTP 200", () => {
    expect(parseLayerInfo({ error: { code: 400, message: "Invalid or missing input parameters." } })).toBeNull();
  });
});

describe("arcgisError", () => {
  it("surfaces the service's own message and code", () => {
    expect(arcgisError({ error: { code: 500, message: "Token Required" } })).toBe("Token Required (500)");
  });

  it("is null for a healthy payload", () => {
    expect(arcgisError(ARCGIS_LAYER_JSON)).toBeNull();
    expect(arcgisError(null)).toBeNull();
  });
});

describe("parseFeatureCount", () => {
  it("reads a returnCountOnly response", () => {
    expect(parseFeatureCount({ count: 1234 })).toBe(1234);
    expect(parseFeatureCount({ count: 0 })).toBe(0);
  });

  it("returns null (unknown) rather than 0 for anything unusable", () => {
    for (const bad of [null, {}, { count: "12" }, { count: -1 }, { count: Number.NaN }]) {
      expect(parseFeatureCount(bad)).toBeNull();
    }
  });
});

describe("geometryLabel / formatCount", () => {
  it("humanises esri geometry constants", () => {
    expect(geometryLabel("esriGeometryPolygon")).toBe("Polygon");
    expect(geometryLabel("esriGeometryPolyline")).toBe("Polyline");
    expect(geometryLabel("esriGeometryPoint")).toBe("Point");
    expect(geometryLabel("esriGeometryWeird")).toBe("Weird");
    expect(geometryLabel(null)).toBe("—");
  });

  it("groups thousands without depending on host ICU data", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});

describe("describeFetchError", () => {
  it("names a timeout/abort as such", () => {
    const err = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    expect(describeFetchError(err)).toBe("The layer service did not respond in time.");
  });

  it("reports an HTTP status verbatim", () => {
    expect(describeFetchError(new Error("HTTP 503"))).toBe("The layer service returned HTTP 503.");
  });

  it("falls back to a reachability sentence for a network failure", () => {
    expect(describeFetchError(new TypeError("Failed to fetch"))).toMatch(/Could not reach the layer service/);
  });
});

// ---------------------------------------------------------------------------
// fetchLayerPreview — injected fetch, never the network
// ---------------------------------------------------------------------------

describe("fetchLayerPreview", () => {
  it("probes both endpoints and returns geometry, fields and count", async () => {
    const { fetchImpl, urls } = fakeFetch([
      { match: "returnCountOnly", body: { count: 1234 } },
      { match: "?f=json", body: ARCGIS_LAYER_JSON },
    ]);
    const state = await fetchLayerPreview(dataset({}), fetchImpl);

    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("unreachable");
    expect(state.count).toBe(1234);
    expect(state.info.geometryType).toBe("esriGeometryPolygon");
    expect(state.info.fields).toHaveLength(4);
    expect(urls).toEqual([`${BASE.service_root}/3?f=json`, layerCountUrl(BASE)]);
  });

  it("still reports the layer when only the count query fails", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("returnCountOnly")) throw new TypeError("Failed to fetch");
      return response(ARCGIS_LAYER_JSON);
    };
    const state = await fetchLayerPreview(dataset({}), fetchImpl);

    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("unreachable");
    expect(state.count).toBeNull();
    expect(state.info.name).toBe("Medium Coastal Inundation Hazard");
  });

  it("returns an error state when the metadata request fails at the network", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const state = await fetchLayerPreview(dataset({}), fetchImpl);
    expect(state).toEqual({
      status: "error",
      message: "Could not reach the layer service — it may be offline or blocking this browser.",
    });
  });

  it("returns an error state on a non-ok HTTP response", async () => {
    const { fetchImpl } = fakeFetch([{ match: "?f=json", body: {}, ok: false, status: 404 }]);
    const state = await fetchLayerPreview(dataset({}), fetchImpl);
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toBe("The layer service returned HTTP 404.");
  });

  it("surfaces an ArcGIS error payload served with HTTP 200", async () => {
    const { fetchImpl } = fakeFetch([
      { match: "?f=json", body: { error: { code: 499, message: "Token Required" } } },
    ]);
    const state = await fetchLayerPreview(dataset({}), fetchImpl);
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toContain("Token Required (499)");
  });

  it("returns an error state when the response is not layer metadata", async () => {
    const { fetchImpl } = fakeFetch([{ match: "?f=json", body: "<html>proxy login</html>" }]);
    const state = await fetchLayerPreview(dataset({}), fetchImpl);
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/not with layer metadata/);
  });

  it("never touches the network for a non-queryable dataset", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response({}));
    const state = await fetchLayerPreview(dataset({ feature_queryable: false }), fetchImpl);
    expect(state).toEqual({ status: "unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stale-response guard
// ---------------------------------------------------------------------------

/** A fetch double whose responses are released by hand, so two probes can be
 * held in flight at once and resolved out of order. A released route stays
 * released, so the follow-up count request a probe issues *after* its metadata
 * request resolves is answered too. */
function deferredFetch(): {
  fetchImpl: FetchLike;
  release: (match: string, body: unknown) => void;
  pending: number;
} {
  type Waiter = { url: string; resolve: (r: FetchResponseLike) => void };
  let waiting: Waiter[] = [];
  const answers = new Map<string, unknown>();

  const answerFor = (url: string): { body: unknown } | null => {
    for (const [match, body] of answers) if (url.includes(match)) return { body };
    return null;
  };

  return {
    fetchImpl: (url) =>
      new Promise<FetchResponseLike>((resolve) => {
        const answer = answerFor(url);
        if (answer) resolve(response(answer.body));
        else waiting.push({ url, resolve });
      }),
    release(match: string, body: unknown) {
      answers.set(match, body);
      const hit = waiting.filter((w) => w.url.includes(match));
      waiting = waiting.filter((w) => !w.url.includes(match));
      for (const entry of hit) entry.resolve(response(body));
    },
    get pending() {
      return waiting.length;
    },
  };
}

describe("isCurrentPaint", () => {
  const alpha = dataset({ id: "alpha" });
  const beta = dataset({ id: "beta" });

  it("accepts a paint for the selected dataset", () => {
    expect(isCurrentPaint("alpha", alpha)).toBe(true);
  });

  it("rejects a paint for a dataset that has since been deselected", () => {
    expect(isCurrentPaint("alpha", beta)).toBe(false);
    expect(isCurrentPaint("alpha", undefined)).toBe(false);
  });

  it("accepts the no-dataset paint, so an unknown deep-linked id still renders", () => {
    // The requested id is "no-such-dataset", but findById resolves nothing —
    // the panel must still repaint into its "no such dataset" state.
    expect(isCurrentPaint(undefined, undefined)).toBe(true);
  });
});

describe("createPreviewController", () => {
  const alpha = dataset({ id: "alpha", resolved_layer: 1 });
  const beta = dataset({ id: "beta", resolved_layer: 2 });

  it("paints loading immediately and ready when the probe resolves", async () => {
    const painted: [string | undefined, PreviewState][] = [];
    const { fetchImpl, release } = deferredFetch();
    const controller = createPreviewController((id, state) => painted.push([id, state]), fetchImpl);

    controller.select(alpha);
    expect(painted).toEqual([["alpha", { status: "loading" }]]);
    expect(controller.state()).toEqual({ status: "loading" });

    release("/1?f=json", ARCGIS_LAYER_JSON);
    release("returnCountOnly", { count: 7 });
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));

    const [id, state] = painted[painted.length - 1];
    expect(id).toBe("alpha");
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("unreachable");
    expect(state.count).toBe(7);
  });

  it("discards a response for a dataset that is no longer selected", async () => {
    const painted: [string | undefined, PreviewState][] = [];
    const { fetchImpl, release } = deferredFetch();
    const controller = createPreviewController((id, state) => painted.push([id, state]), fetchImpl);

    // Rapid card-switching: alpha's probe is still in flight when beta wins.
    controller.select(alpha);
    controller.select(beta);

    // alpha answers *after* beta was selected — it must not paint.
    release("/1?f=json", { ...ARCGIS_LAYER_JSON, name: "ALPHA LAYER" });
    release("returnCountOnly", { count: 111 });
    await new Promise((r) => setTimeout(r, 0));

    expect(painted.map(([id, s]) => `${id}:${s.status}`)).toEqual(["alpha:loading", "beta:loading"]);
    expect(controller.state()).toEqual({ status: "loading" });

    // beta answers and is painted, with beta's own data.
    release("/2?f=json", { ...ARCGIS_LAYER_JSON, name: "BETA LAYER" });
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));

    const [id, state] = painted[painted.length - 1];
    expect(id).toBe("beta");
    if (state.status !== "ready") throw new Error("unreachable");
    expect(state.info.name).toBe("BETA LAYER");
    expect(painted.some(([, s]) => s.status === "ready" && s.info.name === "ALPHA LAYER")).toBe(false);
  });

  it("paints unavailable without a request for a non-queryable dataset", () => {
    const painted: [string | undefined, PreviewState][] = [];
    const { fetchImpl, pending } = deferredFetch();
    const controller = createPreviewController((id, state) => painted.push([id, state]), fetchImpl);

    controller.select(dataset({ id: "portal", feature_queryable: false, service_root: null }));
    expect(painted).toEqual([["portal", { status: "unavailable" }]]);
    expect(pending).toBe(0);
  });

  it("paints idle when the selection is cleared", () => {
    const painted: [string | undefined, PreviewState][] = [];
    const { fetchImpl } = deferredFetch();
    const controller = createPreviewController((id, state) => painted.push([id, state]), fetchImpl);

    controller.select(alpha);
    controller.select(undefined);
    expect(painted[painted.length - 1]).toEqual([undefined, { status: "idle" }]);
  });
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const READY: PreviewState = {
  status: "ready",
  info: parseLayerInfo(ARCGIS_LAYER_JSON)!,
  count: 1234,
};

describe("detailHtml — selected dataset", () => {
  const d = findById("coastal-inundation-medium")!;
  const html = detailHtml(d, READY, d.id);

  it("renders the dataset's label, id, theme, scope, authority and year", () => {
    expect(html).toContain(label(d));
    expect(html).toContain(d.id);
    expect(html).toContain(d.theme_label);
    expect(html).toContain("WCC");
    expect(html).toContain(d.authority!);
    expect(html).toContain(d.year!);
  });

  it("renders an em-dash for a null description and null coverage", () => {
    expect(d.description).toBeNull();
    expect(d.coverage).toBeNull();
    expect(html).toContain(`<span class="dossier__nil">—</span>`);
  });

  it("renders a real description when there is one", () => {
    const withText = findById("flood-depths")!;
    const out = detailHtml(withText, { status: "loading" }, withText.id);
    expect(out).toContain("flood hazard map");
  });

  it("links the source url as a safe external link", () => {
    expect(html).toContain(`href="${d.url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("refuses a non-http(s) url rather than emitting it as an href", () => {
    const hostile = dataset({ url: "javascript:alert(1)" });
    const out = detailHtml(hostile, { status: "unavailable" }, hostile.id);
    expect(out).not.toContain("javascript:");
    expect(out).toContain("No public source link");
  });

  it("escapes catalogue text rather than injecting it as markup", () => {
    const nasty = dataset({ display_name: `<img src=x onerror="boom">`, description: "A & B" });
    const out = detailHtml(nasty, { status: "unavailable" }, nasty.id);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("A &amp; B");
  });

  it("offers a dismiss control wired to the close action", () => {
    expect(html).toContain('data-action="detail-close"');
  });

  it("renders the ready probe: geometry, grouped count and field names", () => {
    expect(html).toContain("Polygon");
    expect(html).toContain("1,234");
    expect(html).toContain("features");
    expect(html).toContain("OBJECTID");
    expect(html).toContain("DEPTH_M");
    expect(html).toContain('data-status="ready"');
  });
});

describe("detailHtml — empty and unknown states", () => {
  it("invites a selection when nothing is selected, without throwing", () => {
    const html = detailHtml(undefined, { status: "idle" });
    expect(html).toContain("Nothing selected yet");
    expect(html).toContain("dossier--empty");
    expect(html).not.toContain("probe__status");
  });

  it("explains an unknown deep-linked id instead of rendering a blank panel", () => {
    const html = detailHtml(undefined, { status: "idle" }, "no-such-dataset");
    expect(html).toContain("no-such-dataset");
    expect(html).toContain("No dataset in this catalogue has the id");
    expect(html).toContain('data-action="detail-close"');
  });

  it("escapes an unknown id taken straight from the URL hash", () => {
    const html = detailHtml(undefined, { status: "idle" }, '"><script>x</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("probeHtml — per-state markup", () => {
  const d = dataset({});

  it("shows skeleton shapes, not a spinner or 'Loading…', while probing", () => {
    const html = probeHtml(d, { status: "loading" });
    expect(html).toContain('data-status="loading"');
    expect(html).toContain("dsk--readout");
    expect(html).toContain("dsk--field");
    expect(html).not.toContain("Loading...");
  });

  it("explains a non-queryable dataset instead of leaving a probe running", () => {
    const portal = dataset({ link_type: "arcgis_portal", feature_queryable: false, service_root: null });
    const html = probeHtml(portal, { status: "unavailable" });
    expect(html).toContain("no live preview is available");
    expect(html).toContain("portal item");
    expect(html).toContain('data-status="unavailable"');
    expect(html).not.toContain("dsk--readout");
  });

  it("shows the error message inline with a retry control", () => {
    const html = probeHtml(d, { status: "error", message: "The layer service returned HTTP 503." });
    expect(html).toContain("The layer service returned HTTP 503.");
    expect(html).toContain('data-action="detail-retry"');
    expect(html).toContain('data-status="error"');
  });

  it("keeps the metadata visible when the probe errors", () => {
    const html = detailHtml(d, { status: "error", message: "Could not reach the layer service." });
    expect(html).toContain(label(d));
    expect(html).toContain(d.theme_label);
    expect(html).toContain("Could not reach the layer service.");
  });

  it("says the count is unavailable rather than claiming zero features", () => {
    const html = probeHtml(d, { status: "ready", info: parseLayerInfo(ARCGIS_LAYER_JSON)!, count: null });
    expect(html).toContain("count unavailable");
    expect(html).not.toContain(">0<");
  });

  it("caps the field list at ten names and counts the remainder", () => {
    const fields = Array.from({ length: 27 }, (_, i) => ({ name: `FIELD_${i}`, type: "esriFieldTypeString" }));
    const info = parseLayerInfo({ ...ARCGIS_LAYER_JSON, fields })!;
    const html = probeHtml(d, { status: "ready", info, count: 3 });
    expect(html).toContain("FIELD_9");
    expect(html).not.toContain("FIELD_10<");
    expect(html).toContain("+17 more");
    expect(html).toContain('<span class="probe__count">3</span>');
    expect(html).toContain(">features<");
  });

  it("says 'feature', not 'features', for a single-feature layer", () => {
    const html = probeHtml(d, { status: "ready", info: parseLayerInfo(ARCGIS_LAYER_JSON)!, count: 1 });
    expect(html).toContain('<span class="probe__count">1</span>');
    expect(html).toContain(">feature<");
    expect(html).not.toContain(">features<");
  });
});
