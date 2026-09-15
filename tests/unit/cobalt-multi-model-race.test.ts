import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderCandidate } from "../../open-sse/services/autoCombo/scoring.ts";
import {
  getMultiModelRaceSnapshot,
  isMultiModelRaceBarrier,
  isMultiModelRaceMember,
  isMultiModelRaceStrategy,
  planMultiModelRace,
  recordMultiModelRaceDispatch,
  recordMultiModelRaceFailure,
  recordMultiModelRaceWinner,
  resetMultiModelRace,
  resolveMultiModelRaceWidth,
} from "../../open-sse/services/autoCombo/multiModelRace.ts";
import {
  getAdaptiveLearningSnapshot,
  resetAdaptiveLearning,
} from "../../open-sse/services/autoCombo/adaptiveRouter.ts";
import { resetFreeQuotaIntelligence } from "../../open-sse/services/autoCombo/freeQuotaIntelligence.ts";
import { parseAutoPrefix } from "../../open-sse/services/autoCombo/autoPrefix.ts";

process.env.COBALTROUTE_ADAPTIVE_PERSIST = "0";
process.env.COBALTROUTE_MULTI_MODEL_RACE = "1";
process.env.COBALTROUTE_FREE_QUOTA_INTELLIGENCE = "1";
process.env.COBALTROUTE_FREE_ONLY = "1";

function candidate(
  provider: string,
  model: string,
  options: Partial<ProviderCandidate> = {}
): ProviderCandidate {
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
    accountTier: "free",
    quality: 0.5,
    resetWindowAffinity: 0.5,
    ...options,
  } as ProviderCandidate;
}

function reset() {
  resetMultiModelRace();
  resetAdaptiveLearning();
  resetFreeQuotaIntelligence();
  process.env.COBALTROUTE_MULTI_MODEL_RACE = "1";
  delete process.env.COBALTROUTE_RACE_WIDTH;
}

test("race aliases and auto/race are recognized", () => {
  reset();
  assert.equal(isMultiModelRaceStrategy("race"), true);
  assert.equal(isMultiModelRaceStrategy("cobalt-race"), true);
  assert.equal(isMultiModelRaceStrategy("adaptive-race"), true);
  assert.equal(isMultiModelRaceStrategy("adaptive"), false);
  assert.deepEqual(parseAutoPrefix("auto/race"), { valid: true, variant: "race" });
});

test("coding races up to three distinct providers", () => {
  reset();
  const plan = planMultiModelRace(
    [
      candidate("alpha", "coder-a", { quality: 0.9 }),
      candidate("beta", "coder-b", { quality: 0.8 }),
      candidate("gamma", "coder-c", { quality: 0.7 }),
      candidate("alpha", "coder-d", { quality: 1 }),
    ],
    { taskType: "coding" }
  );

  assert.equal(plan.enabled, true);
  assert.equal(plan.width, 3);
  assert.equal(new Set(plan.candidates.map((entry) => entry.provider)).size, 3);
});

test("routine work defaults to a two-model race", () => {
  reset();
  const plan = planMultiModelRace(
    [
      candidate("alpha", "general-a"),
      candidate("beta", "general-b"),
      candidate("gamma", "general-c"),
    ],
    { taskType: "default" }
  );

  assert.equal(plan.enabled, true);
  assert.equal(plan.width, 2);
});

test("near-exhausted free accounts are kept out when healthy race capacity exists", () => {
  reset();
  const plan = planMultiModelRace(
    [
      candidate("empty", "premium-coder", {
        quotaRemaining: 2,
        quality: 1,
        connectionId: "private-empty-connection",
      }),
      candidate("healthy-a", "coder-a", { quotaRemaining: 70, quality: 0.7 }),
      candidate("healthy-b", "coder-b", { quotaRemaining: 60, quality: 0.7 }),
      candidate("healthy-c", "coder-c", { quotaRemaining: 50, quality: 0.7 }),
    ],
    { taskType: "coding" }
  );

  assert.equal(
    plan.candidates.some((entry) => entry.provider === "empty"),
    false
  );
});

test("race width helpers create one barrier at the end of the parallel group", () => {
  reset();
  assert.equal(resolveMultiModelRaceWidth(3, 5), 3);
  assert.equal(resolveMultiModelRaceWidth(9, 2), 2);
  assert.equal(isMultiModelRaceMember(0, 3), true);
  assert.equal(isMultiModelRaceMember(2, 3), true);
  assert.equal(isMultiModelRaceMember(3, 3), false);
  assert.equal(isMultiModelRaceBarrier(1, 3), false);
  assert.equal(isMultiModelRaceBarrier(2, 3), true);
});

test("race winner becomes positive task-specific adaptive evidence", () => {
  reset();
  const plan = planMultiModelRace([candidate("alpha", "coder-a"), candidate("beta", "coder-b")], {
    taskType: "coding",
    raceWidth: 2,
  });
  assert.ok(plan.planId);

  const winner = plan.candidates[0]!;
  recordMultiModelRaceDispatch(plan.planId, winner.provider, winner.model);
  recordMultiModelRaceWinner(plan.planId, winner.provider, `${winner.provider}/${winner.model}`);

  const learned = getAdaptiveLearningSnapshot("coding").find(
    (entry) => entry.provider === winner.provider && entry.model === winner.model
  );
  assert.ok(learned);
  assert.equal(learned?.observations, 1);
  assert.ok((learned?.rewardMean ?? 0) > 0.7);
});

test("snapshot is aggregate-only and never leaks connection ids or content", () => {
  reset();
  const plan = planMultiModelRace(
    [
      candidate("alpha", "coder-a", { connectionId: "secret-connection-a" }),
      candidate("beta", "coder-b", { connectionId: "secret-connection-b" }),
    ],
    { taskType: "coding", raceWidth: 2 }
  );
  assert.ok(plan.planId);

  recordMultiModelRaceDispatch(plan.planId, "alpha", "alpha/coder-a");
  recordMultiModelRaceFailure(plan.planId, "alpha", "alpha/coder-a");
  const snapshot = getMultiModelRaceSnapshot();
  const serialized = JSON.stringify(snapshot);

  assert.equal(serialized.includes("secret-connection"), false);
  assert.equal(serialized.includes("prompt"), false);
  assert.equal(serialized.includes("response"), false);
});

test("kill switch disables race planning", () => {
  reset();
  process.env.COBALTROUTE_MULTI_MODEL_RACE = "0";
  const plan = planMultiModelRace([candidate("alpha", "coder-a"), candidate("beta", "coder-b")], {
    taskType: "coding",
  });
  assert.equal(plan.enabled, false);
  assert.equal(plan.planId, null);
});
