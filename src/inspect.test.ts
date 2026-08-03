import { describe, expect, it } from "vitest";
import {
  METRES_PER_DEGREE,
  distanceToGeometry,
  inspectPoint,
  lonScale,
  pointInPolygon,
  pointNearGeometry,
  type InspectLayer,
  type LonLat,
} from "./inspect";
import {
  inspectionSummary,
  inspectorHtml,
  layerStyle,
  toleranceForZoom,
  type UncheckedLayer,
} from "./map";
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  LineString,
  MultiPolygon,
  Point,
  Polygon,
} from "geojson";

// A square over central Wellington, its hole (the "dry island" case), and a
// second square east of it — real-ish coordinates so the cos(latitude)
// scaling is exercised at the latitude the app actually runs at.
const SQUARE: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [174.7, -41.35],
      [174.9, -41.35],
      [174.9, -41.25],
      [174.7, -41.25],
      [174.7, -41.35],
    ],
  ],
};

const SQUARE_WITH_HOLE: Polygon = {
  type: "Polygon",
  coordinates: [
    SQUARE.coordinates[0],
    [
      [174.78, -41.32],
      [174.82, -41.32],
      [174.82, -41.28],
      [174.78, -41.28],
      [174.78, -41.32],
    ],
  ],
};

const TWO_PARTS: MultiPolygon = {
  type: "MultiPolygon",
  coordinates: [
    SQUARE.coordinates,
    [
      [
        [175.0, -41.35],
        [175.1, -41.35],
        [175.1, -41.25],
        [175.0, -41.25],
        [175.0, -41.35],
      ],
    ],
  ],
};

/** A north–south fault trace: every point on it shares one longitude, so an
 * east–west offset is purely a longitude delta. */
const FAULT: LineString = {
  type: "LineString",
  coordinates: [
    [174.78, -41.3],
    [174.78, -41.28],
  ],
};

const INSIDE: LonLat = [174.8, -41.3];
const IN_THE_HOLE: LonLat = [174.8, -41.3];
const OUTSIDE: LonLat = [174.95, -41.3];

function feature(geometry: Geometry, properties: GeoJsonProperties = null): Feature<Geometry, GeoJsonProperties> {
  return { type: "Feature", geometry, properties };
}

function collection(...features: Feature<Geometry, GeoJsonProperties>[]): FeatureCollection<Geometry, GeoJsonProperties> {
  return { type: "FeatureCollection", features };
}

function layer(overrides: Partial<InspectLayer> & Pick<InspectLayer, "id" | "collection">): InspectLayer {
  return {
    label: overrides.id,
    theme: "Hazard layer",
    color: "#4cc9f0",
    ...overrides,
  };
}

