// The discovery layer: theme + scope filter controls, a keyboard-navigable
// search combobox layered over catalogue.search(), and the single selection
// API other feature modules (map/detail) subscribe to. All filter/search/
// selection state lives in the URL hash via src/router.ts — this module never
// keeps its own copy of "what's selected", it always reads router state and
// writes back through setState().
//
// Split deliberately in two halves:
//   - pure functions (FilterState composition, facet counts, hash patches) —
//     these have no `document`/`window` reference at all, so filters.test.ts
//     exercises them directly in the node test environment.
//   - DOM rendering + event wiring, gated behind `typeof document`/`window`
//     checks the same way src/main.ts gates its own boot(), so importing this
//     module in a test never touches a browser global.
import "./filters.css";
import {
  datasets,
  themes,
  scopes,
  byScope,
  search,
  findById,
  label,
  type Dataset,
} from "./catalogue";
import { getState, setState, subscribe, type RouteState } from "./router";

// ---------------------------------------------------------------------------
// Pure filter logic
// ---------------------------------------------------------------------------

/** The subset of router state this module owns. `theme`/`scope` are each a
 * single value (the router's hash shape has no room for multi-select), so
 * the UI these render as toggles: picking a new value replaces the old one,
 * re-picking the active one clears it. */
export interface FilterState {
  theme?: string;
  scope?: Dataset["scope"];
  query?: string;
}

/** Read the active FilterState out of full router state, ignoring the keys
 * (`dataset`, `layers`) this module doesn't own. */
export function filterStateFromRoute(state: RouteState): FilterState {
  const out: FilterState = {};
  if (state.theme) out.theme = state.theme;
  if (state.scope) out.scope = state.scope as Dataset["scope"];
  if (state.query) out.query = state.query;
  return out;
}

/** The router patch for a given FilterState — explicit `undefined` for every
 * unset field, not just an omitted key, so applying it always *replaces* the
 * current filter state rather than merging into it (see router.mergeHash: a
 * key absent from the patch is left untouched, a key present as `undefined`
 * is removed). */
export function patchForFilters(filters: FilterState): Partial<RouteState> {
  return { theme: filters.theme, scope: filters.scope, query: filters.query };
}

/** Compose theme × scope × query over the catalogue's own selectors — the
 * single predicate every result count and every rendered list in this
 * ticket is built from. */
export function applyFilters(filters: FilterState, list: Dataset[] = datasets()): Dataset[] {
  let result = list;
  if (filters.scope) result = byScope(filters.scope, result);
  if (filters.theme) result = result.filter((d) => d.theme === filters.theme);
  if (filters.query) result = search(filters.query, result);
  return result;
}

/** How many datasets the given filters currently match. */
export function resultCount(filters: FilterState, list: Dataset[] = datasets()): number {
  return applyFilters(filters, list).length;
}

/** For each known theme, how many results it would match if it (rather than
 * whatever theme is currently active, if any) were selected — scope and
 * query held fixed. This is what lets the theme chips show *live* counts
 * that reflect the scope/search already applied, not just the catalogue-wide
 * total. */
export function themeFacetCounts(filters: FilterState, list: Dataset[] = datasets()): Map<string, number> {
  const base = applyFilters({ scope: filters.scope, query: filters.query }, list);
  const counts = new Map<string, number>();
  for (const t of themes(list)) counts.set(t.theme, base.filter((d) => d.theme === t.theme).length);
  return counts;
}

/** Same idea as themeFacetCounts, for the scope segmented control. */
export function scopeFacetCounts(
  filters: FilterState,
  list: Dataset[] = datasets(),
): Map<Dataset["scope"], number> {
  const base = applyFilters({ theme: filters.theme, query: filters.query }, list);
  const counts = new Map<Dataset["scope"], number>();
  for (const s of scopes(list)) counts.set(s.scope, base.filter((d) => d.scope === s.scope).length);
  return counts;
}

/** Whether any filter/search is currently active (drives the "clear all"
 * affordance's visibility). */
export function hasActiveFilters(filters: FilterState): boolean {
  return Boolean(filters.theme || filters.scope || filters.query);
}

/** Human sentence describing the active filters — used for the empty state's
 * explanation and for the search combobox's aria-live announcement, so both
 * say the same thing. Pure: takes the label lookup it needs from themes(). */
