import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/worker/index.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: true,
    external: ["cloudflare:workers", "cloudflare:workflows"],
  },
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
