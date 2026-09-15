import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderCandidate } from "../../open-sse/services/autoCombo/scoring.ts";
import {
  getAdaptiveLearningSnapshot,
  recordAdaptiveOutcome,
  resetAdaptiveLearning,
  selectAdaptiveCandidate,
} from "../../open-sse/services/autoCombo/adaptiveRouter.ts";
import {
  getStrategy,
  listStrategies,
} from "../../open-sse/services/autoCombo/routerStrategy.ts";

process.env.COBALTROUTE_ADAPTIVE_PERSIST = "0";

function cand(p: Partial<ProviderCandidate> & { provider: string; model?: string }): ProviderCandidate {
  return {
    provider: p.provider,
    model: p.model ?? `${p.provider}/model`,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 0,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
    quality: 0.5,
    ...p,
  } as ProviderCandidate;
}

function rewardMany(
  taskType: string,
  candidate: ProviderCandidate,
  reward: number,
  count = 16
): void {
  for (let index = 0; index < count; index += 1) {
    recordAdaptiveOutcome({
      taskType,
      provider: candidate.provider,
      model: candidate.model,
      reward,
    });
  }
}

test("adaptive strategy is registered with cobalt alias", () => {
  assert.equal(getStrategy("adaptive").name, "adaptive");
  assert.equal(getStrategy("cobalt").name, "adaptive");
  const names = listStrategies().map((entry) => entry.name);
  assert.ok(names.includes("adaptive"));
  assert.ok(names.includes("cobalt"));
});

test("adaptive routing is free-first when an explicitly free candidate exists", () => {
  resetAdaptiveLearning();
  const free = cand({ provider: "free", costPer1MTokens: 0, quality: 0.4 });
  const paid = cand({
    provider: "paid",
    costPer1MTokens: 0.01,
    accountTier: "pro",
    quality: 1,
    p95LatencyMs: 1,
  });

  const selected = selectAdaptiveCandidate([paid, free], {
    taskType: "coding",
    explorationRate: 0,
  });

  assert.equal(selected.provider, "free");
  assert.match(selected.reason, /free=yes/);
});

test("real task outcomes can overturn a cold-start tie", () => {
  resetAdaptiveLearning();
  const a = cand({ provider: "a", model: "shared-a" });
  const b = cand({ provider: "b", model: "shared-b" });

  rewardMany("coding", a, 0.05);
  rewardMany("coding", b, 0.95);

  const selected = selectAdaptiveCandidate([a, b], {
    taskType: "coding",
    explorationRate: 0,
  });

  assert.equal(selected.provider, "b");
  assert.match(selected.reason, /task=coding/);
  assert.match(selected.reason, /outcomes=16/);
});

test("learning is task-specific instead of one global model score", () => {
  resetAdaptiveLearning();
  const a = cand({ provider: "a", model: "model-a" });
  const b = cand({ provider: "b", model: "model-b" });

  rewardMany("coding", a, 0.05);
  rewardMany("coding", b, 0.95);
  rewardMany("writing", a, 0.95);
  rewardMany("writing", b, 0.05);

  const coding = selectAdaptiveCandidate([a, b], {
    taskType: "coding",
    explorationRate: 0,
  });
  const writing = selectAdaptiveCandidate([a, b], {
    taskType: "writing",
    explorationRate: 0,
  });

  assert.equal(coding.provider, "b");
  assert.equal(writing.provider, "a");
});

test("adaptive routing avoids OPEN circuit breakers", () => {
  resetAdaptiveLearning();
  const blocked = cand({
    provider: "blocked",
    circuitBreakerState: "OPEN",
    quality: 1,
  });
  const healthy = cand({ provider: "healthy", quality: 0.2 });

  const selected = selectAdaptiveCandidate([blocked, healthy], {
    taskType: "default",
    explorationRate: 0,
  });

  assert.equal(selected.provider, "healthy");
});

test("adaptive routing preserves the winning connection id", () => {
  resetAdaptiveLearning();
  const slow = cand({
    provider: "shared",
    model: "same-model",
    connectionId: "conn-slow",
    p95LatencyMs: 5_000,
    quality: 0.1,
  });
  const fast = cand({
    provider: "shared",
    model: "same-model",
    connectionId: "conn-fast",
    p95LatencyMs: 50,
    quality: 0.9,
  });

  const selected = selectAdaptiveCandidate([slow, fast], {
    taskType: "default",
    explorationRate: 0,
  });

  assert.equal(selected.connectionId, "conn-fast");
});

test("adaptive snapshot exposes aggregate learning only", () => {
  resetAdaptiveLearning();
  const model = cand({ provider: "provider-x", model: "model-x" });
  recordAdaptiveOutcome({
    taskType: "coding",
    provider: model.provider,
    model: model.model,
    reward: 1,
  });

  const snapshot = getAdaptiveLearningSnapshot("coding");
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.taskType, "coding");
  assert.equal(snapshot[0]?.provider, "provider-x");
  assert.equal(snapshot[0]?.model, "model-x");
  assert.equal(snapshot[0]?.observations, 1);
  assert.equal(snapshot[0]?.rewardMean, 1);
  assert.equal("prompt" in (snapshot[0] as unknown as Record<string, unknown>), false);
  assert.equal("response" in (snapshot[0] as unknown as Record<string, unknown>), false);
});