export function describeFilters(filters: FilterState, list: Dataset[] = datasets()): string {
  const parts: string[] = [];
  if (filters.theme) {
    const match = themes(list).find((t) => t.theme === filters.theme);
    parts.push(`theme “${match?.theme_label ?? filters.theme}”`);
  }
  if (filters.scope) parts.push(`${SCOPE_LABEL[filters.scope]} scope`);
  if (filters.query) parts.push(`search “${filters.query}”`);
  if (parts.length === 0) return "the whole catalogue";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The sentence the screen-reader live region announces after every filter,
 * search or scope change. */
export function announcement(filters: FilterState, total: number): string {
  const noun = total === 1 ? "dataset matches" : "datasets match";
  return `${total} ${noun} ${describeFilters(filters)}.`;
}

// ---------------------------------------------------------------------------
// Selection API — the contract the map/detail tickets consume.
// ---------------------------------------------------------------------------

type SelectionListener = (id: string | undefined) => void;

const selectionListeners = new Set<SelectionListener>();
let lastNotifiedId: string | undefined;
let routeSubscribed = false;

/** Subscribe to dataset selection changes, however they happen: a click on a
 * card, a keyboard Enter in the search combobox, a hand-edited URL, or the
 * user pressing Back/Forward. Returns an unsubscribe function. Consumers
 * (map/detail tickets) import only this and `selectDataset` — never this
 * module's DOM or router internals. */
export function onSelectionChange(cb: SelectionListener): () => void {
  selectionListeners.add(cb);
  return () => selectionListeners.delete(cb);
}

function notifySelection(id: string | undefined): void {
  for (const cb of selectionListeners) cb(id);
}

/** Ensure exactly one router subscription forwards `dataset` changes to
 * onSelectionChange listeners, regardless of how many times renderFilters
 * runs. No-ops outside a browser. */
function ensureRouteSubscription(): void {
  if (routeSubscribed || typeof window === "undefined") return;
  routeSubscribed = true;
  lastNotifiedId = getState().dataset;
  subscribe((state) => {
    if (state.dataset !== lastNotifiedId) {
      lastNotifiedId = state.dataset;
      notifySelection(state.dataset);
    }
  });
}

/** `push` when there's no prior selection, so Back from a freshly-opened
 * detail view returns to the unselected browsing state; `replace` when
 * swapping between datasets or closing one, so clicking through several
 * cards in a row (or dismissing a detail panel) doesn't spam one history
 * entry per click. */
function selectionHistoryMode(): { replace: boolean } {
  return { replace: getState().dataset !== undefined };
}

/** Select (or, with `undefined`, clear) a dataset and sync it to the URL. */
export function selectDataset(id: string | undefined): void {
  setState({ dataset: id }, selectionHistoryMode());
}

/** The currently selected dataset id, read straight from the URL. */
export function getSelectedId(): string | undefined {
  return getState().dataset;
}

/** Reset every filter/search this module owns (not `dataset`/`layers`) back
 * to "show everything". A deliberate, infrequent action, so it pushes a
 * fresh history entry like any other filter change. */
export function clearAll(): void {
  cancelPendingQuery();
  setState(patchForFilters({}));
  if (typeof document === "undefined") return;
  if (inputEl) inputEl.value = "";
  closeListbox();
}

// ---------------------------------------------------------------------------
// Icon set — one family, hand-drawn on a 16px grid, solid paths in
// currentColor. Every glyph in this ticket (console, combobox, cards) comes
// from here; no second icon library, no emoji.
// ---------------------------------------------------------------------------

function svg(path: string, size = 14): string {
  return `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="${path}" fill="currentColor"/></svg>`;
}

const ICON_SEARCH = svg(
  "M7 1a6 6 0 1 0 3.76 10.66l3.79 3.79a1 1 0 0 0 1.41-1.41l-3.79-3.79A6 6 0 0 0 7 1Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z",
);
const ICON_CLEAR = svg(
  "M3.3 3.3a1 1 0 0 1 1.4 0L8 6.6l3.3-3.3a1 1 0 1 1 1.4 1.4L9.4 8l3.3 3.3a1 1 0 0 1-1.4 1.4L8 9.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L6.6 8 3.3 4.7a1 1 0 0 1 0-1.4Z",
  12,
);
const ICON_RESET = svg(
  "M8 2a6 6 0 1 0 5.65 8 1 1 0 1 0-1.88-.67A4 4 0 1 1 8 4a3.96 3.96 0 0 1 2.6.98L9.3 6.29A.7.7 0 0 0 9.8 7.5H13a1 1 0 0 0 1-1V3.3a.7.7 0 0 0-1.2-.5l-.79.79A5.97 5.97 0 0 0 8 2Z",
  13,
);
const ICON_ENTER = svg(
  "M13 2a1 1 0 0 1 1 1v4a3 3 0 0 1-3 3H5.41l1.3 1.29a1 1 0 1 1-1.42 1.42l-3-3a1 1 0 0 1 0-1.42l3-3a1 1 0 0 1 1.42 1.42L5.41 8H11a1 1 0 0 0 1-1V3a1 1 0 0 1 1-1Z",
  12,
);

const SCOPE_LABEL: Record<Dataset["scope"], string> = {
  wcc: "WCC",
  regional: "Regional",
  national: "National",
};

// ---------------------------------------------------------------------------
// DOM rendering — the filter console (#filters-root)
// ---------------------------------------------------------------------------
// The console is built exactly once and then *patched in place* on every
// route change. Re-serialising innerHTML per change would be simpler, but it
// would throw away the element identity the CSS transitions animate from and
// — worse — drop keyboard focus off whichever chip the user just activated.

type SegKey = "all" | Dataset["scope"];

/** The width the segmented control's thumb is drawn at before being scaled
 * to the active segment's measured width (transform only, never width). */
const THUMB_UNIT = 100;

interface ConsolePanel {
  root: HTMLElement;
  shell: HTMLElement;
  count: HTMLElement;
  live: HTMLElement;
  clear: HTMLButtonElement;
  thumb: HTMLElement;
  segButtons: Map<SegKey, HTMLButtonElement>;
  segCounts: Map<SegKey, HTMLElement>;
  chips: Map<string, HTMLButtonElement>;
  chipCounts: Map<string, HTMLElement>;
  empty: HTMLElement;
  emptyBody: HTMLElement;
}

let panel: ConsolePanel | null = null;
let hydrating = false;
let pendingRoute: RouteState | null = null;

/** Skeleton shapes that match the real console's geometry (head readout,
 * segmented control, chip rack), so the first frame is never a blank mount
 * or a spinner. The facet pass behind the real panel is 67 rows × 13 facets;
 * painting the shell first and hydrating on the next frame keeps that work
 * off the critical path, and on a slow device this is what the user sees
 * while it runs. */
function paintSkeleton(root: HTMLElement): void {
  const chipWidths = [96, 132, 108, 88, 146, 118, 92, 126, 104];
  root.innerHTML = `
    <div class="console is-loading" aria-busy="true">
      <span class="console__rail" aria-hidden="true"></span>
      <div class="console__head">
        <p class="console__label">Discovery console</p>
        <span class="skel skel--readout" aria-hidden="true"></span>
      </div>
      <div class="console__body">
        <div class="facet">
          <p class="facet__label">Scope</p>
          <span class="skel skel--seg" aria-hidden="true"></span>
        </div>
        <div class="facet facet--themes">
          <p class="facet__label">Theme</p>
          <div class="chips">
            ${chipWidths.map((w) => `<span class="skel skel--chip" style="width:${w}px" aria-hidden="true"></span>`).join("")}
          </div>
        </div>
      </div>
      <p class="sr-only">Loading filter counts…</p>
    </div>`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A facet control (theme chip or scope segment): status dot, label, and a
 * tabular-mono live count. Both variants share the same inner anatomy so the
 * console reads as one instrument rather than two widgets. */
function facetButton(
  className: string,
  action: string,
  text: string,
): { button: HTMLButtonElement; count: HTMLElement } {
  const button = el("button", className);
  button.type = "button";
  button.dataset.action = action;
  button.setAttribute("aria-pressed", "false");
  const dot = el("span", "facet-dot");
  dot.setAttribute("aria-hidden", "true");
  const count = el("span", "facet-count", "0");
  button.append(dot, el("span", "facet-text", text), count);
  return { button, count };
}

/** ⌘K on a Mac, Ctrl K everywhere else — the shortcut handler accepts both,
 * so the hint should show the one the reader actually has. */
function shortcutHint(): string {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  return mac ? "⌘K" : "Ctrl K";
}

function buildConsole(root: HTMLElement): ConsolePanel {
  const list = datasets();
  root.innerHTML = `
    <div class="console" data-filtered="false">
      <span class="console__rail" aria-hidden="true"></span>
      <div class="console__head">
        <div class="console__ident">
          <p class="console__label">Discovery console</p>
          <p class="console__hint">
            <kbd>/</kbd> or <kbd>${shortcutHint()}</kbd> to search ·
            <kbd>↑</kbd><kbd>↓</kbd> to walk results · <kbd>Enter</kbd> to select
          </p>
        </div>
        <p class="console__readout" aria-hidden="true">
          <span class="console__count">0</span>
          <span class="console__total">/ ${list.length}</span>
          <span class="console__unit">in view</span>
        </p>
        <button type="button" class="console__clear" data-action="clear-all" hidden>
          ${ICON_CLEAR}<span>Clear all</span>
        </button>
      </div>
      <div class="console__body">
        <div class="facet">
          <p class="facet__label">Scope</p>
          <div class="seg" role="group" aria-label="Scope">
            <span class="seg__thumb" aria-hidden="true"></span>
          </div>
        </div>
        <div class="facet facet--themes">
          <p class="facet__label">Theme</p>
          <div class="chips" role="group" aria-label="Theme"></div>
        </div>
      </div>
      <div class="console__empty" hidden>
        <p class="console__empty-title">Nothing matches that combination</p>
        <p class="console__empty-body"></p>
        <button type="button" class="btn-reset" data-action="clear-all">
          ${ICON_RESET}<span>Reset filters</span>
        </button>
      </div>
      <p class="sr-only" role="status" aria-live="polite"></p>
    </div>`;

  const shell = root.querySelector<HTMLElement>(".console")!;
  const seg = root.querySelector<HTMLElement>(".seg")!;
  const chipRack = root.querySelector<HTMLElement>(".chips")!;

  const segButtons = new Map<SegKey, HTMLButtonElement>();
  const segCounts = new Map<SegKey, HTMLElement>();
  const segments: { key: SegKey; text: string }[] = [
    { key: "all", text: "All" },
    ...scopes(list).map((s) => ({ key: s.scope as SegKey, text: SCOPE_LABEL[s.scope] })),
  ];
  for (const { key, text } of segments) {
    const { button, count } = facetButton("seg__btn", "set-scope", text);
    button.dataset.scope = key === "all" ? "" : key;
    seg.append(button);
    segButtons.set(key, button);
    segCounts.set(key, count);
  }

  const chips = new Map<string, HTMLButtonElement>();
  const chipCounts = new Map<string, HTMLElement>();
  for (const t of themes(list)) {
    const { button, count } = facetButton("chip", "set-theme", t.theme_label);
    button.dataset.theme = t.theme;
    const bar = el("span", "chip__bar");
    bar.setAttribute("aria-hidden", "true");
    button.append(bar);
    chipRack.append(button);
    chips.set(t.theme, button);
    chipCounts.set(t.theme, count);
  }

  wireRoot(root);

  return {
    root,
    shell,
    count: root.querySelector<HTMLElement>(".console__count")!,
    live: root.querySelector<HTMLElement>(".sr-only")!,
    clear: root.querySelector<HTMLButtonElement>(".console__clear")!,
    thumb: root.querySelector<HTMLElement>(".seg__thumb")!,
    segButtons,
    segCounts,
    chips,
    chipCounts,
    empty: root.querySelector<HTMLElement>(".console__empty")!,
    emptyBody: root.querySelector<HTMLElement>(".console__empty-body")!,
  };
}

/** Retrigger the readout's tick animation whenever the number actually
 * changes, so a filter that narrows the result set is *felt*, not just read. */
function setReadout(node: HTMLElement, value: number): void {
  const next = String(value);
  if (node.textContent === next) return;
  node.textContent = next;
  node.classList.remove("is-tick");
  void node.offsetWidth; // force a reflow so the animation restarts
  node.classList.add("is-tick");
}

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function positionThumb(scope: Dataset["scope"] | undefined): void {
  if (!panel) return;
  const active = panel.segButtons.get(scope ?? "all");
  if (!active || active.offsetWidth === 0) return;
  panel.thumb.style.transform = `translateX(${active.offsetLeft}px) scaleX(${active.offsetWidth / THUMB_UNIT})`;
}

function syncConsole(state: RouteState): void {
  if (!panel) return;
  const filters = filterStateFromRoute(state);
  const list = datasets();
  const total = resultCount(filters, list);
  const themeCounts = themeFacetCounts(filters, list);
  const scopeCounts = scopeFacetCounts(filters, list);

  setReadout(panel.count, total);
  panel.shell.dataset.filtered = String(hasActiveFilters(filters));
  panel.clear.hidden = !hasActiveFilters(filters);

  const scopeless = resultCount({ theme: filters.theme, query: filters.query }, list);
  for (const [key, button] of panel.segButtons) {
    const active = key === "all" ? filters.scope === undefined : filters.scope === key;
    button.setAttribute("aria-pressed", String(active));
    const count = key === "all" ? scopeless : scopeCounts.get(key) ?? 0;
    setText(panel.segCounts.get(key)!, String(count));
  }
  positionThumb(filters.scope);

  const peak = Math.max(1, ...themeCounts.values());
  for (const [theme, button] of panel.chips) {
    const count = themeCounts.get(theme) ?? 0;
    const active = filters.theme === theme;
    button.setAttribute("aria-pressed", String(active));
    // A chip that can only ever produce an empty page is a dead end — dim it
    // out rather than letting the user walk into one.
    button.disabled = count === 0 && !active;
    button.style.setProperty("--fill", String(count / peak));
    setText(panel.chipCounts.get(theme)!, String(count));
  }

  panel.empty.hidden = total > 0;
  setText(
    panel.emptyBody,
    `No dataset in the catalogue matches ${describeFilters(filters, list)}. Reset to browse all ${list.length}, or widen one facet at a time.`,
  );
  // Only when it actually differs: rewriting a live region with identical
  // text makes some screen readers announce the same count twice.
  setText(panel.live, announcement(filters, total));

  syncSearchInput(filters);
}

const wiredRoots = new WeakSet<HTMLElement>();

function setTheme(theme: string | undefined): void {
  const current = filterStateFromRoute(getState()).theme;
  setState({ theme: current === theme ? undefined : theme });
}

function setScope(scope: string | undefined): void {
  // Segmented control, not a toggle: "All" is its own segment, so re-picking
  // the active scope is a no-op rather than a surprise reset.
  setState({ scope: (scope || undefined) as RouteState["scope"] });
}

function wireRoot(root: HTMLElement): void {
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);
  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "set-theme") setTheme(target.dataset.theme);
    else if (action === "set-scope") setScope(target.dataset.scope);
    else if (action === "clear-all") clearAll();
  });
  if (typeof window !== "undefined") {
    window.addEventListener("resize", () => positionThumb(filterStateFromRoute(getState()).scope));
  }
}