describe("pointInPolygon", () => {
  it("finds a point inside a simple polygon", () => {
    expect(pointInPolygon(INSIDE, SQUARE)).toBe(true);
  });

  it("rejects a point outside it", () => {
    expect(pointInPolygon(OUTSIDE, SQUARE)).toBe(false);
    expect(pointInPolygon([174.8, -41.2], SQUARE)).toBe(false);
  });

  it("counts a point inside an interior ring as outside the polygon", () => {
    // Same coordinate, same outer ring — the only difference is the hole.
    expect(pointInPolygon(IN_THE_HOLE, SQUARE)).toBe(true);
    expect(pointInPolygon(IN_THE_HOLE, SQUARE_WITH_HOLE)).toBe(false);
  });

  it("keeps the rest of a holed polygon intact", () => {
    expect(pointInPolygon([174.75, -41.3], SQUARE_WITH_HOLE)).toBe(true);
  });

  it("hits on any part of a MultiPolygon, and misses between parts", () => {
    expect(pointInPolygon([174.8, -41.3], TWO_PARTS)).toBe(true);
    expect(pointInPolygon([175.05, -41.3], TWO_PARTS)).toBe(true);
    expect(pointInPolygon([174.95, -41.3], TWO_PARTS)).toBe(false);
  });

  it("subtracts a hole from one part of a MultiPolygon without touching the other", () => {
    const holed: MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [SQUARE_WITH_HOLE.coordinates, TWO_PARTS.coordinates[1]],
    };
    expect(pointInPolygon([174.8, -41.3], holed)).toBe(false); // in the hole
    expect(pointInPolygon([174.75, -41.3], holed)).toBe(true); // holed part
    expect(pointInPolygon([175.05, -41.3], holed)).toBe(true); // second part
  });

  it("accepts rings that are not explicitly closed", () => {
    const open: Polygon = { type: "Polygon", coordinates: [SQUARE.coordinates[0].slice(0, -1)] };
    expect(pointInPolygon(INSIDE, open)).toBe(true);
    expect(pointInPolygon(OUTSIDE, open)).toBe(false);
  });

  it("encloses nothing when a ring has too few vertices", () => {
    const degenerate: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [174.7, -41.35],
          [174.9, -41.25],
        ],
      ],
    };
    expect(pointInPolygon(INSIDE, degenerate)).toBe(false);
  });

  it("counts every outer edge as covering, regardless of winding", () => {
    // The four edges of SQUARE, each tested at its midpoint. Even-odd ray
    // casting alone answers these inconsistently by edge orientation — a
    // click on the polygon's own rendered stroke must not depend on which
    // side of the shape it landed on.
    expect(pointInPolygon([174.8, -41.35], SQUARE)).toBe(true); // south edge
    expect(pointInPolygon([174.8, -41.25], SQUARE)).toBe(true); // north edge
    expect(pointInPolygon([174.7, -41.3], SQUARE)).toBe(true); // west edge
    expect(pointInPolygon([174.9, -41.3], SQUARE)).toBe(true); // east edge
  });

  it("counts every vertex as covering too", () => {
    for (const vertex of SQUARE.coordinates[0]) {
      expect(pointInPolygon(vertex as LonLat, SQUARE)).toBe(true);
    }
  });

  it("counts a point on an interior ring's boundary as covering the polygon", () => {
    // The hole's own edges — ambiguous as "inside the dry island" or
    // "inside the hazard extent", so they resolve the same way the outer
    // boundary does: covering.
    const holeRing = SQUARE_WITH_HOLE.coordinates[1];
    expect(pointInPolygon([holeRing[0][0], holeRing[0][1]], SQUARE_WITH_HOLE)).toBe(true);
    const midEdge: LonLat = [(holeRing[0][0] + holeRing[1][0]) / 2, holeRing[0][1]];
    expect(pointInPolygon(midEdge, SQUARE_WITH_HOLE)).toBe(true);
  });

  it("still rejects a point just outside an edge", () => {
    expect(pointInPolygon([174.9 + 0.001, -41.3], SQUARE)).toBe(false);
    expect(pointInPolygon([174.7 - 0.001, -41.3], SQUARE)).toBe(false);
  });
});

