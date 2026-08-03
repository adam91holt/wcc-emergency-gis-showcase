import { describe, expect, it } from "vitest";
import { datasets, byTheme, search, label, catalogue } from "./catalogue";

describe("catalogue data", () => {
  it("bundles the full upstream dataset list", () => {
    expect(datasets().length).toBe(catalogue.counts.total);
    expect(datasets().length).toBeGreaterThan(0);
  });

  it("every dataset has an id and a valid scope", () => {
    for (const d of datasets()) {
      expect(d.id).toBeTruthy();
      expect(["wcc", "regional", "national"]).toContain(d.scope);
    }
  });
});

describe("selectors", () => {
  it("byTheme partitions without dropping or duplicating rows", () => {
    const grouped = byTheme();
    const total = [...grouped.values()].reduce((n, g) => n + g.length, 0);
    expect(total).toBe(datasets().length);
  });

  it("search is case-insensitive and narrows the list", () => {
    const all = datasets();
    const hits = search("coastal");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(all.length);
    expect(search("COASTAL").length).toBe(hits.length);
  });

  it("empty search returns everything", () => {
    expect(search("   ").length).toBe(datasets().length);
  });

  it("label prefers display_name, falls back to name", () => {
    for (const d of datasets()) expect(label(d)).toBeTruthy();
  });
});
