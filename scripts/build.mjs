import { cp, mkdir } from "node:fs/promises";

import { build } from "esbuild";

await build({
  entryPoints: [
    "src/index.ts",
    "src/client/index.ts",
    "src/indexeddb/index.ts",
    "src/next/index.ts",
    "src/react/index.ts",
    "src/schema/index.ts",
  ],
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["react"],
  outbase: "src",
  outdir: "dist",
  sourcemap: true,
});

await build({
  entryPoints: ["src/cli/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["esbuild"],
  outfile: "bin/sync-engine",
  banner: {
    js: "#!/usr/bin/env node",
  },
  sourcemap: true,
});

await mkdir("bin/templates", { recursive: true });
await cp("src/cli/next/templates", "bin/templates", {
  recursive: true,
});