/** The FeatureModule this ticket registers against `#filters-root` (see
 * src/main.ts's registerMount). Called once at boot and again on every route
 * change; the first call paints the skeleton and hydrates on the next frame,
 * every later call patches the live panel. */
export default function renderFilters(root: HTMLElement, state: RouteState): void {
  ensureRouteSubscription();
  ensureSearchCombobox();
  pendingRoute = state;
  if (panel && panel.root === root) {
    syncConsole(state);
    return;
  }
  if (hydrating) return;
  hydrating = true;
  paintSkeleton(root);
  const hydrate = (): void => {
    panel = buildConsole(root);
    hydrating = false;
    syncConsole(pendingRoute ?? getState());
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(hydrate);
  else hydrate();
}

// ---------------------------------------------------------------------------
// DOM rendering — the keyboard-navigable search combobox over #search
// ---------------------------------------------------------------------------
// ARIA 1.2 combobox-with-listbox pattern: the text input owns
// role="combobox"/aria-expanded/aria-controls/aria-activedescendant, a
// sibling <ul role="listbox"> holds the suggestions, and each suggestion is a
// role="option" with a stable id so aria-activedescendant can point at it
// without moving focus off the input. Result counts are announced by the
// console's single live region (see syncConsole) rather than a second one
// here, so a screen reader hears the count once, not twice.

const MAX_SUGGESTIONS = 8;
/** Coalesce keystrokes into one hash write: without this, a 30-character
 * query would issue 30 history.replaceState calls (Safari rate-limits those)
 * and 30 full facet recomputes. */
const QUERY_DEBOUNCE_MS = 120;

let comboInitialized = false;
let activeIndex = -1;
let currentOptionIds: string[] = [];
let inputEl: HTMLInputElement | null = null;
let listboxEl: HTMLUListElement | null = null;
let queryTimer: ReturnType<typeof setTimeout> | null = null;
let pendingQuery: string | null = null;

function cancelPendingQuery(): void {
  if (queryTimer !== null) clearTimeout(queryTimer);
  queryTimer = null;
  pendingQuery = null;
}

/** Write the debounced query to the hash. `push` for the first keystroke of
 * a new search (so Back leaves the search and returns to the browsing view),
 * `replace` for every edit after that (so typing never spams history). */
function flushQuery(): void {
  if (queryTimer !== null) clearTimeout(queryTimer);
  queryTimer = null;
  if (pendingQuery === null) return;
  const value = pendingQuery.trim();
  pendingQuery = null;
  setState({ query: value || undefined }, { replace: Boolean(getState().query) });
}

function queueQuery(value: string): void {
  pendingQuery = value;
  if (queryTimer !== null) clearTimeout(queryTimer);
  queryTimer = setTimeout(flushQuery, QUERY_DEBOUNCE_MS);
}

function closeListbox(): void {
  activeIndex = -1;
  currentOptionIds = [];
  if (!listboxEl || !inputEl) return;
  listboxEl.hidden = true;
  listboxEl.innerHTML = "";
  inputEl.setAttribute("aria-expanded", "false");
  inputEl.removeAttribute("aria-activedescendant");
}

function optionId(id: string): string {
  return `search-option-${id}`;
}

function markActive(index: number): void {
  if (!listboxEl || !inputEl) return;
  const options = listboxEl.querySelectorAll<HTMLLIElement>(".search-option");
  activeIndex = index;
  options.forEach((node, i) => {
    const active = i === index;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-selected", String(active));
  });
  const activeNode = options[index];
  if (activeNode) {
    activeNode.scrollIntoView({ block: "nearest" });
    inputEl.setAttribute("aria-activedescendant", activeNode.id);
  } else {
    inputEl.removeAttribute("aria-activedescendant");
  }
}

/** Rebuild the suggestion list from the *typed* value (not the debounced
 * hash value) so the list never lags a keystroke behind. `force` opens the
 * list on ArrowDown even with an empty query, showing what the current
 * theme/scope filters already narrowed the catalogue to. */
function renderSuggestions(force = false): void {
  if (!inputEl || !listboxEl) return;
  const query = inputEl.value.trim();
  if (!query && !force) {
    closeListbox();
    return;
  }

  const filters: FilterState = { ...filterStateFromRoute(getState()), query: query || undefined };
  const matches = applyFilters(filters).slice(0, MAX_SUGGESTIONS);
  currentOptionIds = matches.map((d) => d.id);

  listboxEl.textContent = "";
  const selected = getSelectedId();
  matches.forEach((d, i) => {
    const option = el("li", "search-option");
    option.id = optionId(d.id);
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(i === 0));
    if (d.id === selected) option.dataset.selected = "true";
    option.append(
      el("span", "search-option__name", label(d)),
      el("span", "search-option__meta", `${SCOPE_LABEL[d.scope]}${d.theme_label ? ` · ${d.theme_label}` : ""}`),
    );
    const enter = el("span", "search-option__enter");
    enter.innerHTML = ICON_ENTER;
    enter.setAttribute("aria-hidden", "true");
    option.append(enter);
    listboxEl!.append(option);
  });

  listboxEl.hidden = matches.length === 0;
  inputEl.setAttribute("aria-expanded", String(matches.length > 0));
  markActive(matches.length > 0 ? 0 : -1);
}

