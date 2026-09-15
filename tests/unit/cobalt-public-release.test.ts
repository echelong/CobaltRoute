import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const release = JSON.parse(fs.readFileSync("cobaltroute.release.json", "utf8"));

test("CobaltRoute v1.0.0 has an independent product identity", () => {
  assert.equal(release.product, "CobaltRoute");
  assert.equal(release.productVersion, "1.0.0");
  assert.equal(release.releaseTag, "cobaltroute-v1.0.0");
  assert.equal(release.builtBy, "Cobalt");
});

test("upstream OmniRoute package identity remains compatible", () => {
  assert.equal(pkg.name, "omniroute");
  assert.equal(pkg.version, "3.8.51");
  assert.equal(release.upstream.package, "omniroute");
  assert.equal(release.upstream.runtimeVersion, "3.8.51");
});

test("CobaltRoute CLI aliases the inherited runtime safely", () => {
  assert.equal(pkg.bin.cobaltroute, "bin/cobaltroute.mjs");
  assert.equal(pkg.bin.omniroute, "bin/omniroute.mjs");
  assert.equal(lock.packages[""].bin.cobaltroute, "bin/cobaltroute.mjs");
});

test("CobaltRoute release files are part of package configuration", () => {
  const required = [
    "UPSTREAM_README.md",
    "cobaltroute.release.json",
    "config/cobalt/",
    "docs/cobalt/",
    "scripts/cobalt/",
  ];

  for (const entry of required) {
    assert.equal(pkg.files.includes(entry), true, entry);
  }
});

test("CobaltRoute public-release surface exists", () => {
  const required = [
    "bin/cobaltroute.mjs",
    "cobaltroute.release.json",
    "docs/cobalt/RELEASE_NOTES_v1.0.0.md",
    "scripts/cobalt/public-release-audit.mjs",
  ];

  for (const entry of required) {
    assert.equal(fs.existsSync(entry), true, entry);
  }
});
