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
import { inspectionSummary, layerStyle, toleranceForZoom } from "./map";
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
    // Dead centre of the square: inside it, but a long way from any edge.
    expect(pointInPolygon([174.8, -41.3], SQUARE)).toBe(true);
    expect(distanceToGeometry([174.8, -41.3], SQUARE)).toBeGreaterThan(0.04);
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
    expect(result.hits[0].matches).toBe(2);
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

  it("thickens the stroke as emphasis rises, and never drops it", () => {
    const base = layerStyle("#ff5d73", area);
    const hover = layerStyle("#ff5d73", area, "hover");
    const highlight = layerStyle("#ff5d73", area, "highlight");
    expect(hover.weight!).toBeGreaterThan(base.weight!);
    expect(highlight.weight!).toBeGreaterThan(hover.weight!);
    expect(highlight.fillOpacity!).toBeGreaterThan(base.fillOpacity!);
  });

  it("paints stroke and fill from the layer's own colour, and defaults to area", () => {
    expect(layerStyle("#2ec4b6")).toMatchObject({ color: "#2ec4b6", fillColor: "#2ec4b6" });
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
