#!/usr/bin/env node

/**
 * CobaltRoute public-release packaging audit.
 *
 * Network-free. Verifies that CobaltRoute product identity and release files
 * survive npm packaging while the inherited OmniRoute runtime identity remains
 * intact.
 *
 * Built by Cobalt.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";

let failures = 0;
let checks = 0;

function check(condition, message) {
  checks += 1;

  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    failures += 1;
    console.log(`✗ ${message}`);
  }
}

console.log("============================================================");
console.log(" COBALTROUTE — PUBLIC RELEASE AUDIT");
console.log(" Built by Cobalt.");
console.log("============================================================");
console.log();

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const release = JSON.parse(fs.readFileSync("cobaltroute.release.json", "utf8"));

check(pkg.name === "omniroute", "upstream npm package identity preserved");
check(pkg.version === "3.8.51", "upstream runtime version remains 3.8.51");

check(release.product === "CobaltRoute", "release manifest identifies CobaltRoute");

check(release.productVersion === "1.0.0", "CobaltRoute product version is 1.0.0");

check(release.releaseTag === "cobaltroute-v1.0.0", "release tag is cobaltroute-v1.0.0");

check(
  release.upstream?.runtimeVersion === "3.8.51",
  "release manifest records OmniRoute 3.8.51 runtime"
);

check(pkg.bin?.cobaltroute === "bin/cobaltroute.mjs", "package exposes cobaltroute CLI");

check(pkg.bin?.omniroute === "bin/omniroute.mjs", "legacy omniroute CLI remains available");

check(
  lock.packages?.[""]?.bin?.cobaltroute === "bin/cobaltroute.mjs",
  "package-lock contains cobaltroute CLI"
);

const requiredPackageEntries = [
  "UPSTREAM_README.md",
  "cobaltroute.release.json",
  "config/cobalt/",
  "docs/cobalt/",
  "scripts/cobalt/",
];

for (const entry of requiredPackageEntries) {
  check(Array.isArray(pkg.files) && pkg.files.includes(entry), `package files include ${entry}`);
}

check(fs.existsSync("bin/cobaltroute.mjs"), "CobaltRoute CLI wrapper exists");

check(
  fs.existsSync("docs/cobalt/RELEASE_NOTES_v1.0.0.md"),
  "CobaltRoute v1.0.0 release notes exist"
);

const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  env: {
    ...process.env,
    DISABLE_SQLITE_AUTO_BACKUP: "true",
  },
});

check(pack.status === 0, "npm pack dry run succeeds");

let packedFiles = [];

if (pack.status === 0) {
  try {
    const result = JSON.parse(pack.stdout);
    packedFiles = (result[0]?.files || []).map((entry) => entry.path);
  } catch {
    failures += 1;
    console.log("✗ npm pack JSON output is parseable");
  }
}

const requiredPackedFiles = [
  "README.md",
  "UPSTREAM_README.md",
  "cobaltroute.release.json",
  "config/cobalt/cobaltroute.env.example",
  "docs/cobalt/RELEASE_HARDENING.md",
  "docs/cobalt/RELEASE_NOTES_v1.0.0.md",
  "scripts/cobalt/release-audit.mjs",
  "scripts/cobalt/public-release-audit.mjs",
  "scripts/cobalt/benchmark-routing.ts",
  "bin/cobaltroute.mjs",
];

for (const entry of requiredPackedFiles) {
  check(packedFiles.includes(entry), `npm package contains ${entry}`);
}

console.log();
console.log("============================================================");

if (failures === 0) {
  console.log(` PUBLIC RELEASE AUDIT PASS — ${checks}/${checks} checks green`);
  console.log(" CobaltRoute v1.0.0 packaging invariants satisfied.");
} else {
  console.log(` PUBLIC RELEASE AUDIT FAIL — ${failures} of ${checks} checks failed`);
}

console.log("============================================================");

process.exitCode = failures === 0 ? 0 : 1;
