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
  setState({ theme: undefined, scope: undefined, query: undefined });
  if (typeof document === "undefined") return;
  if (inputEl) inputEl.value = "";
  closeListbox();
}

// ---------------------------------------------------------------------------
// DOM rendering — filter chips/segmented control (#filters-root)
// ---------------------------------------------------------------------------

const ICON_CHECK =
  '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false"><path d="M13.7 4.3a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L7 9.6l5.3-5.3a1 1 0 0 1 1.4 0Z" fill="currentColor"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M7 1a6 6 0 1 0 3.76 10.66l3.79 3.79a1 1 0 0 0 1.41-1.41l-3.79-3.79A6 6 0 0 0 7 1Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" fill="currentColor"/></svg>';
const ICON_CLEAR =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M3.3 3.3a1 1 0 0 1 1.4 0L8 6.6l3.3-3.3a1 1 0 1 1 1.4 1.4L9.4 8l3.3 3.3a1 1 0 0 1-1.4 1.4L8 9.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L6.6 8 3.3 4.7a1 1 0 0 1 0-1.4Z" fill="currentColor"/></svg>';

const SCOPE_LABEL: Record<Dataset["scope"], string> = {
  wcc: "WCC",
  regional: "Regional",
  national: "National",
};

function scopeButton(scopeValue: string, activeLabel: string, count: number, active: boolean): string {
  return `<button type="button" class="scope-btn${active ? " is-active" : ""}" data-action="set-scope" data-scope="${scopeValue}" aria-pressed="${active}">
    ${active ? ICON_CHECK : ""}<span>${activeLabel}</span><span class="fcount">${count}</span>
  </button>`;
}

function themeChip(theme: string, themeLabel: string, count: number, active: boolean): string {
  return `<button type="button" class="chip${active ? " is-active" : ""}" data-action="set-theme" data-theme="${theme}" aria-pressed="${active}">
    ${active ? ICON_CHECK : ""}<span>${themeLabel}</span><span class="fcount">${count}</span>
  </button>`;
}

function buildFiltersHtml(filters: FilterState): string {
  const list = datasets();
  const scopeCounts = scopeFacetCounts(filters, list);
  const themeCounts = themeFacetCounts(filters, list);
  const total = resultCount(filters, list);

  const scopeButtons = scopes(list)
    .map((s) => scopeButton(s.scope, SCOPE_LABEL[s.scope], scopeCounts.get(s.scope) ?? 0, filters.scope === s.scope))
    .join("");

  const themeChips = themes(list)
    .map((t) => themeChip(t.theme, t.theme_label, themeCounts.get(t.theme) ?? 0, filters.theme === t.theme))
    .join("");

  const clearVisible = hasActiveFilters(filters);

  return `
    <div class="filters">
      <div class="filters__group" role="group" aria-label="Scope">
        <span class="filters__label">Scope</span>
        <div class="scope-control">${scopeButtons}</div>
      </div>
      <div class="filters__group filters__group--themes" role="group" aria-label="Theme">
        <span class="filters__label">Theme</span>
        <div class="theme-chips">${themeChips}</div>
      </div>
      <div class="filters__meta">
        <span class="filters__count" aria-live="polite">${total} of ${list.length} datasets</span>
        <button type="button" class="filters__clear" data-action="clear-all" ${clearVisible ? "" : "hidden"}>
          ${ICON_CLEAR}<span>Clear all</span>
        </button>
      </div>
    </div>
  `;
}

const wiredRoots = new WeakSet<HTMLElement>();

function setTheme(theme: string | undefined): void {
  const current = filterStateFromRoute(getState()).theme;
  setState({ theme: current === theme ? undefined : theme });
}

function setScope(scope: string | undefined): void {
  const current = filterStateFromRoute(getState()).scope;
  setState({ scope: (current === scope ? undefined : scope) as RouteState["scope"] });
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
}

/** The FeatureModule this ticket registers against `#filters-root` (see
 * src/main.ts's registerMount). Re-runs on every route change. */
export default function renderFilters(root: HTMLElement, state: RouteState): void {
  ensureRouteSubscription();
  ensureSearchCombobox();
  const filters = filterStateFromRoute(state);
  root.innerHTML = buildFiltersHtml(filters);
  wireRoot(root);
  syncSearchInput(filters);
}

// ---------------------------------------------------------------------------
// DOM rendering — the keyboard-navigable search combobox over #search
// ---------------------------------------------------------------------------
// ARIA 1.2 combobox-with-listbox pattern: the text input owns
// role="combobox"/aria-expanded/aria-controls/aria-activedescendant, a
// sibling <ul role="listbox"> holds the suggestions, and each suggestion is a
// role="option" with a stable id so aria-activedescendant can point at it
// without moving focus off the input.

const MAX_SUGGESTIONS = 8;

let comboInitialized = false;
let activeIndex = -1;
let currentOptionIds: string[] = [];
let inputEl: HTMLInputElement | null = null;
let listboxEl: HTMLUListElement | null = null;
let liveEl: HTMLDivElement | null = null;

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

