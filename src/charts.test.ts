import { describe, expect, it, vi } from "vitest";
import renderCharts, {
  buildChartModel,
  chartDecision,
  chartGeometry,
  chartHtml,
  formatChange,
  identifyUrl,
  isIdentifyResponseBody,
  isScenarioTreeBody,
  parentLayerIndex,
  parseHorizon,
  parseIdentifyValue,
  parseIdentifyValues,
  parseScenario,
  SAMPLE_POINT,
  scenarioTreeUrl,
  selectScenarioLayers,
  serviceErrorMessage,
  shortLayerLabel,
  unitFromDescription,
  type ScenarioLayer,
} from "./charts";
import { climateDatasets, datasets, findById, label, type Dataset } from "./catalogue";

/** A catalogue row, by id, that the test can rely on existing. */
function row(id: string): Dataset {
  const d = findById(id);
  if (!d) throw new Error(`catalogue row ${id} missing — fixture assumption broken`);
  return d;
}

// ---------------------------------------------------------------------------
// Fixtures: the two shapes an ArcGIS MapServer describes its layer tree in.
// ---------------------------------------------------------------------------

/** `{service_root}/126?f=json` — the group layer's own document, which lists
 * its children as `{id, name}` stubs. This is the body the module fetches. */
const parentDocument = {
  id: 126,
  name: "Mean temperature",
  type: "Group Layer",
  parentLayerId: -1,
  subLayers: [
    { id: 127, name: "Mean temperature RCP2.6 2031-2050" },
    { id: 128, name: "Mean temperature RCP8.5 2081-2100" },
    { id: 129, name: "Mean temperature RCP4.5 2031-2050" },
  ],
};

/** `{service_root}/layers?f=json` — the whole tree, with parent/child ids and
 * an extra level of grouping under the variable. */
const serviceTree = {
  layers: [
    { id: 10, name: "Windy days", type: "Group Layer", parentLayerId: -1, subLayerIds: [11] },
    { id: 11, name: "Windy days RCP2.6 2040", type: "Raster Layer", parentLayerId: 10, subLayerIds: null },
    { id: 126, name: "Mean temperature", type: "Group Layer", parentLayerId: -1, subLayerIds: [127, 130] },
    { id: 127, name: "RCP2.6", type: "Group Layer", parentLayerId: 126, subLayerIds: [128, 129] },
    { id: 128, name: "Mean temperature RCP2.6 2040", type: "Raster Layer", parentLayerId: 127, subLayerIds: null },
    { id: 129, name: "Mean temperature RCP2.6 2090", type: "Raster Layer", parentLayerId: 127, subLayerIds: null },
    { id: 130, name: "Mean temperature RCP8.5 2040", type: "Raster Layer", parentLayerId: 126, subLayerIds: null },
  ],
};

