// Tiny hash-based router. No history-API navigation beyond the hash itself —
// this app is a single page, so the router's only job is to keep a bit of
// shareable UI state (which dataset/theme/scope/layers are active) in sync
// with `location.hash` so links and back/forward work.
//
// URL state shape (documented here for every ticket that reads/writes it):
//   #dataset=<id>          — the selected dataset's catalogue id
//   #theme=<theme>         — the active theme filter (Dataset["theme"])
//   #scope=<scope>         — the active scope filter (wcc/regional/national)
//   #layers=<id>,<id>,...  — comma-separated ids of layers toggled on the map
// All keys are optional and independent; unknown keys are ignored on parse
// (parseHash/getState never surface them, so this router never trips over a
// key it doesn't know about) but setState() preserves them verbatim in the
// raw hash string, so the hash can grow without breaking older code and
// without a later feature's own hash keys getting clobbered by this router.

export interface RouteState {
  dataset?: string;
  theme?: string;
  scope?: string;
  layers?: string[];
}

const KEYS: (keyof RouteState)[] = ["dataset", "theme", "scope", "layers"];

/** Parse a `location.hash`-shaped string (with or without the leading `#`)
 * into route state. Never throws — unknown keys, empty values and malformed
 * input are all ignored rather than raising. */
export function parseHash(hash: string): RouteState {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const state: RouteState = {};
  if (!raw) return state;

  // URLSearchParams parsing is deliberately lenient (application/
  // x-www-form-urlencoded) — it never throws on malformed input, it just
  // produces empty/partial results, which is exactly the "never throws"
  // behaviour this function documents.
  const params = new URLSearchParams(raw);

  const dataset = params.get("dataset");
  if (dataset) state.dataset = dataset;

  const theme = params.get("theme");
  if (theme) state.theme = theme;

  const scope = params.get("scope");
  if (scope) state.scope = scope;

  const layers = params.get("layers");
  if (layers) {
    const list = layers.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) state.layers = list;
  }

  return state;
}

/** Serialise route state back into a `#`-prefixed hash. Omits empty/unset
 * fields; returns "" (no `#`) when the state is empty. */
export function toHash(state: RouteState): string {
  const params = new URLSearchParams();
  if (state.dataset) params.set("dataset", state.dataset);
  if (state.theme) params.set("theme", state.theme);
  if (state.scope) params.set("scope", state.scope);
  if (state.layers && state.layers.length > 0) params.set("layers", state.layers.join(","));
  const serialised = params.toString();
  return serialised ? `#${serialised}` : "";
}

/** Pure merge: apply `patch` to a raw hash string (with or without the
 * leading `#`), touching only the keys named in `patch` and leaving any
 * other query-string keys already present untouched. This is what lets a
 * later feature module put its own key (e.g. `#view=table`) in the hash
 * without this router's setState() wiping it out on the next call. Exported
 * so the merge logic is covered by a plain unit test without needing
 * `location`/`history` (this repo's test environment has no DOM). */
export function mergeHash(hash: string, patch: Partial<RouteState>): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  for (const key of KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) {
      params.delete(key);
      continue;
    }
    if (key === "layers") {
      const layers = value as string[];
      if (layers.length > 0) params.set("layers", layers.join(","));
      else params.delete("layers");
    } else {
      params.set(key, value as string);
    }
  }
  const serialised = params.toString();
  return serialised ? `#${serialised}` : "";
}

type Listener = (state: RouteState) => void;

const listeners = new Set<Listener>();
let listening = false;

function currentHash(): string {
  return typeof location !== "undefined" ? location.hash : "";
}

function notify(): void {
  const state = getState();
  for (const cb of listeners) cb(state);
}

function ensureListening(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  // Covers hand-edited/pasted URLs and back/forward navigation — both fire a
  // native hashchange event. Programmatic setState() below does not (pushState
  // /replaceState never fire it), so it notifies listeners itself.
  window.addEventListener("hashchange", notify);
}

/** The router's current state, read straight from `location.hash`. */
export function getState(): RouteState {
  return parseHash(currentHash());
}

/** Merge `patch` into the current state and write it back to the hash. Keys
 * set to `undefined` in `patch` are removed from the state; keys not present
 * in `patch` are left as-is, including hash keys this router doesn't know
 * about (see mergeHash). No-ops outside a browser (e.g. during tests / SSR). */
export function setState(patch: Partial<RouteState>, options: { replace?: boolean } = {}): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;

  const current = currentHash();
  const hash = mergeHash(current, patch) || "#";
  const normalisedCurrent = current === "" || current === "#" ? "#" : current;

  // Skip the history write entirely when nothing actually changed, so
  // repeated setState() calls with the same effective state don't pile up
  // duplicate entries that turn Back into a no-op (the fragment is
  // unchanged, so no hashchange fires and the user has to press Back twice).
  if (hash !== normalisedCurrent) {
    const url = `${location.pathname}${location.search}${hash}`;
    if (options.replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  }

  notify();
}

/** Subscribe to route state changes (both hand-edited hashes and setState()
 * calls). Returns an unsubscribe function. */
export function subscribe(cb: Listener): () => void {
  ensureListening();
  listeners.add(cb);
  return () => listeners.delete(cb);
}