describe("distance to lines and points", () => {
  it("measures a north–south offset in plain latitude degrees", () => {
    // 0.001° north of the fault's northern end.
    expect(distanceToGeometry([174.78, -41.279], FAULT)).toBeCloseTo(0.001, 9);
  });

  it("shrinks an east–west offset by cos(latitude)", () => {
    // 0.001° of longitude at -41.29 is only ~0.75 of a latitude degree of
    // ground distance — a tolerance must mean the same thing on both axes.
    const east = distanceToGeometry([174.781, -41.29], FAULT);
    expect(east).toBeCloseTo(0.001 * lonScale(-41.29), 9);
    expect(east).toBeLessThan(0.001);
    expect(east * METRES_PER_DEGREE).toBeGreaterThan(70);
    expect(east * METRES_PER_DEGREE).toBeLessThan(90);
  });

  it("hits a line within tolerance and misses outside it", () => {
    const near: LonLat = [174.781, -41.29];
    expect(pointNearGeometry(near, FAULT, 0.0008)).toBe(true);
    expect(pointNearGeometry(near, FAULT, 0.0007)).toBe(false);
  });

  it("measures to the nearest segment of a MultiLineString", () => {
    const multi: Geometry = {
      type: "MultiLineString",
      coordinates: [FAULT.coordinates, [[174.9, -41.3], [174.9, -41.28]]],
    };
    expect(distanceToGeometry([174.899, -41.29], multi)).toBeCloseTo(0.001 * lonScale(-41.29), 9);
  });

  it("measures to a Point feature's coordinate", () => {
    const gauge: Point = { type: "Point", coordinates: [174.78, -41.29] };
    expect(distanceToGeometry([174.78, -41.291], gauge)).toBeCloseTo(0.001, 9);
    expect(pointNearGeometry([174.78, -41.291], gauge, 0.0011)).toBe(true);
    expect(pointNearGeometry([174.78, -41.291], gauge, 0.0009)).toBe(false);
  });

  it("returns Infinity for a missing geometry and never hits it", () => {
    expect(distanceToGeometry(INSIDE, null)).toBe(Infinity);
    expect(pointNearGeometry(INSIDE, undefined, 10)).toBe(false);
  });

  it("measures to a polygon's boundary, not its interior", () => {
    // Dead centre of the square: inside it, but 0.05° from the nearest edge
    // (the north and south edges) — containment says nothing about distance.
    expect(pointInPolygon([174.8, -41.3], SQUARE)).toBe(true);
    expect(distanceToGeometry([174.8, -41.3], SQUARE)).toBeCloseTo(0.05, 9);
  });

  it("measures a ring's closing edge, whether or not the ring repeats its first vertex", () => {
    // The west edge of SQUARE is its *closing* edge once the repeated final
    // vertex is dropped. Walking the vertex list without wrapping would put
    // this point a whole polygon width (0.2° of longitude) away instead of
    // the 0.001° it actually is — and pointInPolygon accepts unclosed rings
    // (above), so the two halves of the module have to agree.
    const open: Polygon = { type: "Polygon", coordinates: [SQUARE.coordinates[0].slice(0, -1)] };
    const justWest: LonLat = [174.699, -41.3];
    const expected = 0.001 * lonScale(-41.3);
    expect(distanceToGeometry(justWest, SQUARE)).toBeCloseTo(expected, 9);
    expect(distanceToGeometry(justWest, open)).toBeCloseTo(expected, 9);
    expect(pointNearGeometry(justWest, open, expected * 1.1)).toBe(true);
  });

  it("refuses a nonsense tolerance instead of hitting everything", () => {
    const onTheLine: LonLat = [174.78, -41.29];
    expect(distanceToGeometry(onTheLine, FAULT)).toBe(0);
    // A zero tolerance still hits a point sitting exactly on the trace…
    expect(pointNearGeometry(onTheLine, FAULT, 0)).toBe(true);
    // …but NaN and negatives are not "everything is near", they are no hit.
    expect(pointNearGeometry(onTheLine, FAULT, Number.NaN)).toBe(false);
    expect(pointNearGeometry(onTheLine, FAULT, -1)).toBe(false);
  });
});