function moveActive(delta: number): void {
  if (currentOptionIds.length === 0) return;
  const count = currentOptionIds.length;
  markActive((activeIndex + delta + count) % count);
}

function commitSelection(): void {
  if (activeIndex < 0 || activeIndex >= currentOptionIds.length) return;
  const id = currentOptionIds[activeIndex];
  if (!findById(id)) return;
  // Land the in-flight query first so the shared link carries both the search
  // that found the dataset and the dataset itself.
  flushQuery();
  selectDataset(id);
  closeListbox();
}

function onSearchInput(): void {
  if (!inputEl) return;
  queueQuery(inputEl.value);
  renderSuggestions();
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (!inputEl) return;
  const open = listboxEl?.hidden === false;
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      if (open) moveActive(1);
      else renderSuggestions(true);
      break;
    case "ArrowUp":
      event.preventDefault();
      if (open) moveActive(-1);
      else renderSuggestions(true);
      break;
    case "Home":
      if (open) {
        event.preventDefault();
        markActive(0);
      }
      break;
    case "End":
      if (open) {
        event.preventDefault();
        markActive(currentOptionIds.length - 1);
      }
      break;
    case "Enter":
      if (open) {
        event.preventDefault();
        commitSelection();
      }
      break;
    case "Escape":
      // Progressive: dismiss the list, then clear the query, then let go of
      // focus — one Escape per level, never all three at once.
      if (open) closeListbox();
      else if (inputEl.value) {
        inputEl.value = "";
        queueQuery("");
        flushQuery();
      } else inputEl.blur();
      break;
    default:
      break;
  }
}

