import { defineConfig } from "vite";

// GitHub Pages serves this project under /<repo>/, so the base must match for
// asset URLs to resolve. Overridable via BASE_PATH for other hosts.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/wcc-emergency-gis-showcase/",
  test: { globals: true, environment: "node" },
});
