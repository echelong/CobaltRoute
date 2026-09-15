import test from "node:test";
import assert from "node:assert/strict";
import {
  filterFreeModelQualificationPool,
  getFreeModelDiscoverySnapshot,
  getFreeModelQualificationState,
  isKnownCatalogFreeModel,
  recordFreeModelQualificationOutcome,
  registerDiscoveredFreeModel,
  registerSyncedFreeModels,
  resetFreeModelDiscovery,
} from "../../src/lib/discovery/freeModelQualification.ts";
import { FREE_MODEL_BUDGETS, grantsFreeAccess } from "../../open-sse/config/freeModelCatalog.ts";

process.env.COBALTROUTE_DISCOVERY_PERSIST = "0";
process.env.COBALTROUTE_FREE_MODEL_DISCOVERY = "1";
process.env.COBALTROUTE_DISCOVERY_QUALIFY_SUCCESSES = "2";
process.env.COBALTROUTE_DISCOVERY_QUARANTINE_FAILURES = "2";

function candidate(provider: string, model: string) {
  return {
    provider,
    model,
    costPer1MTokens: 0,
    accountTier: "free",
  };
}

function reset() {
  resetFreeModelDiscovery();
}

test("release-catalog free models are trusted without probation", () => {
  reset();
  const known = FREE_MODEL_BUDGETS.find((entry) => grantsFreeAccess(entry.freeType));
  assert.ok(known);
  assert.equal(isKnownCatalogFreeModel(known.provider, known.modelId), true);
  assert.equal(getFreeModelQualificationState(known.provider, known.modelId), "trusted");
  assert.equal(getFreeModelDiscoverySnapshot().summary.modelCount, 0);
});

test("model sync automatically registers novel explicit-free models as probation", () => {
  reset();
  const count = registerSyncedFreeModels("cobalt-v6-sync", [
    { id: "new-free-model", isFree: true },
    { id: "paid-model", isFree: false },
  ]);
  assert.equal(count, 1);
  assert.equal(getFreeModelQualificationState("cobalt-v6-sync", "new-free-model"), "probation");
});

test("normal adaptive admission holds probation behind a qualified alternative", () => {
  reset();
  const qualified = candidate("cobalt-qualified", "stable-free");
  const probation = candidate("cobalt-probation", "new-free");

  registerDiscoveredFreeModel(probation.provider, probation.model, "test-discovery");

  recordFreeModelQualificationOutcome({
    provider: qualified.provider,
    model: qualified.model,
    outcome: "success",
  });
  recordFreeModelQualificationOutcome({
    provider: qualified.provider,
    model: qualified.model,
    outcome: "success",
  });

  const filtered = filterFreeModelQualificationPool([qualified, probation]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].provider, qualified.provider);
  assert.equal(getFreeModelQualificationState(probation.provider, probation.model), "probation");
});

test("race admission may trial at most one probation model beside trusted capacity", () => {
  reset();
  const known = FREE_MODEL_BUDGETS.find((entry) => grantsFreeAccess(entry.freeType));
  assert.ok(known);
  const trusted = candidate(known.provider, known.modelId);
  const probationA = candidate("cobalt-probation-a", "new-a");
  const probationB = candidate("cobalt-probation-b", "new-b");

  registerDiscoveredFreeModel(probationA.provider, probationA.model, "test-discovery");
  registerDiscoveredFreeModel(probationB.provider, probationB.model, "test-discovery");

  const filtered = filterFreeModelQualificationPool([trusted, probationA, probationB], {
    allowProbation: true,
    maxProbation: 1,
  });
  assert.equal(filtered.length, 2);
  assert.ok(filtered.some((entry) => entry.provider === trusted.provider));
  assert.equal(filtered.filter((entry) => entry.provider.startsWith("cobalt-probation")).length, 1);
});

test("untracked runtime free candidates preserve pre-v6 routing", () => {
  reset();

  const alpha = candidate("legacy-alpha", "free-a");
  const beta = candidate("legacy-beta", "free-b");

  const filtered = filterFreeModelQualificationPool([alpha, beta]);

  assert.equal(filtered.length, 2);
  assert.equal(getFreeModelQualificationState(alpha.provider, alpha.model), "unknown");
  assert.equal(getFreeModelQualificationState(beta.provider, beta.model), "unknown");
});

test("two verified successes promote a novel free model", () => {
  reset();
  const provider = "cobalt-promote";
  const model = "new-free";

  recordFreeModelQualificationOutcome({ provider, model, outcome: "success" });
  assert.equal(getFreeModelQualificationState(provider, model), "probation");
  recordFreeModelQualificationOutcome({ provider, model, outcome: "success" });
  assert.equal(getFreeModelQualificationState(provider, model), "qualified");
});

test("repeated quality failures quarantine but operational failures do not", () => {
  reset();
  const operationalProvider = "cobalt-operational";
  const qualityProvider = "cobalt-quality";
  const model = "new-free";

  recordFreeModelQualificationOutcome({
    provider: operationalProvider,
    model,
    outcome: "operational_failure",
    reason: "429 quota exhausted",
  });
  recordFreeModelQualificationOutcome({
    provider: operationalProvider,
    model,
    outcome: "operational_failure",
    reason: "network timeout",
  });
  assert.equal(getFreeModelQualificationState(operationalProvider, model), "probation");

  recordFreeModelQualificationOutcome({
    provider: qualityProvider,
    model,
    outcome: "quality_failure",
    reason: "malformed tool call",
  });
  recordFreeModelQualificationOutcome({
    provider: qualityProvider,
    model,
    outcome: "quality_failure",
    reason: "invalid schema",
  });
  assert.equal(getFreeModelQualificationState(qualityProvider, model), "quarantined");
});

test("discovery snapshot is aggregate-only", () => {
  reset();
  recordFreeModelQualificationOutcome({
    provider: "cobalt-private",
    model: "new-free",
    outcome: "success",
    reason: "validated combo success",
  });
  const serialized = JSON.stringify(getFreeModelDiscoverySnapshot());
  assert.equal(serialized.includes("connectionId"), false);
  assert.equal(serialized.includes("prompt"), false);
  assert.equal(serialized.includes("response"), false);
  assert.equal(serialized.includes("credential"), false);
});
