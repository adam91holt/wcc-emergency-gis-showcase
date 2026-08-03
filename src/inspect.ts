// The point inspector: "is *this* location affected?" answered against the
// GeoJSON the hazard map has already fetched.
//
// This module is deliberately *pure* — no `document`, no `window`, no `fetch`,
// no Leaflet — the same split src/map.ts and src/detail.ts document at their
// tops, so src/inspect.test.ts can exercise the geometry directly in the node
// test environment. src/map.ts owns everything else: which layers are drawn,
// what tolerance the current zoom implies, and how the answer is rendered.
//
// Units. Every distance in here is expressed in *latitude degrees* (≈111.3 km
// each), not raw coordinate deltas: a degree of longitude at Wellington's
// latitude is only ~0.75 of a degree of latitude on the ground, so longitude
// deltas are scaled by cos(latitude) before any distance is taken. Without
// that scaling a "50 m" tolerance would be a third wider east–west than
// north–south, and a fault line would be clickable from further away on one
// axis than the other.
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";

/** A `[longitude, latitude]` pair — GeoJSON axis order, not Leaflet's. */
export type LonLat = [number, number];

/** One drawn layer handed to the inspector: catalogue identity plus the
 * FeatureCollection the map already holds for it. */
export interface InspectLayer {
  id: string;
  /** The dataset's display name, e.g. "Coastal inundation 1.0 m SLR". */
  label: string;
  /** The dataset's theme label, e.g. "Flood hazard area". */
  theme: string;
  /** The layer's key colour (map.themeColor) — the popup swatch reads it. */
  color: string;
  collection: FeatureCollection<Geometry, GeoJsonProperties>;
}

/** How a layer was hit: a polygon that genuinely contains the point, or a
 * line/point feature sitting within the caller's tolerance of it. */
export type HitMode = "covers" | "near";

/** A layer that answers "yes" for the clicked point. */
export interface LayerHit {
  id: string;
  label: string;
  theme: string;
  color: string;
  mode: HitMode;
  /** How many of the layer's features hit — flood extents can stack. */
  matches: number;
  /** Latitude-degrees to the nearest hitting feature; 0 for a containing
   * polygon. */
  distance: number;
  /** The first (nearest, or first containing) feature that hit, so the caller
   * can read its attributes without re-walking the collection. */
  feature: Feature<Geometry, GeoJsonProperties> | null;
}

/** A layer that is drawn but does not cover the clicked point. */
export interface LayerMiss {
  id: string;
  label: string;
  theme: string;
  color: string;
}

export interface InspectResult {
  point: LonLat;
  hits: LayerHit[];
  misses: LayerMiss[];
}

const DEG = Math.PI / 180;

/** Metres in one degree of latitude — the constant that turns this module's
 * degree distances into something a popup can print. */
export const METRES_PER_DEGREE = 111_320;

/** How much a degree of longitude shrinks at this latitude. Clamped away from
 * zero so a (theoretical) polar coordinate cannot collapse the x axis and
 * make everything read as a hit. */
export function lonScale(lat: number): number {
  return Math.max(Math.abs(Math.cos(lat * DEG)), 1e-6);
}

/** Ray-casting (even–odd) containment for a single linear ring. Rings may be
 * given closed or open — the i/j wrap walks the closing edge either way. A
 * ring with fewer than three vertices encloses nothing.
 *
 * This is a strict *interior* test only — a point sitting exactly on an edge
 * is a coin flip under even-odd parity (it depends on which way that edge
 * happens to be wound), so callers that care about the boundary use
 * `ringBoundaryContains` first and treat this as "is it in the interior". */
function ringContains(point: LonLat, ring: Position[]): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    // Only edges straddling the ray's latitude can cross it; the second term
    // is the longitude where that edge crosses, compared against the point.
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Tolerance for "on the line", in degrees — small enough to never swallow a
 * genuinely-outside click, large enough to absorb float noise in service
 * coordinates. */
const BOUNDARY_EPSILON = 1e-9;

/** Is the point on the segment a→b (inclusive of its endpoints)? Collinearity
 * first (cross product ~0), then a bounding-box check to rule out points that
 * are on the segment's *line* but past one of its ends. */
