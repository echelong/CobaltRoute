import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderCandidate } from "../../open-sse/services/autoCombo/scoring.ts";
import { parseAutoPrefix } from "../../open-sse/services/autoCombo/autoPrefix.ts";
import { resolveBuiltinAutoSpec } from "../../open-sse/services/autoCombo/builtinCatalog.ts";
import {
  getHybridLocalCloudSnapshot,
  isHybridLocalProvider,
  resetHybridLocalCloud,
  resolveHybridRoutingPolicy,
  selectHybridLocalCloudCandidate,
} from "../../open-sse/services/autoCombo/hybridLocalCloud.ts";
import { resetAdaptiveLearning } from "../../open-sse/services/autoCombo/adaptiveRouter.ts";
import { resetFreeQuotaIntelligence } from "../../open-sse/services/autoCombo/freeQuotaIntelligence.ts";

process.env.COBALTROUTE_ADAPTIVE_PERSIST = "0";
process.env.COBALTROUTE_DISCOVERY_PERSIST = "0";
process.env.COBALTROUTE_FREE_QUOTA_INTELLIGENCE = "1";
process.env.COBALTROUTE_HYBRID_LOCAL_CLOUD = "1";
process.env.COBALTROUTE_HYBRID_POLICY = "balanced";

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
    p95LatencyMs: 300,
    latencyStdDev: 20,
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
  resetHybridLocalCloud();
  process.env.COBALTROUTE_HYBRID_LOCAL_CLOUD = "1";
  process.env.COBALTROUTE_HYBRID_POLICY = "balanced";
  delete process.env.COBALTROUTE_LOCAL_PROVIDER_IDS;
  delete process.env.COBALTROUTE_FREE_ONLY;
}

test("auto/hybrid is a recognized built-in CobaltRoute variant", () => {
  reset();
  assert.deepEqual(parseAutoPrefix("auto/hybrid"), { valid: true, variant: "hybrid" });
  assert.deepEqual(resolveBuiltinAutoSpec("auto/hybrid", "hybrid"), { variant: "hybrid" });
});

test("recognizes registered local providers and explicit custom local provider ids", () => {
  reset();
  assert.equal(isHybridLocalProvider("ollama-local"), true);
  assert.equal(isHybridLocalProvider("groq"), false);

  process.env.COBALTROUTE_LOCAL_PROVIDER_IDS = "openai-compatible-home, my-lan-model";
  assert.equal(isHybridLocalProvider("openai-compatible-home"), true);
  assert.equal(isHybridLocalProvider("MY-LAN-MODEL"), true);
});

test("balanced routine work prefers a competitive local model over cloud", () => {
  reset();
  const local = candidate("ollama-local", "shared-model", {
    connectionId: "local-secret",
  });
  const cloud = candidate("groq", "shared-model", {
    connectionId: "cloud-secret",
  });

  const selected = selectHybridLocalCloudCandidate([cloud, local], {
    taskType: "documentation",
    explorationRate: 0,
  });

  assert.equal(selected.provider, "ollama-local");
  assert.equal(selected.locality, "local");
  assert.equal(selected.policy, "balanced");
  assert.match(selected.reason, /Hybrid\(balanced local/);
});

test("global free-first policy is preserved before choosing local versus cloud", () => {
  reset();
  const freeLocal = candidate("ollama-local", "free-local", {
    quality: 0.25,
    p95LatencyMs: 1500,
  });
  const paidCloud = candidate("premium-cloud", "paid-cloud", {
    accountTier: "pro",
    costPer1MTokens: 20,
    quality: 1,
    p95LatencyMs: 50,
    latencyStdDev: 5,
  });

  const selected = selectHybridLocalCloudCandidate([paidCloud, freeLocal], {
    taskType: "analysis",
    explorationRate: 0,
  });

  assert.equal(selected.provider, "ollama-local");
  assert.equal(selected.locality, "local");
  assert.equal(selected.cloudCandidates, 0);
});

test("cloud fallback wins when the local lane is materially weaker", () => {
  reset();
  const weakLocal = candidate("ollama-local", "reasoning-model", {
    p95LatencyMs: 9000,
    latencyStdDev: 1500,
    errorRate: 0.65,
    failureRate: 0.65,
    quality: 0.05,
  });
  const strongCloud = candidate("groq", "reasoning-model", {
    p95LatencyMs: 120,
    latencyStdDev: 10,
    errorRate: 0,
    failureRate: 0,
    quality: 1,
  });

  const selected = selectHybridLocalCloudCandidate([weakLocal, strongCloud], {
    taskType: "analysis",
    explorationRate: 0,
  });

  assert.equal(selected.provider, "groq");
  assert.equal(selected.locality, "cloud");

  const snapshot = getHybridLocalCloudSnapshot();
  assert.equal(snapshot.summary.cloudFallbacks, 1);
});

test("an OPEN local backend is ignored when healthy cloud capacity exists", () => {
  reset();
  const local = candidate("ollama-local", "model-a", {
    circuitBreakerState: "OPEN",
    quality: 1,
  });
  const cloud = candidate("groq", "model-b", { quality: 0.4 });

  const selected = selectHybridLocalCloudCandidate([local, cloud], {
    taskType: "default",
    explorationRate: 0,
  });

  assert.equal(selected.provider, "groq");
  assert.equal(selected.locality, "cloud");
  assert.equal(selected.localCandidates, 0);
});

test("local-first and cloud-first policies resolve explicitly", () => {
  reset();
  assert.equal(resolveHybridRoutingPolicy("local-first"), "local-first");
  assert.equal(resolveHybridRoutingPolicy("cloud-first"), "cloud-first");

  process.env.COBALTROUTE_HYBRID_POLICY = "local-first";
  assert.equal(resolveHybridRoutingPolicy(), "local-first");
});

test("Router Brain hybrid snapshot is aggregate-only and hides connection ids", () => {
  reset();
  const local = candidate("ollama-local", "shared-model", {
    connectionId: "secret-local-connection",
  });
  const cloud = candidate("groq", "shared-model", {
    connectionId: "secret-cloud-connection",
  });

  selectHybridLocalCloudCandidate([local, cloud], {
    taskType: "writing",
    explorationRate: 0,
  });

  const snapshot = getHybridLocalCloudSnapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.summary.decisions, 1);
  assert.equal(snapshot.summary.mixedPools, 1);
  assert.equal(serialized.includes("connectionId"), false);
  assert.equal(serialized.includes("secret-local-connection"), false);
  assert.equal(serialized.includes("secret-cloud-connection"), false);
});
