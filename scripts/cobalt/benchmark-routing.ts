#!/usr/bin/env node
/**
 * CobaltRoute deterministic routing-policy benchmark.
 *
 * No external LLM calls are made. This compares the inherited OmniRoute
 * `rules` baseline against CobaltRoute's adaptive/hybrid strategy on synthetic,
 * deterministic policy scenarios. It is a routing-policy benchmark, not a model
 * intelligence benchmark.
 *
 * Built by Cobalt.
 */

import type { ProviderCandidate } from "../../open-sse/services/autoCombo/scoring.ts";

process.env.COBALTROUTE_ADAPTIVE_PERSIST = "0";
process.env.COBALTROUTE_DISCOVERY_PERSIST = "0";
process.env.COBALTROUTE_FREE_MODEL_DISCOVERY = "1";
process.env.COBALTROUTE_FREE_QUOTA_INTELLIGENCE = "1";
process.env.COBALTROUTE_MULTI_MODEL_RACE = "1";
process.env.COBALTROUTE_PROTOCOL_COMPATIBILITY = "1";
process.env.COBALTROUTE_HYBRID_LOCAL_CLOUD = "1";
process.env.COBALTROUTE_HYBRID_POLICY = "balanced";
process.env.COBALTROUTE_FREE_ONLY = "1";

const [
  routerModule,
  adaptiveModule,
  quotaModule,
  hybridModule,
  discoveryModule,
  compatibilityModule,
] = await Promise.all([
  import("../../open-sse/services/autoCombo/routerStrategy.ts"),
  import("../../open-sse/services/autoCombo/adaptiveRouter.ts"),
  import("../../open-sse/services/autoCombo/freeQuotaIntelligence.ts"),
  import("../../open-sse/services/autoCombo/hybridLocalCloud.ts"),
  import("../../src/lib/discovery/freeModelQualification.ts"),
  import("../../open-sse/services/autoCombo/protocolCompatibility.ts"),
]);

const { selectWithStrategy } = routerModule;
const { recordAdaptiveOutcome, resetAdaptiveLearning } = adaptiveModule;
const { resetFreeQuotaIntelligence } = quotaModule;
const { resetHybridLocalCloud } = hybridModule;
const { resetFreeModelDiscovery } = discoveryModule;
const { recordProtocolCompatibilityFailure, resetProtocolCompatibility } = compatibilityModule;

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
    p95LatencyMs: 250,
    latencyStdDev: 20,
    errorRate: 0,
    failureRate: 0,
    accountTier: "free",
    quality: 0.5,
    resetWindowAffinity: 0.5,
    ...options,
  } as ProviderCandidate;
}

function resetState(): void {
  resetAdaptiveLearning();
  resetFreeQuotaIntelligence();
  resetHybridLocalCloud();
  resetFreeModelDiscovery();
  resetProtocolCompatibility();
  process.env.COBALTROUTE_FREE_ONLY = "1";
  process.env.COBALTROUTE_HYBRID_POLICY = "balanced";
  delete process.env.COBALTROUTE_LOCAL_PROVIDER_IDS;
}

type Scenario = {
  name: string;
  taskType: string;
  candidates: ProviderCandidate[];
  expectedProvider: string;
  setup?: () => void;
};