function onSegment(point: LonLat, a: Position, b: Position): boolean {
  const [px, py] = point;
  const [ax, ay] = a;
  const [bx, by] = b;
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if (Math.abs(cross) > BOUNDARY_EPSILON) return false;
  return (
    px >= Math.min(ax, bx) - BOUNDARY_EPSILON &&
    px <= Math.max(ax, bx) + BOUNDARY_EPSILON &&
    py >= Math.min(ay, by) - BOUNDARY_EPSILON &&
    py <= Math.max(ay, by) + BOUNDARY_EPSILON
  );
}

/** Is the point exactly on this ring's boundary — any of its edges, wrapping
 * the closing edge the same way `ringContains` does? A ring of fewer than
 * three vertices encloses (and bounds) nothing, matching `ringContains`. Pure
 * geometry, so unlike the ray cast it gives the same answer regardless of
 * which way the ring winds — a click on a polygon's east edge and a click on
 * its west edge are answered identically. */
function ringBoundaryContains(point: LonLat, ring: Position[]): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (onSegment(point, ring[j], ring[i])) return true;
  }
  return false;
}

/** One GeoJSON polygon (ring 0 outer, rings 1+ holes): inside the outer ring
 * and inside none of the holes. A point in a hole — the dry island inside a
 * flood extent — is *outside* the polygon. A point sitting exactly on a
 * boundary — the outer edge, or the edge of a hole — counts as covering the
 * polygon: it is the line between "in" and "out", and the rendered stroke a
 * user actually clicks on sits right there, so both edges of the same
 * polygon (and both sides of a hole) must answer the same way. */
function ringsContain(point: LonLat, rings: Position[][]): boolean {
  if (!Array.isArray(rings) || rings.length === 0) return false;
  if (ringBoundaryContains(point, rings[0])) return true;
  if (!ringContains(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (ringBoundaryContains(point, rings[i])) return true;
    if (ringContains(point, rings[i])) return false;
  }
  return true;
}

/** Is the point inside this Polygon / MultiPolygon? Interior rings (holes)
 * are subtracted; a MultiPolygon hits if any of its parts does. Strict — no
 * tolerance, so a polygon's edge never goes fuzzy under the cursor. */
export function pointInPolygon(point: LonLat, geometry: Polygon | MultiPolygon): boolean {
  if (geometry.type === "Polygon") return ringsContain(point, geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((rings) => ringsContain(point, rings));
  }
  return false;
}

/** Distance from the point to the segment a→b, in latitude degrees. */
function segmentDistance(point: LonLat, a: Position, b: Position, kx: number): number {
  const px = (point[0] - a[0]) * kx;
  const py = point[1] - a[1];
  const sx = (b[0] - a[0]) * kx;
  const sy = b[1] - a[1];
  const len2 = sx * sx + sy * sy;
  // Project the point onto the segment, clamp to its ends, then measure.
  let t = len2 > 0 ? (px * sx + py * sy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - t * sx, py - t * sy);
}

function vertexDistance(point: LonLat, vertex: Position, kx: number): number {
  return Math.hypot((point[0] - vertex[0]) * kx, point[1] - vertex[1]);
}

function lineDistance(point: LonLat, line: Position[], kx: number): number {
  if (!Array.isArray(line) || line.length === 0) return Infinity;
  if (line.length === 1) return vertexDistance(point, line[0], kx);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = segmentDistance(point, line[i - 1], line[i], kx);
    if (d < best) best = d;
  }
  return best;
}

/** Distance from the point to a geometry's *outline*, in latitude degrees:
 * the nearest vertex for Point/MultiPoint, the nearest segment for lines, and
 * the nearest boundary edge for polygons (which says nothing about being
 * inside one — that is pointInPolygon's job). `Infinity` for a null or empty
 * geometry. */