describe("selectScenarioLayers", () => {
  it("reads the scenario children out of the group layer's own document", () => {
    const layers = selectScenarioLayers(parentDocument, 126);
    expect(layers.map((l) => l.id)).toEqual([127, 129, 128]); // ordered by horizon, then scenario
    expect(layers[0]).toEqual({
      id: 127,
      name: "Mean temperature RCP2.6 2031-2050",
      label: "RCP2.6 2031-2050",
      scenario: "RCP 2.6",
      horizon: "2031–2050",
      horizonYear: 2031,
    });
  });

  it("strips the variable's own name off every child label", () => {
    const labels = selectScenarioLayers(parentDocument, 126).map((l) => l.label);
    expect(labels).toEqual(["RCP2.6 2031-2050", "RCP4.5 2031-2050", "RCP8.5 2081-2100"]);
    expect(labels.every((l) => !l.includes("Mean temperature"))).toBe(true);
  });

  it("walks the full service tree, through nested groups, and charts only leaves", () => {
    const layers = selectScenarioLayers(serviceTree, 126);
    expect(layers.map((l) => l.id)).toEqual([128, 130, 129]);
    expect(layers.map((l) => l.scenario)).toEqual(["RCP 2.6", "RCP 8.5", "RCP 2.6"]);
    expect(layers.map((l) => l.horizon)).toEqual(["2040", "2040", "2090"]);
    // 127 is a group layer (it has children of its own) and 11 belongs to a
    // different variable entirely — neither is a bar.
    expect(layers.some((l) => l.id === 127 || l.id === 11)).toBe(false);
  });

  it("keeps service order when the names carry no time horizon to sort on", () => {
    const layers = selectScenarioLayers(
      {
        id: 5,
        name: "Something",
        subLayers: [
          { id: 8, name: "Something — high" },
          { id: 6, name: "Something — low" },
          { id: 7, name: "Something — medium" },
        ],
      },
      5,
    );
    expect(layers.map((l) => l.id)).toEqual([8, 6, 7]);
    expect(layers.map((l) => l.label)).toEqual(["high", "low", "medium"]);
    expect(layers.every((l) => l.scenario === null && l.horizon === null)).toBe(true);
  });

  it("is empty — never throws — for a group with no children, a wrong parent, or junk", () => {
    expect(selectScenarioLayers({ id: 126, name: "Mean temperature", subLayers: [] }, 126)).toEqual([]);
    expect(selectScenarioLayers(parentDocument, 999)).toEqual([]);
    expect(selectScenarioLayers(null, 126)).toEqual([]);
    expect(selectScenarioLayers("<html>502 Bad Gateway</html>", 126)).toEqual([]);
    expect(selectScenarioLayers({ error: { message: "Layer not found" } }, 126)).toEqual([]);
    expect(selectScenarioLayers({ layers: "not an array" }, 126)).toEqual([]);
  });
});

describe("parseScenario / parseHorizon / shortLayerLabel", () => {
  it("normalises however the service spells the scenario", () => {
    expect(parseScenario("Mean temp RCP8.5 2090")).toBe("RCP 8.5");
    expect(parseScenario("rcp 2.6 (2031-2050)")).toBe("RCP 2.6");
    expect(parseScenario("SSP2_6 2040")).toBe("SSP 2.6");
    expect(parseScenario("Mean temperature")).toBeNull();
  });

  it("reads a single year or a range, and the year to sort on", () => {
    expect(parseHorizon("RCP8.5 2090")).toEqual({ horizon: "2090", year: 2090 });
    expect(parseHorizon("RCP8.5 2031-2050")).toEqual({ horizon: "2031–2050", year: 2031 });
    expect(parseHorizon("RCP8.5 2081 to 2100")).toEqual({ horizon: "2081–2100", year: 2081 });
    expect(parseHorizon("baseline")).toEqual({ horizon: null, year: null });
  });

  it("falls back to the full name rather than an empty tick label", () => {
    expect(shortLayerLabel("Mean temperature", "Mean temperature")).toBe("Mean temperature");
    expect(shortLayerLabel("Mean temperature - RCP8.5", "mean temperature")).toBe("RCP8.5");
    expect(shortLayerLabel("RCP8.5", null)).toBe("RCP8.5");
  });
});

describe("parseIdentifyValue", () => {
  it("reads the raster reading the service actually sends (a string)", () => {
    expect(parseIdentifyValue("0.72")).toBe(0.72);
    expect(parseIdentifyValue(" -1.25 ")).toBe(-1.25);
    expect(parseIdentifyValue("1,024.5")).toBe(1024.5);
    expect(parseIdentifyValue(2.5)).toBe(2.5);
    expect(parseIdentifyValue("0")).toBe(0);
  });

  it("skips a miss instead of charting it as zero", () => {
    expect(parseIdentifyValue("NoData")).toBeNull();
    expect(parseIdentifyValue("no data")).toBeNull();
    expect(parseIdentifyValue("N/A")).toBeNull();
    expect(parseIdentifyValue("-9999")).toBeNull();
    expect(parseIdentifyValue("")).toBeNull();
    expect(parseIdentifyValue(null)).toBeNull();
    expect(parseIdentifyValue(undefined)).toBeNull();
    expect(parseIdentifyValue(Number.NaN)).toBeNull();
    expect(parseIdentifyValue({ value: 3 })).toBeNull();
  });
});