describe("inspectPoint", () => {
  const flood = layer({
    id: "flood-extent",
    label: "Flood hazard extent",
    theme: "Flood hazard area",
    color: "#2ec4b6",
    collection: collection(feature(SQUARE, { DEPTH: "0.4 m" })),
  });
  const inundation = layer({
    id: "coastal-inundation-high",
    label: "Coastal inundation 1.0 m SLR",
    theme: "Coastal inundation",
    color: "#4cc9f0",
    collection: collection(feature(SQUARE_WITH_HOLE)),
  });
  const faults = layer({
    id: "active-faults",
    label: "Active faults",
    theme: "Earthquake hazard",
    color: "#ff5d73",
    collection: collection(feature(FAULT)),
  });

  it("partitions the drawn layers into hits and misses, in input order", () => {
    // A point in the inundation layer's hole: covered by the flood square,
    // not by the inundation polygon, and far from the fault.
    const result = inspectPoint([174.8, -41.3], [inundation, flood, faults], 0.0002);
    expect(result.hits.map((h) => h.id)).toEqual(["flood-extent"]);
    expect(result.misses.map((m) => m.id)).toEqual(["coastal-inundation-high", "active-faults"]);
    expect(result.point).toEqual([174.8, -41.3]);
  });

  it("carries each layer's label, theme and colour through to the answer", () => {
    const result = inspectPoint([174.75, -41.3], [inundation, faults], 0.0002);
    expect(result.hits[0]).toMatchObject({
      id: "coastal-inundation-high",
      label: "Coastal inundation 1.0 m SLR",
      theme: "Coastal inundation",
      color: "#4cc9f0",
      mode: "covers",
      matches: 1,
      distance: 0,
    });
    expect(result.hits[0].feature?.geometry).toBe(SQUARE_WITH_HOLE);
    expect(result.misses[0]).toEqual({
      id: "active-faults",
      label: "Active faults",
      theme: "Earthquake hazard",
      color: "#ff5d73",
    });
  });

  it("reports a nearby line as a 'near' hit with its distance", () => {
    const result = inspectPoint([174.781, -41.29], [faults], 0.0008);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].mode).toBe("near");
    expect(result.hits[0].distance).toBeCloseTo(0.001 * lonScale(-41.29), 9);
    expect(result.misses).toEqual([]);
  });

  it("does not stretch tolerance over polygons", () => {
    // 0.02° east of the square's edge — well outside it, but the tolerance
    // handed in is ten times that. Containment stays exact.
    const result = inspectPoint([174.92, -41.3], [flood], 0.2);
    expect(result.hits).toEqual([]);
    expect(result.misses.map((m) => m.id)).toEqual(["flood-extent"]);
  });

  it("counts every covering feature but reports the containing one", () => {
    const stacked = layer({
      id: "stacked",
      collection: collection(
        feature(FAULT),
        feature(SQUARE, { SCENARIO: "1% AEP" }),
        feature(TWO_PARTS),
      ),
    });
    const result = inspectPoint([174.8, -41.3], [stacked], 0.0002);
    expect(result.hits[0].matches).toBe(2);
    expect(result.hits[0].mode).toBe("covers");
    expect(result.hits[0].feature?.properties).toEqual({ SCENARIO: "1% AEP" });
  });

  it("prefers a containing polygon over a line that is merely close", () => {
    const mixed = layer({
      id: "mixed",
      collection: collection(feature(FAULT), feature(SQUARE)),
    });
    const result = inspectPoint([174.7801, -41.29], [mixed], 0.001);
    expect(result.hits[0].mode).toBe("covers");
    expect(result.hits[0].distance).toBe(0);
    // The fault line is also within tolerance here, but it never covered
    // anything — it must not inflate the covering count the popup's "N×
    // covers" badge reads from.
    expect(result.hits[0].matches).toBe(1);
  });

  it("inspects the parts of a GeometryCollection", () => {
    const bundle = layer({
      id: "bundle",
      collection: collection(
        feature({ type: "GeometryCollection", geometries: [FAULT, TWO_PARTS] }),
      ),
    });
    expect(inspectPoint([175.05, -41.3], [bundle], 0).hits[0].mode).toBe("covers");
    expect(inspectPoint([174.6, -41.3], [bundle], 0).hits).toEqual([]);
  });

  it("skips features with no geometry rather than throwing", () => {
    const ragged = layer({
      id: "ragged",
      collection: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: null, properties: null } as unknown as Feature<Geometry, GeoJsonProperties>,
          feature(SQUARE),
        ],
      },
    });
    expect(inspectPoint(INSIDE, [ragged], 0).hits[0].matches).toBe(1);
  });

  it("treats a drawn but empty layer as a miss", () => {
    const empty = layer({ id: "empty", collection: collection() });
    const result = inspectPoint(INSIDE, [empty], 0.001);
    expect(result.hits).toEqual([]);
    expect(result.misses.map((m) => m.id)).toEqual(["empty"]);
  });

  it("returns nothing at all when no layers are drawn", () => {
    const result = inspectPoint(INSIDE, [], 0.001);
    expect(result.hits).toEqual([]);
    expect(result.misses).toEqual([]);
    expect(result.point).toEqual(INSIDE);
  });
});

