import { describe, expect, it } from "vitest";
import {
  SCENARIOS,
  announcement,
  applyScenario,
  drawableLayerIds,
  isScenarioActive,
  patchForScenario,
  scenarioById,
  scenarioKeys,
  scenarioLayersOn,
  type Scenario,
} from "./scenarios";
import { findById, mappableDatasets } from "./catalogue";
import { mergeHash, parseHash, toHash, type RouteState } from "./router";

/** The state a briefing produces when it is loaded from an empty hash — the
 * exact thing a shared deep link carries. */
function loadedState(scenario: Scenario): RouteState {
  return parseHash(mergeHash("", patchForScenario(scenario, {})));
}

describe("SCENARIOS data", () => {
  it("curates 4–6 briefings with unique ids", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(4);
    expect(SCENARIOS.length).toBeLessThanOrEqual(6);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it("gives every briefing a title and a one-line description", () => {
    for (const s of SCENARIOS) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.description.trim().length).toBeGreaterThan(0);
      expect(s.description.length).toBeLessThanOrEqual(110);
    }
  });

  it("draws every layer id from the catalogue, and only ids the map can render", () => {
    const mappable = new Set(mappableDatasets().map((d) => d.id));
    for (const s of SCENARIOS) {
      expect(s.patch.layers.length).toBeGreaterThan(0);
      expect(new Set(s.patch.layers).size).toBe(s.patch.layers.length);
      for (const id of s.patch.layers) {
        expect(findById(id), `${s.id}: unknown catalogue id ${id}`).toBeDefined();
        expect(mappable.has(id), `${s.id}: ${id} is not a mappable dataset`).toBe(true);
      }
    }
  });

  it("never sets a dataset, so loading a briefing can't trigger the catalogue list's scroll-into-view", () => {
    // src/main.ts's highlightSelection() scrolls the matching card into view
    // on every `dataset` change, including a route-driven one (a scenario
    // load, or pasting a deep link) — exactly wrong for a quick view whose
    // point is that the visitor stays put and watches the map. See the file
    // header for the full rationale.
    for (const s of SCENARIOS) expect(s.patch.dataset).toBeUndefined();
  });

  it("only writes route keys the map story owns", () => {
    for (const s of SCENARIOS) {
      expect(scenarioKeys(s)).toContain("layers");
      for (const key of Object.keys(s.patch)) expect(["layers", "theme", "dataset"]).toContain(key);
    }
  });

  it("looks a briefing up by id, and returns undefined for an unknown one", () => {
    expect(scenarioById(SCENARIOS[0].id)).toBe(SCENARIOS[0]);
    expect(scenarioById("no-such-scenario")).toBeUndefined();
  });
});

describe("hash round-trip", () => {
  it("round-trips every briefing's patch through mergeHash/parseHash unchanged", () => {
    for (const s of SCENARIOS) {
      expect(parseHash(mergeHash("", s.patch))).toEqual({ ...s.patch });
    }
  });

  it("leaves hash keys the briefing does not own untouched", () => {
    for (const s of SCENARIOS) {
      const state = parseHash(mergeHash("#query=flood&scope=wcc", s.patch));
      expect(state.query).toBe("flood");
      expect(state.scope).toBe("wcc");
      expect(state.layers).toEqual(s.patch.layers);
    }
  });
});

describe("isScenarioActive", () => {
  it("is true for the state its own patch produces", () => {
    for (const s of SCENARIOS) expect(isScenarioActive(s, loadedState(s))).toBe(true);
  });

  it("is true regardless of the order the layers sit in the hash", () => {
    const s = SCENARIOS[0];
    const shuffled = { ...loadedState(s), layers: [...s.patch.layers].reverse() };
    expect(isScenarioActive(s, shuffled)).toBe(true);
  });

  it("is false for an empty state", () => {
    for (const s of SCENARIOS) expect(isScenarioActive(s, {})).toBe(false);
  });

  it("is false for a different layer set", () => {
    const s = SCENARIOS[0];
    expect(isScenarioActive(s, { ...loadedState(s), layers: ["active-faults"] })).toBe(false);
    // One layer short, and one layer over: neither is "this briefing is loaded".
    expect(isScenarioActive(s, { ...loadedState(s), layers: s.patch.layers.slice(1) })).toBe(false);
    expect(
      isScenarioActive(s, { ...loadedState(s), layers: [...s.patch.layers, "roads"] }),
    ).toBe(false);
  });

  it("stays true when the theme facet is changed elsewhere — only the layer set gates \"loaded\"", () => {
    // theme is also owned by the filter panel's theme chips (src/filters.ts).
    // A briefing's chip reports pressed/loaded off the same signal as its own
    // meter (the layer set) so the two can never disagree — see this
    // function's doc. A later theme-chip pick must not make an
    // otherwise-still-fully-lit briefing's chip read unpressed.
    for (const s of SCENARIOS) {
      if (!s.patch.theme) continue;
      expect(isScenarioActive(s, { ...loadedState(s), theme: "climate" })).toBe(true);
    }
  });

  it("marks at most one briefing loaded at a time", () => {
    for (const s of SCENARIOS) {
      const state = loadedState(s);
      expect(SCENARIOS.filter((other) => isScenarioActive(other, state)).map((x) => x.id)).toEqual([s.id]);
    }
  });
});

