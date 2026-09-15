#!/usr/bin/env node

/**
 * CobaltRoute CLI entry point.
 *
 * CobaltRoute v1.0.0 wraps the inherited OmniRoute 3.8.51 runtime without
 * renaming or duplicating that runtime. Existing `omniroute` commands remain
 * fully compatible while new installations may also invoke `cobaltroute`.
 *
 * Built by Cobalt.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const root = join(currentDir, "..");

const release = JSON.parse(readFileSync(join(root, "cobaltroute.release.json"), "utf8"));

const args = process.argv.slice(2);

const versionOnly = args.length === 1 && (args[0] === "--version" || args[0] === "-V");

if (versionOnly) {
  console.log(
    `CobaltRoute ${release.productVersion} ` +
      `(OmniRoute runtime ${release.upstream.runtimeVersion})`
  );
} else {
  await import("./omniroute.mjs");
}
