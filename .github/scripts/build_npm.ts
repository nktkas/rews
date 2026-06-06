// deno-lint-ignore-file no-import-prefix

/**
 * Builds the Deno library into an ESM-only npm package.
 *
 * @example
 * ```sh
 * deno run -A .github/scripts/build_npm.ts
 * ```
 */

import { build } from "jsr:@nktkas/dtn@^1";
import denoJson from "../../deno.json" with { type: "json" };

if (import.meta.main) {
  await build({
    outDir: "dist",
    denoJson,
    packageJson: {
      description: "Drop-in WebSocket replacement with automatic reconnection.",
      keywords: ["websocket", "ws", "reconnect", "retry"],
      homepage: "https://github.com/nktkas/rews",
      bugs: { url: "https://github.com/nktkas/rews/issues" },
      repository: { type: "git", url: "git+https://github.com/nktkas/rews.git" },
      license: "MIT",
      author: { name: "nktkas", email: "github.turk9@passmail.net", url: "https://github.com/nktkas" },
      sideEffects: false,
      engines: { node: ">=22.12.0" },
    },
    copyFiles: ["README.md", "LICENSE"],
  });
}