describe("inspectionSummary", () => {
  const flood = layer({
    id: "flood-extent",
    label: "Flood hazard extent",
    collection: collection(feature(SQUARE)),
  });
  const faults = layer({
    id: "active-faults",
    label: "Active faults",
    collection: collection(feature(FAULT)),
  });

  it("names every covering layer and how many of the drawn set answered", () => {
    const said = inspectionSummary(inspectPoint([174.75, -41.3], [flood, faults], 0.0002));
    expect(said).toBe("This point is in 1 of 2 drawn layers: Flood hazard extent.");
  });

  it("marks a proximity hit as nearby rather than covering", () => {
    const said = inspectionSummary(inspectPoint([174.781, -41.29], [faults], 0.0008));
    expect(said).toBe("This point is in 1 of 1 drawn layer: Active faults, nearby.");
  });

  it("says so plainly, with the count checked, when nothing covers the point", () => {
    const said = inspectionSummary(inspectPoint([175.5, -41.3], [flood, faults], 0.0002));
    expect(said).toBe("No drawn hazard covers this point. Checked 2 drawn layers.");
  });

  it("speaks the layers that could not be checked, so an all-clear is never absolute", () => {
    const result = inspectPoint([175.5, -41.3], [flood], 0.0002);
    const said = inspectionSummary(result, [{ label: "Active faults", note: "unavailable" }]);
    expect(said).toBe(
      "No drawn hazard covers this point. Checked 1 drawn layer. 1 not checked: Active faults, unavailable.",
    );
  });

  it("carries the caveat onto a positive verdict too", () => {
    const result = inspectPoint([174.75, -41.3], [flood], 0.0002);
    const said = inspectionSummary(result, [{ label: "Landslides", note: "still loading" }]);
    expect(said).toBe(
      "This point is in 1 of 1 drawn layer: Flood hazard extent. 1 not checked: Landslides, still loading.",
    );
  });
});

