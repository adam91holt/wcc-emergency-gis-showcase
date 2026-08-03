// Minimal, dependency-free starting point: renders the catalogue grouped by
// theme with a live search box. This is a SEED — the factory grows it into the
// full showcase (map views, per-dataset detail, charts) from here.
import { byTheme, search, label, catalogue, type Dataset } from "./catalogue";

function card(d: Dataset): string {
  const link = d.url ? `<a href="${d.url}" target="_blank" rel="noreferrer">source ↗</a>` : "";
  return `<article class="ds" data-scope="${d.scope}">
    <h3>${label(d)}</h3>
    <p class="meta">${d.scope} · ${d.authority ?? "—"}${d.year ? ` · ${d.year}` : ""}</p>
    ${link}
  </article>`;
}

function render(term: string): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  const grouped = byTheme(search(term));
  const sections = [...grouped.entries()]
    .map(([theme, ds]) => `<section><h2>${theme} <span class="count">${ds.length}</span></h2>
      <div class="grid">${ds.map(card).join("")}</div></section>`)
    .join("");
  app.innerHTML = sections || `<p class="empty">No datasets match “${term}”.</p>`;
}

function boot(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  document.querySelector<HTMLElement>("#total")!.textContent = String(catalogue.counts.total);
  const input = document.querySelector<HTMLInputElement>("#search");
  input?.addEventListener("input", () => render(input.value));
  render("");
}

if (typeof document !== "undefined") boot();