describe("parseIdentifyValues", () => {
  const body = {
    results: [
      { layerId: 127, layerName: "RCP2.6 2031-2050", value: "0.72", attributes: { "Pixel Value": "0.72" } },
      { layerId: 128, layerName: "RCP4.5 2031-2050", value: "NoData", attributes: { "Pixel Value": "NoData" } },
      { layerId: 129, layerName: "RCP8.5 2081-2100", value: "", attributes: { "Raster.ServicePixelValue": "-1.25" } },
      { layerId: 130, layerName: "RCP8.5 2031-2050", value: "1,024.5" },
    ],
  };

  it("maps each layer to its sampled value, skipping the NoData ones", () => {
    const values = parseIdentifyValues(body);
    expect([...values.entries()]).toEqual([
      [127, 0.72],
      [129, -1.25],
      [130, 1024.5],
    ]);
    expect(values.has(128)).toBe(false);
  });

  it("keeps the first usable hit when identify returns several for one layer", () => {
    const values = parseIdentifyValues({
      results: [
        { layerId: 127, value: "1.5" },
        { layerId: 127, value: "9.9" },
      ],
    });
    expect(values.get(127)).toBe(1.5);
  });

  it("is empty — never throws — for malformed bodies", () => {
    expect(parseIdentifyValues(null).size).toBe(0);
    expect(parseIdentifyValues({}).size).toBe(0);
    expect(parseIdentifyValues({ results: "none" }).size).toBe(0);
    expect(parseIdentifyValues({ error: { message: "Invalid parameters" } }).size).toBe(0);
    expect(parseIdentifyValues({ results: [null, 7, { layerId: "127", value: "1" }] }).size).toBe(0);
  });
});

describe("chartGeometry", () => {
  it("puts the zero line where zero falls and hangs negative bars below it", () => {
    const g = chartGeometry([2, -2]);
    expect(g.domain).toEqual({ min: -2, max: 2 });
    expect(g.baselineY).toBe(102); // top 26 + half of the 152px plot
    expect(g.plot).toEqual({ x: 38, y: 26, width: 136, height: 152 });

    const [up, down] = g.bars;
    expect(up).toMatchObject({ value: 2, negative: false, x: 57, y: 26, width: 30, height: 76 });
    expect(down).toMatchObject({ value: -2, negative: true, x: 125, y: 102, width: 30, height: 76 });
    // The bar below the line starts *at* the baseline and grows downwards.
    expect(down!.y).toBe(g.baselineY);
    expect(up!.y + up!.height).toBe(g.baselineY);
  });

  it("keeps value labels clear of the bar: above a rise, below a fall", () => {
    const g = chartGeometry([2, -2]);
    expect(g.bars[0]!.labelY).toBe(18); // 26 - 8, in the headroom above the plot
    expect(g.bars[1]!.labelY).toBe(191); // below the bar's foot, above the ticks
    expect(g.ticks).toEqual({ y1: 210, y2: 224 });
    expect(g.height).toBe(234);
  });

  it("baselines an all-positive series at the foot of the plot", () => {
    const g = chartGeometry([1, 2, 4]);
    expect(g.domain).toEqual({ min: 0, max: 4 });
    expect(g.baselineY).toBe(178);
    expect(g.bars.map((b) => b.height)).toEqual([38, 76, 152]);
    expect(g.bars.every((b) => b.negative === false)).toBe(true);
  });

  it("baselines an all-negative series at the top of the plot", () => {
    const g = chartGeometry([-2, -4]);
    expect(g.domain).toEqual({ min: -4, max: 0 });
    expect(g.baselineY).toBe(26);
    expect(g.bars.map((b) => b.height)).toEqual([76, 152]);
    expect(g.bars.every((b) => b.negative && b.y === 26)).toBe(true);
  });

  it("centres the line, with flat bars, when every scenario projects no change", () => {
    const g = chartGeometry([0, 0]);
    expect(g.domain).toEqual({ min: -1, max: 1 });
    expect(g.baselineY).toBe(102);
    expect(g.bars.map((b) => b.height)).toEqual([0, 0]);
  });

  it("keeps a real-but-tiny change visible instead of a hairline", () => {
    const up = chartGeometry([100, 0.5]).bars[1]!;
    expect(up.height).toBe(2);
    expect(up.y).toBe(176); // still standing on the 178px baseline
    const down = chartGeometry([-100, -0.5]).bars[1]!;
    expect(down.height).toBe(2);
    expect(down.y).toBe(26);
  });

  it("lays the bars out on an even grid that grows with the series", () => {
    const g = chartGeometry([1, 2, 3, 4]);
    expect(g.bars.map((b) => b.center)).toEqual([72, 140, 208, 276]);
    expect(g.width).toBe(38 + 4 * 68 + 14);
    expect(g.slot).toBe(68);
  });

  it("honours the layout options rather than hardcoding one size", () => {
    const g = chartGeometry([1, -1], { slot: 40, barWidth: 20, left: 10, right: 10, top: 10, plotHeight: 100 });
    expect(g.width).toBe(100);
    expect(g.plot).toEqual({ x: 10, y: 10, width: 80, height: 100 });
    expect(g.baselineY).toBe(60);
    expect(g.bars.map((b) => b.height)).toEqual([50, 50]);
    expect(g.bars.map((b) => b.width)).toEqual([20, 20]);
  });
});

