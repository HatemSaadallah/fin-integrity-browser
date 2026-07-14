import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // esm + cjs for bundlers; iife global for a plain <script> tag / CDN.
  format: ["esm", "cjs", "iife"],
  globalName: "FinIntegrity",
  dts: true,
  clean: true,
  treeshake: true,
  minify: true,
  target: "es2020",
});
