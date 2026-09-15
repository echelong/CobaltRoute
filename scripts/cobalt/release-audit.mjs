#!/usr/bin/env node
/**
 * CobaltRoute release invariant audit.
 *
 * This is intentionally network-free. It verifies the fork-specific release
 * contract before a merge/tag without mutating the working tree.
 *
 * Built by Cobalt.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
let failures = 0;
let checks = 0;

function absolute(relativePath) {
  return path.join(root, relativePath);
}

function read(relativePath) {
  return fs.readFileSync(absolute(relativePath), "utf8");
}

function check(condition, label, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
    return;
  }
  failures += 1;
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

function exists(relativePath) {
  return fs.existsSync(absolute(relativePath));
}

console.log("============================================================");
console.log(" COBALTROUTE — RELEASE AUDIT");
console.log(" Built by Cobalt.");
console.log("============================================================");
console.log();

const requiredFiles = [
  "README.md",
  "UPSTREAM_README.md",
  "docs/cobalt/RELEASE_HARDENING.md",
  "config/cobalt/cobaltroute.env.example",
  "scripts/cobalt/benchmark-routing.ts",
  "scripts/cobalt/release-audit.mjs",
  "open-sse/services/autoCombo/adaptiveRouter.ts",
  "open-sse/services/autoCombo/codingFeedback.ts",
  "open-sse/services/autoCombo/freeQuotaIntelligence.ts",
  "open-sse/services/autoCombo/multiModelRace.ts",
  "src/lib/discovery/freeModelQualification.ts",
  "open-sse/services/autoCombo/protocolCompatibility.ts",
  "open-sse/services/autoCombo/hybridLocalCloud.ts",
  "src/app/(dashboard)/dashboard/router-brain/page.tsx",
  "tests/unit/cobalt-adaptive-router.test.ts",
  "tests/unit/cobalt-coding-feedback.test.ts",
  "tests/unit/cobalt-free-quota-intelligence.test.ts",
  "tests/unit/cobalt-multi-model-race.test.ts",
  "tests/unit/cobalt-free-model-discovery.test.ts",
  "tests/unit/cobalt-protocol-compatibility.test.ts",
  "tests/unit/cobalt-hybrid-local-cloud.test.ts",
  "tests/unit/cobalt-release-hardening.test.ts",
];

for (const requiredFile of requiredFiles) {
  check(exists(requiredFile), `required file: ${requiredFile}`);
}

if (exists("README.md")) {
  const readme = read("README.md");
  check(readme.startsWith("# CobaltRoute"), "README is CobaltRoute-first");
  check(readme.includes("Built by Cobalt."), "README carries Cobalt signature");
  check(readme.includes("UPSTREAM_README.md"), "README links preserved upstream documentation");
  check(
    readme.includes("independent fork") && readme.includes("OmniRoute"),
    "README states upstream lineage"
  );
}

if (exists("UPSTREAM_README.md")) {
  const upstreamReadme = read("UPSTREAM_README.md");
  check(upstreamReadme.includes("OmniRoute"), "upstream README snapshot preserved");
}

if (exists("docs/cobalt/RELEASE_HARDENING.md")) {
  const releaseDoc = read("docs/cobalt/RELEASE_HARDENING.md");
  check(releaseDoc.includes("balanced-free"), "release docs include balanced-free preset");
  check(releaseDoc.includes("local-first"), "release docs include local-first preset");
  check(releaseDoc.includes("cloud-quality"), "release docs include cloud-quality preset");
  check(releaseDoc.includes("Built by Cobalt."), "release docs carry Cobalt signature");
}

if (exists("config/cobalt/cobaltroute.env.example")) {
  const preset = read("config/cobalt/cobaltroute.env.example");
  const requiredFlags = [
    "COBALTROUTE_FREE_ONLY=1",
    "COBALTROUTE_ADAPTIVE_PERSIST=1",
    "COBALTROUTE_FREE_QUOTA_INTELLIGENCE=1",
    "COBALTROUTE_MULTI_MODEL_RACE=1",
    "COBALTROUTE_FREE_MODEL_DISCOVERY=1",
    "COBALTROUTE_PROTOCOL_COMPATIBILITY=1",
    "COBALTROUTE_HYBRID_LOCAL_CLOUD=1",
    "COBALTROUTE_HYBRID_POLICY=balanced",
  ];
  for (const flag of requiredFlags) {
    check(preset.includes(flag), `production preset contains ${flag}`);
  }

  const activeSecretAssignment = preset
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .some((line) => /(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION)\s*=\s*\S+/i.test(line));
  check(!activeSecretAssignment, "production preset contains no active secret assignments");
}

if (exists("package.json")) {
  const packageJson = JSON.parse(read("package.json"));
  check(packageJson.name === "omniroute", "upstream package identity intentionally preserved", packageJson.name);
  check(packageJson.version === "3.8.51", "fork base version remains explicit", packageJson.version);
}

let trackedFiles = [];
try {
  trackedFiles = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split(/\r?\n/)
    .filter(Boolean);
} catch (error) {
  failures += 1;
  console.error(`✗ unable to inspect tracked files: ${error instanceof Error ? error.message : error}`);
}

const forbidden = new Set(["AGENTS.md", "CLAUDE.md"]);
for (const name of forbidden) {
  check(!trackedFiles.includes(name), `${name} is not tracked`);
}

const cobaltFiles = trackedFiles.filter(
  (file) =>
    file.startsWith("scripts/cobalt/") ||
    file.startsWith("docs/cobalt/") ||
    file.startsWith("config/cobalt/")
);
check(cobaltFiles.length >= 4, "Cobalt release surface is tracked", `${cobaltFiles.length} files`);

console.log();
console.log("============================================================");
if (failures === 0) {
  console.log(` RELEASE AUDIT PASS — ${checks}/${checks} checks green`);
  console.log(" CobaltRoute release invariants satisfied.");
} else {
  console.error(` RELEASE AUDIT FAIL — ${failures} of ${checks} checks failed`);
  process.exitCode = 1;
}
console.log("============================================================");
