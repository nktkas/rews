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
  test: false,
  declarationMap: false,
  package: {
    name: "@nktkas/rews",
    version: denoJson.version,
    description:
      "Drop-in WebSocket replacement that reconnects automatically and preserves all event listeners and buffered messages.",
    keywords: [
      "websocket",
      "ws",
      "reconnecting",
      "reconnection",
      "reconnect",
      "retrying",
      "automatic",
    ],
    author: {
      name: "nktkas",
      email: "github.turk9@passmail.net",
      url: "https://github.com/nktkas",
    },
    homepage: "https://github.com/nktkas/rews",
    repository: {
      type: "git",
      url: "git+https://github.com/nktkas/rews.git",
    },
    bugs: {
      url: "https://github.com/nktkas/rews/issues",
    },
    license: "MIT",
    sideEffects: false,
  },
  compilerOptions: {
    lib: ["ESNext", "DOM"],
    target: "Latest",
  },
});

await Promise.all([
  // Copy additional files to npm build directory
  Deno.copyFile("LICENSE", "build/npm/LICENSE"),
  Deno.copyFile("README.md", "build/npm/README.md"),
  // Add more items to ignore list in .npmignore
  Deno.writeTextFile("./build/npm/.npmignore", "node_modules\n", { append: true }),
  Deno.writeTextFile("./build/npm/.npmignore", "package-lock.json\n", { append: true }),
]);