describe("unitFromDescription", () => {
  it("reads the unit out of the upstream wording", () => {
    expect(unitFromDescription("Mean temperature (annual changes in deg C)")).toEqual({
      phrase: "annual changes in deg C",
      symbol: "°C",
    });
    expect(unitFromDescription("Hot days >25C (changes in days per year)").symbol).toBe("days");
    expect(unitFromDescription("Total rainfall (changes in % per year)").symbol).toBe("%");
    expect(unitFromDescription("Growing degree days base 5C (changes in GDD units per year)").symbol).toBe("GDD");
    expect(unitFromDescription("PED (PED, changes in mm accumulation per year)").symbol).toBe("mm");
  });

  it("takes the last parenthesis, not the first", () => {
    const unit = unitFromDescription(
      "Potential evapotranspiration deficit (PED) days over 300mm (changes in days per year)",
    );
    expect(unit.phrase).toBe("changes in days per year");
    expect(unit.symbol).toBe("days");
  });

  it("has no unit to report rather than inventing one", () => {
    expect(unitFromDescription(null)).toEqual({ phrase: null, symbol: null });
    expect(unitFromDescription("   ")).toEqual({ phrase: null, symbol: null });
    expect(unitFromDescription("Sea level rise (relative to 1986-2005)").symbol).toBeNull();
  });

  it("labels every climate dataset in the catalogue", () => {
    const climate = climateDatasets();
    expect(climate).toHaveLength(21);
    for (const d of climate) {
      const unit = unitFromDescription(d.description);
      expect(unit.phrase, `${d.id} has no unit wording`).toBeTruthy();
      expect(unit.symbol, `${d.id} has no unit symbol`).toBeTruthy();
    }
  });
});

describe("formatChange", () => {
  it("always states the sign — every one of these layers is a change", () => {
    expect(formatChange(1.4, "°C")).toBe("+1.40 °C");
    expect(formatChange(-2.35, "days")).toBe("−2.35 days");
    expect(formatChange(0, "%")).toBe("±0.00 %");
  });

  it("scales precision to magnitude, and drops the unit when there is none", () => {
    expect(formatChange(12.34, "days")).toBe("+12.3 days");
    expect(formatChange(124.6, "GDD")).toBe("+125 GDD");
    expect(formatChange(1.4, null)).toBe("+1.40");
  });

  it("widens precision rather than rounding a real sub-cent change to a sign-less zero", () => {
    expect(formatChange(0.004, "°C")).toBe("+0.004 °C");
    expect(formatChange(-0.004, "°C")).toBe("−0.004 °C");
    expect(formatChange(0.00006, "°C")).toBe("+0.0001 °C");
    // A true zero still reads as the plain, two-decimal "±0.00" — only a
    // non-zero value that would otherwise vanish gets the extra digits.
    expect(formatChange(0, "°C")).toBe("±0.00 °C");
  });
});