describe("inspectorHtml", () => {
  const flood = layer({
    id: "flood-extent",
    label: "Flood hazard extent",
    theme: "Flood hazard area",
    color: "#2ec4b6",
    collection: collection(feature(SQUARE, { DEPTH: "0.4 m" })),
  });
  const faults = layer({
    id: "active-faults",
    label: "Active faults",
    theme: "Earthquake hazard",
    color: "#ff5d73",
    collection: collection(feature(FAULT)),
  });
  // Deliberately east of the others, so it is always a miss for the clicks
  // below — the "checked and came back clear" half of the answer.
  const slips = layer({
    id: "landslides",
    label: "Landslides",
    collection: collection(feature({ type: "Polygon", coordinates: TWO_PARTS.coordinates[1] })),
  });

  /** The popup markup for one click. The suite runs in the node environment
   * (vite.config.ts), so these assert against the rendered string rather than
   * a parsed DOM — which is also the level the escaping matters at. */
  function render(
    point: LonLat,
    layers: InspectLayer[],
    tolerance = 0.0002,
    unchecked: UncheckedLayer[] = [],
  ): string {
    return inspectorHtml(inspectPoint(point, layers, tolerance), point[1], point[0], unchecked);
  }

  /** The visible text of the first element carrying `class="<name>"`: scan to
   * its own closing tag (counting nested tags of the same name), then strip
   * inline markup and collapse whitespace — what a reader actually sees. */
  function text(html: string, name: string): string | null {
    const at = html.indexOf(`class="${name}"`);
    if (at < 0) return null;
    const tag = /^<([a-z]+)/.exec(html.slice(html.lastIndexOf("<", at)))![1];
    const opener = new RegExp(`<${tag}[\\s>]`, "g");
    const closer = new RegExp(`</${tag}>`, "g");
    const start = html.indexOf(">", at) + 1;
    let cursor = start;
    let depth = 1;
    while (depth > 0) {
      opener.lastIndex = cursor;
      closer.lastIndex = cursor;
      const open = opener.exec(html);
      const close = closer.exec(html);
      if (!close) return null;
      if (open && open.index < close.index) {
        depth++;
        cursor = open.index + 1;
        continue;
      }
      depth--;
      cursor = close.index + 1;
      if (depth === 0) {
        return html.slice(start, close.index).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      }
    }
    return null;
  }

  it("lists every covering layer with its label, theme and colour swatch", () => {
    const html = render([174.75, -41.3], [flood, faults, slips]);
    expect(html.match(/class="hazins__item"/g)).toHaveLength(1);
    expect(html).toContain('style="--swatch:#2ec4b6"');
    expect(text(html, "hazhit__name")).toBe("Flood hazard extent");
    expect(text(html, "hazhit__theme")).toBe("Flood hazard area");
    expect(text(html, "hazins__verdict")).toBe("In 1 of 3 drawn layers");
    // The two layers that came back clear are not rendered as rows.
    expect(html).not.toContain("Earthquake hazard");
  });

  it("summarises the layers that came back clear on one 'Not in' line", () => {
    const html = render([174.75, -41.3], [flood, faults, slips]);
    expect(html.match(/class="hazins__misses"/g)).toHaveLength(1);
    expect(text(html, "hazins__misses")).toBe("Not in Active faults, Landslides");
  });

  it("says so plainly and nudges when nothing covers the point", () => {
    const html = render([175.5, -41.3], [flood, faults]);
    expect(html).toContain('data-state="clear"');
    expect(text(html, "hazins__verdict")).toBe("No drawn hazard covers this point");
    expect(html).not.toContain("hazins__list");
    expect(text(html, "hazins__nudge")).toMatch(/switch more hazard channels on/i);
  });

  it("badges a covering polygon 'covers' and a nearby line with its distance", () => {
    expect(render([174.75, -41.3], [flood])).toContain('data-mode="covers">covers<');
    const near = render([174.781, -41.29], [faults], 0.0008);
    expect(near).toContain('data-mode="near"');
    // ~84 m east of the fault trace — reported in metres, not as coverage.
    expect(near).toMatch(/data-mode="near">≈ 8[0-9] m</);
    expect(near).not.toContain(">covers<");
  });

  it("counts stacked extents on one layer in its badge", () => {
    const stacked = layer({
      id: "stacked",
      label: "Coastal inundation 1.0 m SLR",
      collection: collection(feature(SQUARE), feature(TWO_PARTS)),
    });
    expect(render([174.8, -41.3], [stacked])).toContain(">2× covers<");
  });

  it("shows the matched feature's own attributes", () => {
    const html = render([174.75, -41.3], [flood]);
    expect(html).toContain('<span class="hazhit__k">DEPTH</span>');
    expect(html).toContain('<span class="hazhit__v">0.4 m</span>');
  });

  it("escapes service-supplied attributes rather than injecting them as markup", () => {
    const hostile = layer({
      id: "hostile",
      label: 'Flood "extent" <b>2100</b>',
      collection: collection(
        feature(SQUARE, {
          "<img src=x onerror=alert(1)>": '"><script>alert(1)</script>',
          OWNER: "Wellington's coast",
        }),
      ),
    });
    const html = render([174.75, -41.3], [hostile]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    // Single quotes too, so a future single-quoted attribute cannot be broken
    // out of by service text.
    expect(html).toContain("Wellington&#39;s coast");
    expect(html).not.toContain("Wellington's coast");
    // The payloads survive as escaped *text*, which is what a readout shows.
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Flood &quot;extent&quot; &lt;b&gt;2100&lt;/b&gt;");
  });

  it("prints the tested coordinate in hemisphere form", () => {
    expect(text(render([174.75, -41.3], [flood]), "hazins__coord")).toBe("41.3000°S · 174.7500°E");
  });

  it("gives every hit row a focusable control whose name carries the readout", () => {
    const html = render([174.75, -41.3], [flood]);
    expect(html).toContain('<button type="button" class="hazhit" data-action="inspect-focus" data-id="flood-extent"');
    // No aria-label: it would override the row's own text, which is the
    // readout (layer, theme, badge, attributes) a screen reader needs. The
    // action rides along as visually-hidden text inside the same button.
    expect(html).not.toContain("aria-label");
    expect(html).toContain('<span class="sr-only">Zoom to this feature</span>');
  });

  it("names the layers it could not check instead of implying an all-clear", () => {
    const html = render([175.5, -41.3], [flood], 0.0002, [
      { label: "Active faults", note: "unavailable" },
      { label: "Landslides", note: "still loading" },
    ]);
    expect(text(html, "hazins__verdict")).toBe("No drawn hazard covers this point");
    expect(text(html, "hazins__pending")).toBe(
      "Not checked Active faults (unavailable), Landslides (still loading)",
    );
    // The "switch more layers on" nudge would be the wrong advice while two
    // switched-on layers are still outstanding.
    expect(html).not.toContain("hazins__nudge");
  });

  it("leaves the caveat out entirely when every drawn layer was checked", () => {
    expect(render([174.75, -41.3], [flood, faults])).not.toContain("hazins__pending");
  });
});

describe("layerStyle", () => {
  const area = feature(SQUARE);
  const marker = feature({ type: "Point", coordinates: [174.78, -41.29] });

  it("fills a point marker far harder than an extent polygon", () => {
    // A 5px disc at the polygon's 0.22 fill is a smudge — and a hazard point
    // nobody can see is a hazard point nobody can click.
    expect(layerStyle("#4cc9f0", marker).fillOpacity).toBeGreaterThan(0.5);
    expect(layerStyle("#4cc9f0", area).fillOpacity).toBeLessThan(0.3);
  });

  it("keeps a point emphatic through hover and inspector highlight", () => {
    // The regression this guards: restyling a drawn layer with one flat
    // polygon-shaped object repaints its markers at area opacity for good.
    for (const emphasis of ["base", "hover", "highlight"] as const) {
      expect(layerStyle("#4cc9f0", marker, emphasis).fillOpacity).toBeGreaterThan(
        layerStyle("#4cc9f0", area, emphasis).fillOpacity!,
      );
    }
  });

  it("raises stroke, fill and opacity with every step of emphasis", () => {
    const base = layerStyle("#ff5d73", area);
    const hover = layerStyle("#ff5d73", area, "hover");
    const highlight = layerStyle("#ff5d73", area, "highlight");
    expect(hover.weight!).toBeGreaterThan(base.weight!);
    expect(highlight.weight!).toBeGreaterThan(hover.weight!);
    expect(hover.fillOpacity!).toBeGreaterThan(base.fillOpacity!);
    expect(highlight.fillOpacity!).toBeGreaterThan(hover.fillOpacity!);
    // Stroke opacity lifts off its resting value once a feature is called out.
    expect(base.opacity!).toBeLessThan(1);
    expect(hover.opacity).toBe(1);
    expect(highlight.opacity).toBe(1);
  });

  it("paints stroke and fill from the layer's own colour, and defaults to area", () => {
    expect(layerStyle("#2ec4b6")).toMatchObject({
      color: "#2ec4b6",
      fillColor: "#2ec4b6",
      fillOpacity: 0.22,
      weight: 1.6,
    });
    // No feature at all is treated as an extent, not as a marker.
    expect(layerStyle("#2ec4b6").fillOpacity).toBe(layerStyle("#2ec4b6", area).fillOpacity);
  });
});

describe("toleranceForZoom", () => {
  it("is a screen-constant distance: it halves with every zoom level", () => {
    expect(toleranceForZoom(13)).toBeCloseTo(toleranceForZoom(12) / 2, 12);
    expect(toleranceForZoom(17)).toBeCloseTo(toleranceForZoom(12) / 32, 12);
  });

  it("is a couple of hundred metres at region zoom and metres at street zoom", () => {
    const region = toleranceForZoom(12) * METRES_PER_DEGREE;
    const street = toleranceForZoom(17) * METRES_PER_DEGREE;
    expect(region).toBeGreaterThan(150);
    expect(region).toBeLessThan(300);
    expect(street).toBeGreaterThan(4);
    expect(street).toBeLessThan(12);
  });

  it("makes a fault line clickable from a few pixels away, but not a suburb away", () => {
    // The point used in the line-proximity tests sits ~84 m east of the fault.
    const near: LonLat = [174.781, -41.29];
    expect(pointNearGeometry(near, FAULT, toleranceForZoom(13, -41.29))).toBe(true);
    expect(pointNearGeometry(near, FAULT, toleranceForZoom(17, -41.29))).toBe(false);
  });

  it("scales with the clicked latitude and clamps a nonsense zoom", () => {
    expect(toleranceForZoom(12, 0)).toBeGreaterThan(toleranceForZoom(12, -41.29));
    expect(toleranceForZoom(Number.NaN)).toBe(toleranceForZoom(12));
    expect(toleranceForZoom(-5)).toBe(toleranceForZoom(0));
  });
});
