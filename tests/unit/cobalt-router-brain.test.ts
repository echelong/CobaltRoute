import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderCandidate } from "../../open-sse/services/autoCombo/scoring.ts";
import {
  getAdaptiveBrainSnapshot,
  getAdaptiveLearningSnapshot,
  resetAdaptiveLearning,
  selectAdaptiveCandidate,
} from "../../open-sse/services/autoCombo/adaptiveRouter.ts";
import { emit } from "../../src/lib/events/eventBus.ts";

process.env.COBALTROUTE_ADAPTIVE_PERSIST = "0";
process.env.COBALTROUTE_AUTOMATIC_FEEDBACK = "1";

function candidate(provider: string, model = `${provider}/model`): ProviderCandidate {
  return {
    provider,
    model,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 0,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
    quality: 0.5,
  } as ProviderCandidate;
}

test("Router Brain learns automatically from a successful adaptive request", () => {
  resetAdaptiveLearning();
  const model = candidate("free-provider", "free-provider/model-a");

  selectAdaptiveCandidate([model], { taskType: "coding", explorationRate: 0 });
  emit("combo.target.succeeded", {
    comboName: "auto",
    targetIndex: 0,
    provider: "free-provider",
    model: "free-provider/model-a",
    latencyMs: 250,
  });

  const entries = getAdaptiveLearningSnapshot("coding");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.observations, 1);
  assert.equal(entries[0]?.rewardMean, 0.7);
  assert.equal(entries[0]?.negativeOutcomes, 0);
});

test("quality rejection becomes a strong negative adaptive outcome", () => {
  resetAdaptiveLearning();
  const model = candidate("free-provider", "free-provider/model-b");

  selectAdaptiveCandidate([model], { taskType: "analysis", explorationRate: 0 });
  emit("combo.target.failed", {
    comboName: "auto",
    targetIndex: 0,
    provider: "free-provider",
    model: "free-provider/model-b",
    error: "Quality: empty response failed validation",
    latencyMs: 300,
  });

  const entry = getAdaptiveLearningSnapshot("analysis")[0];
  assert.ok(entry);
  assert.equal(entry.observations, 1);
  assert.equal(entry.rewardMean, 0.08);
  assert.equal(entry.negativeOutcomes, 1);
});

test("quota failures stay near-neutral instead of poisoning task intelligence", () => {
  resetAdaptiveLearning();
  const model = candidate("free-provider", "free-provider/model-c");

  selectAdaptiveCandidate([model], { taskType: "coding", explorationRate: 0 });
  emit("combo.target.failed", {
    comboName: "auto",
    targetIndex: 0,
    provider: "free-provider",
    model: "free-provider/model-c",
    error: "429 quota exhausted; provider unavailable until reset",
    latencyMs: 100,
  });

  const entry = getAdaptiveLearningSnapshot("coding")[0];
  assert.ok(entry);
  assert.equal(entry.observations, 1);
  assert.equal(entry.rewardMean, 0.48);
  assert.equal(entry.negativeOutcomes, 0);
});

test("Router Brain snapshot aggregates task and model leaders", () => {
  resetAdaptiveLearning();
  const coding = candidate("provider-a", "provider-a/code-model");
  const writing = candidate("provider-b", "provider-b/write-model");

  selectAdaptiveCandidate([coding], { taskType: "coding", explorationRate: 0 });
  emit("combo.target.succeeded", {
    comboName: "auto",
    targetIndex: 0,
    provider: "provider-a",
    model: "provider-a/code-model",
    latencyMs: 100,
  });

  selectAdaptiveCandidate([writing], { taskType: "writing", explorationRate: 0 });
  emit("combo.target.succeeded", {
    comboName: "auto",
    targetIndex: 0,
    provider: "provider-b",
    model: "provider-b/write-model",
    latencyMs: 100,
  });

  const brain = getAdaptiveBrainSnapshot();
  assert.equal(brain.summary.taskCount, 2);
  assert.equal(brain.summary.modelCount, 2);
  assert.equal(brain.summary.providerCount, 2);
  assert.equal(brain.summary.selections, 2);
  assert.equal(brain.summary.observations, 2);
  assert.equal(brain.tasks.length, 2);
  assert.ok(brain.tasks.every((task) => task.leader !== null));
});
