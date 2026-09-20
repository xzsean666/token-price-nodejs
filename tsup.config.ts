import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: "es2022",
  platform: "neutral",
  treeshake: true,
  minify: false,
  external: ["axios", "zod", "node:sqlite", "node:fs", "node:path", "node:crypto", "node:zlib", "node:module"],
});