function isTypingElsewhere(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (!inputEl) return;
  const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
  const isSlash = event.key === "/" && !isTypingElsewhere(event.target);
  if (!isShortcut && !isSlash) return;
  event.preventDefault();
  inputEl.focus();
  inputEl.select();
}

/** Sync the search input's displayed value with router state — needed when
 * the query changed from outside the input itself (Back/Forward, a
 * hand-edited hash, or "Clear all"). Never overwrites what the user is
 * actively typing. */
function syncSearchInput(filters: FilterState): void {
  // `pendingQuery !== null` means the user's most recent keystrokes haven't
  // reached the hash yet — the input, not the URL, is the source of truth
  // until they land. Once they have, sync from route state even while the
  // input still has focus: Back/Forward and hand-edited hashes must be able
  // to correct the visible query, or a keyboard user who never blurred the
  // combobox sees stale text that contradicts the URL and the results below
  // it. The value-equality check below already no-ops when nothing changed,
  // so this never disturbs an in-progress, not-yet-flushed edit.
  if (!inputEl || pendingQuery !== null) return;
  const routeQuery = filters.query ?? "";
  if (inputEl.value !== routeQuery) inputEl.value = routeQuery;
}

/** One-time enhancement of the existing `#search` input into a full
 * combobox: wraps it, adds the listbox, and wires all the keyboard
 * behaviour. Idempotent and safe to call from every renderFilters pass — it
 * does nothing after the first successful run. */
