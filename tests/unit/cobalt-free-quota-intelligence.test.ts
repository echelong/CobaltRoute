import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderCandidate } from "../../open-sse/services/autoCombo/scoring.ts";
import {
  getFreeQuotaIntelligenceSnapshot,
  resetFreeQuotaIntelligence,
  scoreFreeQuotaCandidate,
  selectQuotaAwareAdaptiveCandidate,
} from "../../open-sse/services/autoCombo/freeQuotaIntelligence.ts";
import { resetAdaptiveLearning } from "../../open-sse/services/autoCombo/adaptiveRouter.ts";

process.env.COBALTROUTE_ADAPTIVE_PERSIST = "0";
process.env.COBALTROUTE_FREE_QUOTA_INTELLIGENCE = "1";

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
  resetAdaptiveLearning();
  resetFreeQuotaIntelligence();
}

test("quota inventory rewards remaining allowance and approaching reset windows", () => {
  reset();
  const abundantSoon = candidate("free-a", "model-a", {
    quotaRemaining: 80,
    resetWindowAffinity: 0.9,
  });
  const scarceLater = candidate("free-b", "model-b", {
    quotaRemaining: 15,
    resetWindowAffinity: 0.1,
  });

  const a = scoreFreeQuotaCandidate(abundantSoon, { taskType: "default" });
  const b = scoreFreeQuotaCandidate(scarceLater, { taskType: "default" });

  assert.ok(a.inventoryScore > b.inventoryScore);
  assert.ok(a.expiringOpportunity > b.expiringOpportunity);
});

test("routine work protects scarce free inventory when a healthy alternative exists", () => {
  reset();
  const scarce = candidate("free-a", "deepseek-coder", {
    quotaRemaining: 8,
    quality: 1,
    resetWindowAffinity: 0.1,
    connectionId: "scarce-account",
  });
  const abundant = candidate("free-b", "general-model", {
    quotaRemaining: 85,
    quality: 0.55,
    resetWindowAffinity: 0.8,
    connectionId: "abundant-account",
  });

  const selected = selectQuotaAwareAdaptiveCandidate([scarce, abundant], {
    taskType: "default",
    explorationRate: 0,
  });

  assert.equal(selected.provider, "free-b");
  assert.equal(selected.connectionId, "abundant-account");

  const snapshot = getFreeQuotaIntelligenceSnapshot();
  assert.equal(snapshot.summary.selections, 1);
  assert.ok(snapshot.summary.protectedEvaluations >= 1);
});

test("near-exhausted free accounts are avoided before the hard quota cutoff", () => {
  reset();
  const nearlyEmpty = candidate("free-a", "model-a", {
    quotaRemaining: 2,
    quality: 1,
    connectionId: "almost-empty",
  });
  const healthy = candidate("free-b", "model-b", {
    quotaRemaining: 40,
    quality: 0.4,
    connectionId: "healthy",
  });

  const selected = selectQuotaAwareAdaptiveCandidate([nearlyEmpty, healthy], {
    taskType: "coding",
    explorationRate: 0,
  });

  assert.equal(selected.connectionId, "healthy");
});

test("quota intelligence remains neutral for paid-only pools", () => {
  reset();
  const paid = candidate("paid", "paid-model", {
    accountTier: "pro",
    costPer1MTokens: 2,
    quotaRemaining: 5,
  });

  const assessment = scoreFreeQuotaCandidate(paid, { taskType: "default" });
  assert.equal(assessment.free, false);
  assert.equal(assessment.inventoryScore, 0.5);

  const selected = selectQuotaAwareAdaptiveCandidate([paid], {
    taskType: "default",
    explorationRate: 0,
  });
  assert.equal(selected.provider, "paid");
});

test("Router Brain quota snapshot is aggregate-only and never exposes connection ids", () => {
  reset();
  const a = candidate("free-a", "model-a", {
    quotaRemaining: 55,
    resetWindowAffinity: 0.9,
    connectionId: "secret-connection-a",
  });
  const b = candidate("free-b", "model-b", {
    quotaRemaining: 70,
    resetWindowAffinity: 0.2,
    connectionId: "secret-connection-b",
  });

  selectQuotaAwareAdaptiveCandidate([a, b], {
    taskType: "documentation",
    explorationRate: 0,
  });

  const snapshot = getFreeQuotaIntelligenceSnapshot();
  const serialized = JSON.stringify(snapshot);
  assert.ok(snapshot.summary.evaluations >= 2);
  assert.equal(serialized.includes("connectionId"), false);
  assert.equal(serialized.includes("secret-connection"), false);
});