describe("isScenarioTreeBody", () => {
  it("accepts a service-wide layer tree and a single layer document", () => {
    expect(isScenarioTreeBody(serviceTree)).toBe(true);
    expect(isScenarioTreeBody(parentDocument)).toBe(true);
    expect(isScenarioTreeBody({ id: 0, name: "Layer zero", subLayers: [] })).toBe(true);
  });

  it("rejects a body with neither a layers array nor its own id — a broken response, not an empty tree", () => {
    expect(isScenarioTreeBody({})).toBe(false);
    expect(isScenarioTreeBody(null)).toBe(false);
    expect(isScenarioTreeBody("<html>502 Bad Gateway</html>")).toBe(false);
    expect(isScenarioTreeBody({ layers: "not an array" })).toBe(false);
    expect(isScenarioTreeBody({ error: { message: "Layer not found" } })).toBe(false);
  });
});

describe("isIdentifyResponseBody", () => {
  it("accepts any results array, including an empty one", () => {
    expect(isIdentifyResponseBody({ results: [] })).toBe(true);
    expect(isIdentifyResponseBody({ results: [{ layerId: 127, value: "0.72" }] })).toBe(true);
  });

  it("rejects a body with no results array — a broken response, not an all-NoData answer", () => {
    expect(isIdentifyResponseBody({})).toBe(false);
    expect(isIdentifyResponseBody({ results: "none" })).toBe(false);
    expect(isIdentifyResponseBody(null)).toBe(false);
    expect(isIdentifyResponseBody({ error: { message: "Invalid parameters" } })).toBe(false);
  });
});

describe("buildChartModel", () => {
  const dataset = row("climate-mean-temp");
  const layers: ScenarioLayer[] = selectScenarioLayers(parentDocument, 126);

  it("charts only the sub-layers that returned a value, and counts the rest", () => {
    const model = buildChartModel(dataset, layers, new Map([[127, 0.72], [128, 2.4]]));
    expect(model.total).toBe(3);
    expect(model.skipped).toBe(1);
    expect(model.points.map((p) => p.layerId)).toEqual([127, 128]);
    expect(model.points.map((p) => p.text)).toEqual(["+0.72 °C", "+2.40 °C"]);
    expect(model.points.map((p) => [p.primary, p.secondary])).toEqual([
      ["RCP 2.6", "2031–2050"],
      ["RCP 8.5", "2081–2100"],
    ]);
  });

  it("headlines the strongest change, whichever direction it runs in", () => {
    const model = buildChartModel(dataset, layers, new Map([[127, 0.72], [128, 2.4], [129, -3.1]]));
    expect(model.peak).toMatchObject({ layerId: 129, value: -3.1, text: "−3.10 °C" });
  });

  it("summarises every bar in words for a screen reader", () => {
    const model = buildChartModel(dataset, layers, new Map([[127, 0.72], [128, 2.4]]));
    expect(model.summary).toContain(label(dataset));
    expect(model.summary).toContain(SAMPLE_POINT.label);
    expect(model.summary).toContain("annual changes in deg C");
    expect(model.summary).toContain("RCP2.6 2031-2050: +0.72 °C");
    expect(model.summary).toContain("RCP8.5 2081-2100: +2.40 °C");
    expect(model.summary).toContain("1 further scenario layer returned no value");
  });

  it("says so plainly when nothing was sampled at all", () => {
    const model = buildChartModel(dataset, layers, new Map());
    expect(model.points).toEqual([]);
    expect(model.peak).toBeNull();
    expect(model.total).toBe(3);
    expect(model.summary).toContain("no modelled value");
    expect(model.summary).toContain(SAMPLE_POINT.label);
  });
});