function renderSuggestions(): void {
  if (!inputEl || !listboxEl || !liveEl) return;
  const query = inputEl.value.trim();
  if (!query) {
    closeListbox();
    liveEl.textContent = "";
    return;
  }

  const filters = { ...filterStateFromRoute(getState()), query };
  const matches = applyFilters(filters).slice(0, MAX_SUGGESTIONS);
  currentOptionIds = matches.map((d) => d.id);
  activeIndex = matches.length > 0 ? 0 : -1;

  listboxEl.innerHTML = matches
    .map(
      (d, i) => `<li id="${optionId(d.id)}" role="option" class="search-option${i === 0 ? " is-active" : ""}" aria-selected="${i === 0}">
        <span class="search-option__name">${label(d)}</span>
        <span class="search-option__meta">${SCOPE_LABEL[d.scope]}${d.theme_label ? ` · ${d.theme_label}` : ""}</span>
      </li>`,
    )
    .join("");
  listboxEl.hidden = matches.length === 0;
  inputEl.setAttribute("aria-expanded", String(matches.length > 0));
  inputEl.setAttribute("aria-activedescendant", matches.length > 0 ? optionId(matches[0].id) : "");

  const totalMatches = applyFilters(filters).length;
  liveEl.textContent = totalMatches === 1 ? "1 result" : `${totalMatches} results`;
}

function moveActive(delta: number): void {
  if (!listboxEl || currentOptionIds.length === 0) return;
  const count = currentOptionIds.length;
  activeIndex = (activeIndex + delta + count) % count;
  const options = listboxEl.querySelectorAll<HTMLLIElement>(".search-option");
  options.forEach((el, i) => {
    const active = i === activeIndex;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-selected", String(active));
  });
  const activeEl = options[activeIndex];
  if (activeEl) {
    activeEl.scrollIntoView({ block: "nearest" });
    inputEl?.setAttribute("aria-activedescendant", activeEl.id);
  }
}

function commitSelection(): void {
  if (activeIndex < 0 || activeIndex >= currentOptionIds.length) return;
  const id = currentOptionIds[activeIndex];
  const d = findById(id);
  if (inputEl && d) inputEl.value = label(d);
  // One combined write (not selectDataset() + a separate query clear) so
  // this is a single history entry, not two.
  setState({ dataset: id, query: undefined }, selectionHistoryMode());
  closeListbox();
}

function onSearchInput(): void {
  if (!inputEl) return;
  setState({ query: inputEl.value || undefined }, { replace: true });
  renderSuggestions();
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (!inputEl) return;
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      if (listboxEl?.hidden !== false) renderSuggestions();
      else moveActive(1);
      break;
    case "ArrowUp":
      event.preventDefault();
      if (listboxEl?.hidden !== false) renderSuggestions();
      else moveActive(-1);
      break;
    case "Enter":
      if (listboxEl?.hidden === false) {
        event.preventDefault();
        commitSelection();
      }
      break;
    case "Escape":
      if (listboxEl?.hidden === false) {
        closeListbox();
      } else if (inputEl.value) {
        inputEl.value = "";
        setState({ query: undefined }, { replace: true });
      } else {
        inputEl.blur();
      }
      break;
    default:
      break;
  }
}

function isTypingElsewhere(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
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
  if (!inputEl || document.activeElement === inputEl) return;
  const routeQuery = filters.query ?? "";
  if (inputEl.value !== routeQuery) inputEl.value = routeQuery;
}

/** One-time enhancement of the existing `#search` input into a full
 * combobox: wraps it, adds the listbox + live region, and wires all the
 * keyboard behaviour. Idempotent and safe to call from every renderFilters
 * pass — it does nothing after the first successful run. */
function ensureSearchCombobox(): void {
  if (comboInitialized || typeof document === "undefined") return;
  const input = document.querySelector<HTMLInputElement>("#search");
  if (!input) return;
  comboInitialized = true;
  inputEl = input;

  const wrap = document.createElement("div");
  wrap.className = "search-combobox";
  const icon = document.createElement("span");
  icon.className = "search-combobox__icon";
  icon.innerHTML = ICON_SEARCH;

  const listbox = document.createElement("ul");
  listbox.id = "search-listbox";
  listbox.className = "search-listbox";
  listbox.setAttribute("role", "listbox");
  listbox.setAttribute("aria-label", "Search suggestions");
  listbox.hidden = true;

  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");

  input.replaceWith(wrap);
  wrap.append(icon, input, listbox, live);
  listboxEl = listbox;
  liveEl = live;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listbox.id);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("autocomplete", "off");

  const state = filterStateFromRoute(getState());
  if (state.query) input.value = state.query;

  input.addEventListener("input", onSearchInput);
  input.addEventListener("keydown", onSearchKeydown);
  input.addEventListener("focusout", (event) => {
    if (!wrap.contains(event.relatedTarget as Node)) closeListbox();
  });
  listbox.addEventListener("mousedown", (event) => {
    // mousedown (not click) so this fires before the input's focusout.
    const li = (event.target as HTMLElement).closest<HTMLLIElement>(".search-option");
    if (!li) return;
    event.preventDefault();
    activeIndex = [...listbox.children].indexOf(li);
    commitSelection();
  });
  document.addEventListener("keydown", onGlobalKeydown);
}