const scenarios: Scenario[] = [
  {
    name: "free-first over attractive paid capacity",
    taskType: "analysis",
    candidates: [
      candidate("premium-cloud", "reasoning-shared", {
        accountTier: "pro",
        costPer1MTokens: 18,
        quality: 1,
        p95LatencyMs: 40,
        latencyStdDev: 3,
      }),
      candidate("free-cloud", "reasoning-shared", {
        quality: 0.2,
        p95LatencyMs: 2800,
        latencyStdDev: 400,
      }),
    ],
    expectedProvider: "free-cloud",
  },
  {
    name: "routine work offloads to competitive local model",
    taskType: "documentation",
    candidates: [
      candidate("groq", "shared-model"),
      candidate("ollama-local", "shared-model"),
    ],
    expectedProvider: "ollama-local",
  },
  {
    name: "materially weak local lane falls back to cloud",
    taskType: "analysis",
    candidates: [
      candidate("ollama-local", "reasoning-model", {
        quality: 0.05,
        p95LatencyMs: 9000,
        latencyStdDev: 1500,
        errorRate: 0.65,
        failureRate: 0.65,
      }),
      candidate("groq", "reasoning-model", {
        quality: 1,
        p95LatencyMs: 100,
        latencyStdDev: 8,
      }),
    ],
    expectedProvider: "groq",
  },
  {
    name: "open circuit is excluded from healthy capacity",
    taskType: "default",
    candidates: [
      candidate("ollama-local", "model-a", {
        circuitBreakerState: "OPEN",
        quality: 1,
      }),
      candidate("groq", "model-b", { quality: 0.4 }),
    ],
    expectedProvider: "groq",
  },
  {
    name: "task-specific outcomes overturn a cold-start tie",
    taskType: "coding",
    candidates: [
      candidate("alpha", "shared-code-model"),
      candidate("beta", "shared-code-model"),
    ],
    expectedProvider: "beta",
    setup: () => {
      for (let index = 0; index < 10; index += 1) {
        recordAdaptiveOutcome({
          taskType: "coding",
          provider: "alpha",
          model: "shared-code-model",
          reward: 0.05,
        });
        recordAdaptiveOutcome({
          taskType: "coding",
          provider: "beta",
          model: "shared-code-model",
          reward: 1,
        });
      }
    },
  },
  {
    name: "protocol evidence steers away from repeatedly malformed target",
    taskType: "default",
    candidates: [
      candidate("flaky-protocol", "shared-tool-model"),
      candidate("stable-protocol", "shared-tool-model"),
    ],
    expectedProvider: "stable-protocol",
    setup: () => {
      for (let index = 0; index < 6; index += 1) {
        recordProtocolCompatibilityFailure({
          provider: "flaky-protocol",
          model: "shared-tool-model",
          error: "invalid tool call schema: malformed tool arguments",
          status: 400,
        });
      }
    },
  },
  {
    name: "quota intelligence protects nearly exhausted free capacity",
    taskType: "default",
    candidates: [
      candidate("scarce", "shared-free-model", {
        quotaRemaining: 1,
        quotaTotal: 100,
      }),
      candidate("roomy", "shared-free-model", {
        quotaRemaining: 80,
        quotaTotal: 100,
      }),
    ],
    expectedProvider: "roomy",
  },
];

type Result = {
  scenario: string;
  expected: string;
  baseline: string;
  cobalt: string;
  baselineHit: boolean;
  cobaltHit: boolean;
};

const results: Result[] = [];

for (const scenario of scenarios) {
  resetState();
  scenario.setup?.();

  const context = {
    taskType: scenario.taskType,
    explorationRate: 0,
  };

  const baseline = selectWithStrategy(scenario.candidates, context, "rules");
  const cobalt = selectWithStrategy(scenario.candidates, context, "adaptive");

  results.push({
    scenario: scenario.name,
    expected: scenario.expectedProvider,
    baseline: baseline.provider,
    cobalt: cobalt.provider,
    baselineHit: baseline.provider === scenario.expectedProvider,
    cobaltHit: cobalt.provider === scenario.expectedProvider,
  });
}

const baselineHits = results.filter((result) => result.baselineHit).length;
const cobaltHits = results.filter((result) => result.cobaltHit).length;
const delta = cobaltHits - baselineHits;

console.log("============================================================");
console.log(" COBALTROUTE — DETERMINISTIC ROUTING BENCHMARK");
console.log(" Built by Cobalt.");
console.log("============================================================");
console.log();
console.log("This benchmark makes no network or LLM calls.");
console.log("It measures deterministic routing-policy goals only.");
console.log();

for (const result of results) {
  const cobaltMark = result.cobaltHit ? "PASS" : "FAIL";
  const baselineMark = result.baselineHit ? "hit" : "miss";
  console.log(`• ${result.scenario}`);
  console.log(`  expected: ${result.expected}`);
  console.log(`  rules:    ${result.baseline} (${baselineMark})`);
  console.log(`  cobalt:   ${result.cobalt} (${cobaltMark})`);
}

console.log();
console.log(`Rules baseline policy hits: ${baselineHits}/${results.length}`);
console.log(`Cobalt adaptive policy hits: ${cobaltHits}/${results.length}`);
console.log(`Cobalt policy-hit delta: ${delta >= 0 ? "+" : ""}${delta}`);
console.log();

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        kind: "cobaltroute-deterministic-routing-policy-benchmark",
        networkCalls: 0,
        scenarios: results,
        baselineHits,
        cobaltHits,
        delta,
      },
      null,
      2
    )
  );
}

if (cobaltHits !== results.length) {
  console.error("Benchmark invariant failed: CobaltRoute missed one or more expected policy goals.");
  process.exitCode = 1;
} else {
  console.log("Benchmark invariant PASS: CobaltRoute satisfied every expected policy goal.");
}