function ensureSearchCombobox(): void {
  if (comboInitialized || typeof document === "undefined") return;
  const input = document.querySelector<HTMLInputElement>("#search");
  if (!input) return;
  comboInitialized = true;
  inputEl = input;

  const wrap = el("div", "search-combobox");
  const icon = el("span", "search-combobox__icon");
  icon.innerHTML = ICON_SEARCH;
  icon.setAttribute("aria-hidden", "true");

  const hint = el("span", "search-combobox__hint");
  hint.setAttribute("aria-hidden", "true");
  hint.innerHTML = "<kbd>/</kbd>";

  const listbox = document.createElement("ul");
  listbox.id = "search-listbox";
  listbox.className = "search-listbox";
  listbox.setAttribute("role", "listbox");
  listbox.setAttribute("aria-label", "Dataset suggestions");
  listbox.hidden = true;

  input.replaceWith(wrap);
  wrap.append(icon, input, hint, listbox);
  listboxEl = listbox;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listbox.id);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("autocomplete", "off");
  input.placeholder = `Search ${datasets().length} datasets by name, theme or authority…`;

  const query = filterStateFromRoute(getState()).query;
  if (query) input.value = query;

  input.addEventListener("input", onSearchInput);
  input.addEventListener("keydown", onSearchKeydown);
  input.addEventListener("focusout", (event) => {
    if (!wrap.contains(event.relatedTarget as Node)) closeListbox();
  });
  listbox.addEventListener("mousedown", (event) => {
    // mousedown (not click) so this fires before the input's focusout.
    const option = (event.target as HTMLElement).closest<HTMLLIElement>(".search-option");
    if (!option) return;
    event.preventDefault();
    markActive([...listbox.children].indexOf(option));
    commitSelection();
  });
  document.addEventListener("keydown", onGlobalKeydown);
}
