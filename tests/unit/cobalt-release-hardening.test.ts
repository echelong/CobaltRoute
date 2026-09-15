import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("CobaltRoute README is product-first while preserving upstream attribution", () => {
  const readme = read("README.md");
  const upstream = read("UPSTREAM_README.md");

  assert.equal(readme.startsWith("# CobaltRoute"), true);
  assert.match(readme, /Built by Cobalt\./);
  assert.match(readme, /independent fork of \[OmniRoute\]/);
  assert.match(readme, /UPSTREAM_README\.md/);
  assert.match(upstream, /OmniRoute/);
});

test("V9 keeps upstream package identity intentionally for runtime compatibility", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    name?: string;
    version?: string;
    bin?: Record<string, string>;
  };

  assert.equal(packageJson.name, "omniroute");
  assert.equal(packageJson.version, "3.8.51");
  assert.equal(typeof packageJson.bin?.omniroute, "string");
});

test("recommended CobaltRoute preset enables V1-V8 policy layers without secrets", () => {
  const preset = read("config/cobalt/cobaltroute.env.example");
  const expected = [
    "COBALTROUTE_FREE_ONLY=1",
    "COBALTROUTE_ADAPTIVE_PERSIST=1",
    "COBALTROUTE_FREE_QUOTA_INTELLIGENCE=1",
    "COBALTROUTE_MULTI_MODEL_RACE=1",
    "COBALTROUTE_FREE_MODEL_DISCOVERY=1",
    "COBALTROUTE_PROTOCOL_COMPATIBILITY=1",
    "COBALTROUTE_HYBRID_LOCAL_CLOUD=1",
    "COBALTROUTE_HYBRID_POLICY=balanced",
  ];

  for (const flag of expected) assert.match(preset, new RegExp(flag));

  const activeLines = preset
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
  assert.equal(
    activeLines.some((line) => /(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION)\s*=\s*\S+/i.test(line)),
    false
  );
});

test("release audit passes the checked-out CobaltRoute release invariants", () => {
  const result = spawnSync(process.execPath, ["scripts/cobalt/release-audit.mjs"], {
    encoding: "utf8",
    env: process.env,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /RELEASE AUDIT PASS/);
});

test("deterministic benchmark is explicitly network-free and policy-scoped", () => {
  const benchmark = read("scripts/cobalt/benchmark-routing.ts");
  assert.match(benchmark, /No external LLM calls are made/);
  assert.match(benchmark, /routing-policy benchmark/);
  assert.match(benchmark, /selectWithStrategy/);
  assert.equal(/fetch\s*\(/.test(benchmark), false);
});