describe("chartHtml", () => {
  const dataset = row("climate-mean-temp");
  const layers = selectScenarioLayers(parentDocument, 126);
  const model = buildChartModel(dataset, layers, new Map([[127, 0.72], [129, -1.05], [128, 2.4]]));
  const markup = chartHtml(model);

  it("draws one labelled bar per sampled scenario", () => {
    expect(model.points).toHaveLength(3);
    expect(markup.match(/class="clm__bar"/g)).toHaveLength(3);
    for (const point of model.points) {
      expect(markup).toContain(`>${point.text}</text>`);
      expect(markup).toContain(`>${point.primary}</text>`);
      expect(markup).toContain(`<title>${point.label}: ${point.text}</title>`);
    }
  });

  it("hangs the negative scenario below the zero line and the positive ones above it", () => {
    const geometry = chartGeometry(model.points.map((p) => p.value));
    const down = geometry.bars.filter((b) => b.negative);
    expect(down).toHaveLength(1);
    expect(markup.match(/clm__barg--down/g)).toHaveLength(1);
    // The one falling bar starts at the baseline; the rising ones end on it.
    expect(down[0]!.y).toBe(geometry.baselineY);
    for (const bar of geometry.bars.filter((b) => !b.negative)) {
      expect(bar.y + bar.height).toBe(geometry.baselineY);
      expect(markup).toContain(`y="${bar.y}" width="${bar.width}" height="${bar.height}"`);
    }
    expect(markup).toContain(`y1="${geometry.baselineY}"`);
  });

  it("rules a hairline where the projection horizon changes, and nowhere else", () => {
    // 2031–2050 (RCP2.6, RCP4.5) then 2081–2100 (RCP8.5): one boundary.
    expect(model.points.map((p) => p.secondary)).toEqual(["2031–2050", "2031–2050", "2081–2100"]);
    expect(markup.match(/class="clm__split"/g)).toHaveLength(1);
    expect(chartHtml(buildChartModel(dataset, layers, new Map([[127, 1], [129, 2]])))).not.toContain("clm__split");
  });

  it("gives the whole series to a screen reader as text", () => {
    expect(markup).toContain(`aria-label="${model.summary}"`);
    expect(markup).toContain('role="img"');
    expect(markup).toContain(SAMPLE_POINT.label);
  });

  it("escapes service-supplied names rather than injecting them as markup", () => {
    const hostile = buildChartModel(
      dataset,
      [{ id: 1, name: "x", label: '<img src=x onerror="alert(1)">', scenario: null, horizon: null, horizonYear: null }],
      new Map([[1, 1]]),
    );
    const html = chartHtml(hostile);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

describe("chartDecision", () => {
  it("charts a climate dataset that is actually selected", () => {
    const d = row("climate-mean-temp");
    expect(chartDecision({ dataset: d.id }, d)).toEqual({ show: true, reason: null });
  });

  it("charts every climate row in the catalogue", () => {
    for (const d of climateDatasets()) {
      expect(chartDecision({ dataset: d.id }, d), `${d.id} should chart`).toEqual({ show: true, reason: null });
    }
  });

  it("charts nothing for a non-climate dataset", () => {
    const d = row("active-faults");
    expect(chartDecision({ dataset: d.id }, d)).toEqual({ show: false, reason: "not-climate" });
    for (const other of datasets().filter((x) => x.theme !== "climate")) {
      expect(chartDecision({ dataset: other.id }, other).show, `${other.id} should not chart`).toBe(false);
    }
  });

  it("charts nothing with no selection, a stale id, or a mismatched row", () => {
    expect(chartDecision({}, null)).toEqual({ show: false, reason: "no-selection" });
    expect(chartDecision({ theme: "climate" }, null)).toEqual({ show: false, reason: "no-selection" });
    expect(chartDecision({ dataset: "not-a-dataset" }, null)).toEqual({ show: false, reason: "unknown-dataset" });
    expect(chartDecision({ dataset: "climate-mean-temp" }, row("active-faults"))).toEqual({
      show: false,
      reason: "unknown-dataset",
    });
  });

  it("charts nothing for a climate row with no service or no group layer", () => {
    const d = row("climate-mean-temp");
    expect(chartDecision({ dataset: d.id }, { ...d, service_root: null })).toEqual({
      show: false,
      reason: "no-service",
    });
    expect(
      chartDecision({ dataset: d.id }, { ...d, layer_id: null, resolved_layer: null, default_child: null }),
    ).toEqual({ show: false, reason: "no-parent-layer" });
  });
});

describe("service URLs", () => {
  it("walks from the group layer upstream records, not from its first child", () => {
    const d = row("climate-mean-temp");
    expect(d.layer_id).toBe(126);
    expect(d.default_child).toBe(127);
    expect(parentLayerIndex(d)).toBe(126);
    expect(scenarioTreeUrl(d)).toBe(`${d.service_root}/layers?f=json`);
  });

  it("samples every scenario layer at Wellington in one identify call", () => {
    const d = row("climate-mean-temp");
    const url = new URL(identifyUrl(d, [127, 128, 129])!);
    expect(url.pathname.endsWith("/MapServer/identify")).toBe(true);
    expect(url.searchParams.get("layers")).toBe("all:127,128,129");
    expect(url.searchParams.get("geometry")).toBe(`${SAMPLE_POINT.lon},${SAMPLE_POINT.lat}`);
    expect(url.searchParams.get("geometryType")).toBe("esriGeometryPoint");
    expect(url.searchParams.get("sr")).toBe("4326");
    expect(url.searchParams.get("f")).toBe("json");
    const extent = url.searchParams.get("mapExtent")!.split(",").map(Number);
    expect(extent[0]).toBeLessThan(SAMPLE_POINT.lon);
    expect(extent[2]).toBeGreaterThan(SAMPLE_POINT.lon);
    expect(extent[1]).toBeLessThan(SAMPLE_POINT.lat);
    expect(extent[3]).toBeGreaterThan(SAMPLE_POINT.lat);
  });

  it("has no URL to build for a dataset it would not chart", () => {
    const d = row("climate-mean-temp");
    expect(scenarioTreeUrl({ ...d, service_root: null })).toBeNull();
    expect(scenarioTreeUrl({ ...d, layer_id: null, resolved_layer: null, default_child: null })).toBeNull();
    expect(identifyUrl(d, [])).toBeNull();
    expect(identifyUrl({ ...d, service_root: null }, [127])).toBeNull();
  });

  it("samples the point the panel claims it samples", () => {
    expect(SAMPLE_POINT).toMatchObject({ label: "Wellington city centre" });
    expect(SAMPLE_POINT.lat).toBeCloseTo(-41.29, 1);
    expect(SAMPLE_POINT.lon).toBeCloseTo(174.78, 1);
  });
});

describe("serviceErrorMessage", () => {
  it("surfaces an ArcGIS error body served with HTTP 200", () => {
    expect(serviceErrorMessage({ error: { code: 400, message: "Invalid or missing input parameters." } })).toBe(
      "Invalid or missing input parameters.",
    );
    expect(serviceErrorMessage({ error: { code: 500 } })).toBe("service error");
  });

  it("is null for a healthy body and for junk", () => {
    expect(serviceErrorMessage({ results: [] })).toBeNull();
    expect(serviceErrorMessage(null)).toBeNull();
    expect(serviceErrorMessage("<html>gateway timeout</html>")).toBeNull();
  });
});

describe("node-environment safety", () => {
  it("has no document to render into, and samples nothing rather than throwing", () => {
    // The module is imported at the top of this file: if any DOM work or fetch
    // happened at module scope, or renderCharts skipped its guard, this suite
    // would never have got this far.
    expect(typeof document).toBe("undefined");
    const spy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      expect(() =>
        renderCharts(null as unknown as HTMLElement, { dataset: "climate-mean-temp" }),
      ).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
