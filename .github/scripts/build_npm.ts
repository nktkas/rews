// deno-lint-ignore-file no-import-prefix
/**
 * Builds the Deno library for working with NodeJS or publishing to npm
 * Command: deno run -A .github/scripts/build_npm.ts
 */

import { build, emptyDir } from "jsr:@deno/dnt@^0.42.1";
import denoJson from "../../deno.json" with { type: "json" };

await emptyDir("./build/npm");
await build({
  entryPoints: ["./mod.ts"],
  outDir: "./build/npm",
  shims: {},
  typeCheck: "both",
  test: false,
  package: {
    name: "@nktkas/rews",
    version: denoJson.version,
    description: "WebSocket with auto-reconnection — a drop-in replacement for the standard WebSocket.",
    keywords: [
      "websocket",
      "ws",
      "reconnecting",
      "reconnection",
      "reconnect",
      "retrying",
      "automatic",
    ],
    homepage: "https://github.com/nktkas/rews",
    bugs: {
      url: "https://github.com/nktkas/rews/issues",
    },
    repository: {
      type: "git",
      url: "git+https://github.com/nktkas/rews.git",
    },
    license: "MIT",
    author: {
      name: "nktkas",
      email: "github.turk9@passmail.net",
      url: "https://github.com/nktkas",
    },
    sideEffects: false,
    engines: {
      node: ">=20.19.0",
    },
  },
  compilerOptions: {
    lib: ["ESNext", "DOM"],
    target: "Latest",
    sourceMap: true,
  },
});
await Promise.all([
  // Copy additional files to npm build directory
  Deno.copyFile("LICENSE", "build/npm/LICENSE"),
  Deno.copyFile("README.md", "build/npm/README.md"),
]);
