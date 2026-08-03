import { describe, expect, it } from "vitest";
import { parseHash, toHash, mergeHash, type RouteState } from "./router";

describe("parseHash", () => {
  it("parses an empty hash to empty state", () => {
    expect(parseHash("")).toEqual({});
    expect(parseHash("#")).toEqual({});
  });

  it("works with or without the leading #", () => {
    expect(parseHash("#dataset=active-faults")).toEqual({ dataset: "active-faults" });
    expect(parseHash("dataset=active-faults")).toEqual({ dataset: "active-faults" });
  });

  it("parses all four keys together", () => {
    expect(parseHash("#dataset=active-faults&theme=earthquake&scope=wcc&layers=a,b,c")).toEqual({
      dataset: "active-faults",
      theme: "earthquake",
      scope: "wcc",
      layers: ["a", "b", "c"],
    });
  });

  it("splits, trims and drops empty entries in layers", () => {
    expect(parseHash("#layers=a, b ,,c")).toEqual({ layers: ["a", "b", "c"] });
  });

  it("drops keys with empty values", () => {
    expect(parseHash("#dataset=&theme=climate")).toEqual({ theme: "climate" });
  });

  it("ignores unknown keys rather than erroring", () => {
    expect(parseHash("#bogus=1&theme=flood")).toEqual({ theme: "flood" });
  });

  it("never throws on garbage input", () => {
    expect(() => parseHash("#just some text with no equals")).not.toThrow();
    expect(() => parseHash("#%%%not-valid-encoding%%%")).not.toThrow();
    expect(() => parseHash("###???&&&===")).not.toThrow();
    expect(parseHash("#just some text with no equals")).toEqual({});
  });

  it("decodes percent-encoded values", () => {
    expect(parseHash("#dataset=coastal%20inundation")).toEqual({ dataset: "coastal inundation" });
  });
});

describe("toHash", () => {
  it("serialises an empty state to an empty string", () => {
    expect(toHash({})).toBe("");
  });

  it("omits unset and empty-array fields", () => {
    expect(toHash({ dataset: "x", layers: [] })).toBe("#dataset=x");
  });

  it("joins layers with commas", () => {
    expect(toHash({ layers: ["a", "b", "c"] })).toBe("#layers=a%2Cb%2Cc");
  });

  it("percent-encodes values that need it", () => {
    expect(toHash({ dataset: "coastal inundation" })).toBe("#dataset=coastal+inundation");
  });
});

describe("round-tripping", () => {
  const cases: RouteState[] = [
    {},
    { dataset: "active-faults" },
    { theme: "flood", scope: "regional" },
    { dataset: "climate-mean-temp", theme: "climate", scope: "national", layers: ["climate-mean-temp"] },
    { layers: ["a", "b", "c"] },
  ];

  for (const state of cases) {
    it(`round-trips ${JSON.stringify(state)}`, () => {
      expect(parseHash(toHash(state))).toEqual(state);
    });
  }

  it("round-trips through a garbage hash by collapsing to empty state", () => {
    const recovered = parseHash("#this=is,not&valid===stuff&&&");
    expect(parseHash(toHash(recovered))).toEqual(recovered);
  });
});

describe("mergeHash", () => {
  it("sets a key that wasn't present before", () => {
    expect(mergeHash("", { dataset: "active-faults" })).toBe("#dataset=active-faults");
  });

  it("overwrites an existing known key", () => {
    expect(mergeHash("#dataset=active-faults", { dataset: "landslide-features" })).toBe(
      "#dataset=landslide-features",
    );
  });

  it("removes a key when the patch sets it to undefined", () => {
    expect(mergeHash("#dataset=active-faults&theme=earthquake", { dataset: undefined })).toBe(
      "#theme=earthquake",
    );
  });

  it("leaves keys absent from the patch untouched", () => {
    expect(mergeHash("#dataset=active-faults&theme=earthquake", { scope: "wcc" })).toBe(
      "#dataset=active-faults&theme=earthquake&scope=wcc",
    );
  });

  it("preserves unknown hash keys a later feature module owns", () => {
    // A sibling ticket may stash its own key (e.g. `view=table`) in the
    // hash. This router doesn't know about `view` — parseHash/getState
    // never surface it — but setState (via mergeHash) must not erase it
    // when it updates a key it does own.
    expect(mergeHash("#dataset=active-faults&view=table", { theme: "earthquake" })).toBe(
      "#dataset=active-faults&view=table&theme=earthquake",
    );
  });

  it("joins and re-serialises layers, dropping the key when the patch empties it", () => {
    expect(mergeHash("#dataset=x", { layers: ["a", "b"] })).toBe("#dataset=x&layers=a%2Cb");
    expect(mergeHash("#dataset=x&layers=a%2Cb", { layers: [] })).toBe("#dataset=x");
  });

  it("returns an empty string when the merge leaves nothing behind", () => {
    expect(mergeHash("#dataset=active-faults", { dataset: undefined })).toBe("");
  });
});