describe("scenarioLayersOn", () => {
  it("counts nothing when the map is clear", () => {
    for (const s of SCENARIOS) expect(scenarioLayersOn(s, {})).toBe(0);
  });

  it("counts the partial overlap when only some layers are on", () => {
    const s = SCENARIOS[1];
    const half = s.patch.layers.slice(0, 2);
    expect(scenarioLayersOn(s, { layers: [...half, "footpaths"] })).toBe(2);
  });

  it("counts every layer once the briefing is loaded", () => {
    for (const s of SCENARIOS) {
      expect(scenarioLayersOn(s, loadedState(s))).toBe(s.patch.layers.length);
    }
  });
});

describe("patchForScenario", () => {
  it("writes the briefing's patch when it is not loaded", () => {
    for (const s of SCENARIOS) expect(patchForScenario(s, {})).toEqual({ ...s.patch });
  });

  it("clears exactly the keys it set when the briefing is already loaded", () => {
    for (const s of SCENARIOS) {
      const off = patchForScenario(s, loadedState(s));
      for (const key of scenarioKeys(s)) {
        expect(key in off).toBe(true);
        expect(off[key]).toBeUndefined();
      }
    }
  });

  it("toggling off removes the briefing's keys from the hash and keeps the rest", () => {
    for (const s of SCENARIOS) {
      const on = mergeHash("#query=flood", s.patch);
      const off = mergeHash(on, patchForScenario(s, parseHash(on)));
      const state = parseHash(off);
      expect(state.layers).toBeUndefined();
      expect(state.theme).toBeUndefined();
      expect(state.dataset).toBeUndefined();
      expect(state.query).toBe("flood");
    }
  });

  it("round-trips on → off → on, landing back on the same state", () => {
    for (const s of SCENARIOS) {
      const on = mergeHash("", patchForScenario(s, {}));
      const off = mergeHash(on, patchForScenario(s, parseHash(on)));
      const again = mergeHash(off, patchForScenario(s, parseHash(off)));
      expect(parseHash(again)).toEqual({ ...s.patch });
    }
  });

  it("swaps straight from one briefing to another without leaving stale layers", () => {
    const [first, second] = SCENARIOS;
    const state = parseHash(mergeHash("", patchForScenario(first, {})));
    const swapped = parseHash(mergeHash(mergeHash("", first.patch), patchForScenario(second, state)));
    expect(swapped.layers).toEqual(second.patch.layers);
    expect(isScenarioActive(second, swapped)).toBe(true);
    expect(isScenarioActive(first, swapped)).toBe(false);
  });
});

describe("patchForScenario does not clobber state a visitor set by hand", () => {
  // A briefing's chip stays pressed off the layer set alone (see
  // isScenarioActive's "stays true when the theme facet is changed
  // elsewhere" test) because that's what's actually drawn on the map. But
  // clicking a pressed chip to clear it must not delete a theme the visitor
  // picked afterwards via the filter panel's theme chips — that value is
  // theirs now, not a stale copy of the briefing's own theme.
  it("leaves a hand-picked theme alone when toggling a still-pressed chip off", () => {
    for (const s of SCENARIOS) {
      if (!s.patch.theme) continue;
      const drifted: RouteState = { ...loadedState(s), theme: "climate" };
      expect(isScenarioActive(s, drifted)).toBe(true);

      const off = patchForScenario(s, drifted);
      expect(off.layers).toBeUndefined();
      expect("theme" in off).toBe(false);

      const after = parseHash(mergeHash(toHash(drifted), off));
      expect(after.layers).toBeUndefined();
      expect(after.theme).toBe("climate");
    }
  });

  it("still clears the theme on toggle-off when it still matches what the briefing set", () => {
    for (const s of SCENARIOS) {
      if (!s.patch.theme) continue;
      const off = patchForScenario(s, loadedState(s));
      expect("theme" in off).toBe(true);
      expect(off.theme).toBeUndefined();
    }
  });
});

describe("applyScenario", () => {
  it("is a no-op outside a browser rather than throwing (router.setState's contract)", () => {
    for (const s of SCENARIOS) expect(() => applyScenario(s, {})).not.toThrow();
  });
});

describe("drawableLayerIds", () => {
  it("keeps every layer of every briefing", () => {
    for (const s of SCENARIOS) {
      expect(drawableLayerIds(loadedState(s))).toEqual(s.patch.layers);
    }
  });

  it("drops unknown and undrawable ids, and collapses duplicates", () => {
    const state: RouteState = { layers: ["roads", "roads", "sea-level-rise", "not-a-dataset"] };
    expect(drawableLayerIds(state)).toEqual(["roads"]);
  });
});

describe("announcement", () => {
  it("names the loaded briefing and how many layers are selected", () => {
    const s = SCENARIOS[2];
    const text = announcement(loadedState(s));
    expect(text).toContain(s.title);
    expect(text).toContain(`${s.patch.layers.length} layers`);
  });

  it("says the map is clear when nothing is loaded", () => {
    expect(announcement({})).toBe("No briefing loaded — the map is clear.");
  });

  it("reports hand-toggled layers with no briefing loaded, without claiming they're drawn", () => {
    // The map (src/map.ts) is the only source of truth for render success —
    // this module only knows what's selected in route state, so its copy
    // must say "selected", never "drawn"/"live"/"on the map".
    expect(announcement({ layers: ["roads"] })).toBe("No briefing loaded — 1 layer selected.");
  });
});