export function distanceToGeometry(point: LonLat, geometry: Geometry | null | undefined): number {
  if (!geometry) return Infinity;
  const kx = lonScale(point[1]);
  switch (geometry.type) {
    case "Point":
      return vertexDistance(point, geometry.coordinates, kx);
    case "MultiPoint":
      return geometry.coordinates.reduce((best, p) => Math.min(best, vertexDistance(point, p, kx)), Infinity);
    case "LineString":
      return lineDistance(point, geometry.coordinates, kx);
    case "MultiLineString":
      return geometry.coordinates.reduce((best, l) => Math.min(best, lineDistance(point, l, kx)), Infinity);
    case "Polygon":
      return geometry.coordinates.reduce((best, r) => Math.min(best, lineDistance(point, r, kx)), Infinity);
    case "MultiPolygon":
      return geometry.coordinates.reduce(
        (best, rings) => rings.reduce((b, r) => Math.min(b, lineDistance(point, r, kx)), best),
        Infinity,
      );
    case "GeometryCollection":
      return geometry.geometries.reduce((best, g) => Math.min(best, distanceToGeometry(point, g)), Infinity);
    default:
      return Infinity;
  }
}

/** Is the point within `tolerance` (latitude degrees) of this geometry's
 * outline? The caller derives the tolerance from the current zoom — see
 * map.toleranceForZoom — so a fault line is clickable at street zoom without
 * being clickable from the next suburb at region zoom. */
export function pointNearGeometry(
  point: LonLat,
  geometry: Geometry | null | undefined,
  tolerance: number,
): boolean {
  if (!(tolerance >= 0)) return false;
  return distanceToGeometry(point, geometry) <= tolerance;
}

interface GeometryHit {
  mode: HitMode;
  distance: number;
}

/** How (and whether) one geometry answers for the point: polygons must
 * genuinely contain it, everything else only has to be within tolerance. */
function hitGeometry(
  point: LonLat,
  geometry: Geometry | null | undefined,
  tolerance: number,
): GeometryHit | null {
  if (!geometry) return null;
  switch (geometry.type) {
    case "Polygon":
    case "MultiPolygon":
      return pointInPolygon(point, geometry) ? { mode: "covers", distance: 0 } : null;
    case "Point":
    case "MultiPoint":
    case "LineString":
    case "MultiLineString": {
      const distance = distanceToGeometry(point, geometry);
      return distance <= tolerance ? { mode: "near", distance } : null;
    }
    case "GeometryCollection": {
      let best: GeometryHit | null = null;
      for (const child of geometry.geometries) {
        const hit = hitGeometry(point, child, tolerance);
        if (!hit) continue;
        if (!best || (hit.mode === "covers" && best.mode !== "covers") || hit.distance < best.distance) {
          best = hit;
        }
      }
      return best;
    }
    default:
      return null;
  }
}

/** Answer "what's here?" for one clicked point against the layers currently
 * drawn on the map. A layer hits if *any* of its features hits; every drawn
 * layer that does not hit comes back in `misses`, so the caller can say what
 * was checked and came back clear rather than silently omitting it. Input
 * order (the order the user switched layers on) is preserved in both lists.
 *
 * `tolerance` is in latitude degrees and only ever loosens line/point
 * features; polygon containment stays exact. */
export function inspectPoint(
  point: LonLat,
  layers: readonly InspectLayer[],
  tolerance = 0,
): InspectResult {
  const hits: LayerHit[] = [];
  const misses: LayerMiss[] = [];

  for (const layer of layers) {
    const features = layer.collection?.features ?? [];
    let matches = 0;
    let mode: HitMode = "near";
    let distance = Infinity;
    let first: Feature<Geometry, GeoJsonProperties> | null = null;

    for (const feature of features) {
      const hit = hitGeometry(point, feature?.geometry, tolerance);
      if (!hit) continue;
      matches++;
      // A containing polygon always outranks a nearby line, and among equals
      // the closest wins — that is the feature the popup reports on.
      if (hit.mode === "covers" && mode !== "covers") {
        mode = "covers";
        distance = hit.distance;
        first = feature;
      } else if (hit.mode === mode && hit.distance < distance) {
        distance = hit.distance;
        first = feature;
      }
    }

    const { id, label, theme, color } = layer;
    if (matches > 0) {
      hits.push({ id, label, theme, color, mode, matches, distance, feature: first });
    } else {
      misses.push({ id, label, theme, color });
    }
  }

  return { point, hits, misses };
}
