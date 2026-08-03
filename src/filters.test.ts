import { describe, expect, it } from "vitest";
import {
  applyFilters,
  resultCount,
  themeFacetCounts,
  scopeFacetCounts,
  hasActiveFilters,
  filterStateFromRoute,
  patchForFilters,
  type FilterState,
} from "./filters";
import { datasets, themes, scopes, findById } from "./catalogue";
import { parseHash, toHash } from "./router";

describe("applyFilters", () => {
  it("returns everything when no filter is active", () => {
    expect(applyFilters({}).length).toBe(datasets().length);
  });

  it("narrows by scope alone", () => {
    const list = applyFilters({ scope: "wcc" });
    expect(list.length).toBe(23);
    for (const d of list) expect(d.scope).toBe("wcc");
  });

  it("narrows by theme alone", () => {
    const list = applyFilters({ theme: "climate" });
    expect(list.length).toBe(21);
    for (const d of list) expect(d.theme).toBe("climate");
  });

  it("narrows by query alone, matching catalogue.search's own behaviour", () => {
    const list = applyFilters({ query: "coastal" });
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThan(datasets().length);
  });

  it("composes theme × scope × query, each narrowing further", () => {
    const byScopeOnly = applyFilters({ scope: "regional" });
    const byScopeAndTheme = applyFilters({ scope: "regional", theme: "flood" });
    const all = applyFilters({ scope: "regional", theme: "flood", query: "stream" });

    expect(byScopeAndTheme.length).toBeLessThanOrEqual(byScopeOnly.length);
    expect(all.length).toBeLessThanOrEqual(byScopeAndTheme.length);
    for (const d of all) {
      expect(d.scope).toBe("regional");
      expect(d.theme).toBe("flood");
    }
  });

  it("known composition: coastal-inundation-high matches wcc + coastal_inundation + 'inundation'", () => {
    const d = findById("coastal-inundation-high")!;
    const list = applyFilters({ scope: d.scope, theme: d.theme, query: "inundation" });
    expect(list.map((x) => x.id)).toContain(d.id);
  });

  it("returns an empty list, not throwing, when the combined filters match nothing", () => {
    const list = applyFilters({ theme: "climate", scope: "wcc", query: "zzz-nonexistent-zzz" });
    expect(list).toEqual([]);
  });
});

describe("resultCount", () => {
  it("matches applyFilters().length for a variety of filter states", () => {
    const cases: FilterState[] = [{}, { scope: "national" }, { theme: "earthquake" }, { query: "flood" }];
    for (const filters of cases) expect(resultCount(filters)).toBe(applyFilters(filters).length);
  });

  it("is 0 for filters that match nothing", () => {
    expect(resultCount({ query: "zzz-nonexistent-zzz" })).toBe(0);
  });
});

describe("hasActiveFilters", () => {
  it("is false for an empty state", () => {
    expect(hasActiveFilters({})).toBe(false);
  });

  it("is true when any of theme/scope/query is set", () => {
    expect(hasActiveFilters({ theme: "flood" })).toBe(true);
    expect(hasActiveFilters({ scope: "wcc" })).toBe(true);
    expect(hasActiveFilters({ query: "x" })).toBe(true);
  });
});

describe("themeFacetCounts", () => {
  it("matches catalogue.themes() counts when no other filter is active", () => {
    const counts = themeFacetCounts({});
    for (const t of themes()) expect(counts.get(t.theme)).toBe(t.count);
  });

  it("holds scope fixed while reporting each theme's count under that scope", () => {
    const counts = themeFacetCounts({ scope: "wcc" });
    for (const [theme, count] of counts) {
      expect(count).toBe(applyFilters({ scope: "wcc", theme }).length);
    }
  });

  it("does not simply zero out the currently active theme (reports its real count)", () => {
    const counts = themeFacetCounts({ theme: "climate" });
    expect(counts.get("climate")).toBe(21);
  });
});

describe("scopeFacetCounts", () => {
  it("matches catalogue.scopes() counts when no other filter is active", () => {
    const counts = scopeFacetCounts({});
    for (const s of scopes()) expect(counts.get(s.scope)).toBe(s.count);
  });

  it("holds theme fixed while reporting each scope's count under that theme", () => {
    const counts = scopeFacetCounts({ theme: "flood" });
    for (const [scope, count] of counts) {
      expect(count).toBe(applyFilters({ theme: "flood", scope }).length);
    }
  });

  it("sums to the theme-filtered total across all three scopes", () => {
    const counts = scopeFacetCounts({ theme: "landslide" });
    const total = [...counts.values()].reduce((n, c) => n + c, 0);
    expect(total).toBe(applyFilters({ theme: "landslide" }).length);
  });
});

describe("filterStateFromRoute", () => {
  it("picks only theme/scope/query, ignoring dataset and layers", () => {
    expect(
      filterStateFromRoute({ dataset: "active-faults", theme: "earthquake", scope: "wcc", layers: ["a"] }),
    ).toEqual({ theme: "earthquake", scope: "wcc" });
  });

  it("returns an empty object for route state with none of its keys set", () => {
    expect(filterStateFromRoute({ dataset: "active-faults" })).toEqual({});
  });
});

describe("URL round-tripping through the router", () => {
  it("round-trips an empty filter state to an empty hash", () => {
    expect(toHash(patchForFilters({}))).toBe("");
    expect(filterStateFromRoute(parseHash(""))).toEqual({});
  });

  it("round-trips theme + scope + query together", () => {
    const filters: FilterState = { theme: "flood", scope: "wcc", query: "hazard zone" };
    const hash = toHash(patchForFilters(filters));
    expect(filterStateFromRoute(parseHash(hash))).toEqual(filters);
  });

  it("round-trips a single field on its own", () => {
    for (const filters of [{ theme: "climate" }, { scope: "regional" }, { query: "fault" }] as FilterState[]) {
      const hash = toHash(patchForFilters(filters));
      expect(filterStateFromRoute(parseHash(hash))).toEqual(filters);
    }
  });

  it("patchForFilters clears a field via explicit undefined rather than omitting it", () => {
    // mergeHash only removes keys explicitly set to undefined in the patch —
    // an omitted key is left untouched. patchForFilters must always name all
    // three keys so applying it fully replaces the prior filter state.
    const patch = patchForFilters({ theme: "flood" });
    expect(patch).toEqual({ theme: "flood", scope: undefined, query: undefined });
  });
});
