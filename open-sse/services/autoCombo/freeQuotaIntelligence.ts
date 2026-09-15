/**
 * CobaltRoute Free Quota Intelligence
 *
 * Treats free allowance as expiring inventory instead of a binary available /
 * unavailable flag. This layer deliberately reuses quota signals that OmniRoute
 * already computes on ProviderCandidate (remaining allowance, reset-window
 * affinity and reset interval) and never performs a second provider quota fetch.
 *
 * Runtime observations are ephemeral: quota snapshots go stale by definition,
 * so no connection ids, quota payloads, credentials, prompts or responses are
 * persisted by this module.
 *
 * Built by Cobalt.
 */

import type { ProviderCandidate } from "./scoring.ts";
import { getTaskFitness } from "./taskFitness.ts";
import { clamp01 } from "../../utils/number.ts";
import { selectAdaptiveCandidate, type AdaptiveSelection } from "./adaptiveRouter.ts";
import { filterFreeModelQualificationPool } from "@/lib/discovery/freeModelQualification";

const MAX_OBSERVATIONS = 500;
const SCARCE_THRESHOLD = 0.2;
const NEAR_EXHAUSTED_THRESHOLD = 0.03;
const HEALTHY_ALTERNATIVE_THRESHOLD = 0.15;
const EXPIRING_AFFINITY_THRESHOLD = 0.75;

export interface FreeQuotaIntelligenceContext {
  taskType: string;
  weights?: Parameters<typeof selectAdaptiveCandidate>[1]["weights"];
  explorationRate?: number;
}

export interface FreeQuotaAssessment {
  provider: string;
  model: string;
  remainingPercent: number;
  resetAffinity: number;
  taskPriority: number;
  modelValue: number;
  expiringOpportunity: number;
  reservePressure: number;
  inventoryScore: number;
  free: boolean;
  reason: string;
}

interface AssessedCandidate {
  candidate: ProviderCandidate;
  assessment: FreeQuotaAssessment;
}

interface QuotaObservation {
  taskType: string;
  provider: string;
  model: string;
  evaluations: number;
  selections: number;
  protectedEvaluations: number;
  scarceEvaluations: number;
  expiringEvaluations: number;
  avgInventoryScore: number;
  latestRemainingPercent: number;
  latestResetAffinity: number;
  latestReservePressure: number;
  latestExpiringOpportunity: number;
  updatedAt: number;
}

export interface FreeQuotaIntelligenceSnapshot {
  generatedAt: number;
  enabled: boolean;
  summary: {
    evaluations: number;
    selections: number;
    protectedEvaluations: number;
    scarceEvaluations: number;
    expiringEvaluations: number;
    modelCount: number;
    providerCount: number;
  };
  observations: QuotaObservation[];
}

const observations = new Map<string, QuotaObservation>();

function normalizeTaskType(taskType: string | null | undefined): string {
  return (
    String(taskType || "default")
      .trim()
      .toLowerCase() || "default"
  );
}

function observationKey(taskType: string, provider: string, model: string): string {
  return `${normalizeTaskType(taskType)}\u0000${provider}\u0000${model}`;
}

function executionKey(
  candidate: Pick<ProviderCandidate, "provider" | "model" | "connectionId">
): string {
  return `${candidate.provider}\u0000${candidate.model}\u0000${candidate.connectionId || ""}`;
}

function enabled(): boolean {
  return process.env.COBALTROUTE_FREE_QUOTA_INTELLIGENCE !== "0";
}

function isFreeLike(candidate: ProviderCandidate): boolean {
  return candidate.costPer1MTokens <= 0 || candidate.accountTier === "free";
}

function taskPriority(taskType: string): number {
  const task = normalizeTaskType(taskType);
  if (task === "coding" || task === "debugging") return 1;
  if (task === "review" || task === "analysis" || task === "planning") return 0.9;
  if (task === "documentation") return 0.65;
  if (task === "writing") return 0.55;
  if (task === "default" || task === "general" || task === "chat") return 0.45;
  return 0.6;
}

function resetAffinity(candidate: ProviderCandidate): number {
  if (
    typeof candidate.resetWindowAffinity === "number" &&
    Number.isFinite(candidate.resetWindowAffinity)
  ) {
    return clamp01(candidate.resetWindowAffinity);
  }

  const interval = candidate.quotaResetIntervalSecs;
  if (typeof interval === "number" && Number.isFinite(interval) && interval > 0) {
    const thirtyDaysSeconds = 30 * 24 * 60 * 60;
    return clamp01(1 - interval / thirtyDaysSeconds);
  }

  return 0.5;
}

/**
 * Pure quota-inventory score. Higher means "good free inventory to spend now".
 *
 * - remaining allowance protects against exhaustion before the hard cutoff;
 * - reset affinity rewards quota whose reset window is approaching;
 * - scarce, high-value models are protected on low-priority tasks;
 * - high-priority coding/reasoning work relaxes that reserve pressure.
 */
export function scoreFreeQuotaCandidate(
  candidate: ProviderCandidate,
  context: Pick<FreeQuotaIntelligenceContext, "taskType">
): FreeQuotaAssessment {
  const free = isFreeLike(candidate);
  if (!free) {
    return {
      provider: candidate.provider,
      model: candidate.model,
      remainingPercent: clamp01(candidate.quotaRemaining / 100) * 100,
      resetAffinity: resetAffinity(candidate),
      taskPriority: taskPriority(context.taskType),
      modelValue: 0.5,
      expiringOpportunity: 0,
      reservePressure: 0,
      inventoryScore: 0.5,
      free: false,
      reason: "paid/non-free candidate; quota inventory remains neutral",
    };
  }

  const remaining = clamp01(candidate.quotaRemaining / 100);
  const reset = resetAffinity(candidate);
  const priority = taskPriority(context.taskType);
  const fit = clamp01(getTaskFitness(candidate.model, normalizeTaskType(context.taskType)));
  const quality = clamp01(candidate.quality ?? 0.5);
  const reliability = clamp01(1 - Math.max(0, candidate.failureRate ?? candidate.errorRate ?? 0));
  const value = clamp01(fit * 0.55 + quality * 0.3 + reliability * 0.15);

  // Remaining free allowance that would otherwise be lost at the next reset.
  const expiringOpportunity = clamp01(reset * remaining);
  const scarcity = 1 - remaining;

  // Protect scarce high-value capacity from routine requests, while letting
  // important coding/reasoning tasks spend it when it is genuinely useful.
  const reservePressure = clamp01(scarcity * value * (1 - priority));

  let inventoryScore =
    remaining * 0.5 + reset * 0.15 + expiringOpportunity * 0.2 + (1 - reservePressure) * 0.15;

  // Near-exhausted accounts should lose before the provider's hard quota gate
  // fires, provided another free option exists. The pool policy below decides
  // whether an alternative actually exists; this factor simply makes the risk
  // visible in the assessment.
  if (remaining <= NEAR_EXHAUSTED_THRESHOLD) {
    inventoryScore *= Math.max(0.05, remaining / NEAR_EXHAUSTED_THRESHOLD);
  }

  inventoryScore = clamp01(inventoryScore);

  return {
    provider: candidate.provider,
    model: candidate.model,
    remainingPercent: remaining * 100,
    resetAffinity: reset,
    taskPriority: priority,
    modelValue: value,
    expiringOpportunity,
    reservePressure,
    inventoryScore,
    free: true,
    reason:
      `inventory=${inventoryScore.toFixed(3)} remaining=${(remaining * 100).toFixed(1)}% ` +
      `reset=${reset.toFixed(3)} expiring=${expiringOpportunity.toFixed(3)} ` +
      `reserve=${reservePressure.toFixed(3)} priority=${priority.toFixed(2)}`,
  };
}

function assessPool(pool: ProviderCandidate[], taskType: string): AssessedCandidate[] {
  return pool.map((candidate) => ({
    candidate,
    assessment: scoreFreeQuotaCandidate(candidate, { taskType }),
  }));
}

function applyInventoryPolicy(
  assessed: AssessedCandidate[],
  taskType: string
): { candidates: ProviderCandidate[]; includedKeys: Set<string> } {
  const healthy = assessed.filter((entry) => entry.candidate.circuitBreakerState !== "OPEN");
  const source = healthy.length > 0 ? healthy : assessed;
  const free = source.filter((entry) => entry.assessment.free);

  // Preserve normal adaptive behavior when there is no genuine choice between
  // free inventories. CobaltRoute's existing free-first layer still applies.
  if (free.length < 2) {
    return {
      candidates: source.map((entry) => entry.candidate),
      includedKeys: new Set(source.map((entry) => executionKey(entry.candidate))),
    };
  }

  let survivors = [...free];

  // Soft exhaustion gate: do not spend the last few percent of one account if
  // another free account has meaningful headroom.
  if (
    survivors.some(
      (entry) => entry.assessment.remainingPercent / 100 > HEALTHY_ALTERNATIVE_THRESHOLD
    )
  ) {
    survivors = survivors.filter(
      (entry) => entry.assessment.remainingPercent / 100 > NEAR_EXHAUSTED_THRESHOLD
    );
  }

  const priority = taskPriority(taskType);
  if (survivors.length > 1 && priority < 0.8) {
    const bestInventory = Math.max(...survivors.map((entry) => entry.assessment.inventoryScore));
    const floor = Math.max(0.35, bestInventory - 0.18);
    const narrowed = survivors.filter((entry) => {
      const assessment = entry.assessment;
      if (assessment.inventoryScore >= floor) return true;
      // A very strong model can stay available when there is enough quota; what
      // we are protecting here is *scarce* premium free capacity, not quality.
      return assessment.modelValue >= 0.9 && assessment.remainingPercent >= 35;
    });
    if (narrowed.length > 0) survivors = narrowed;
  }

  // Important coding/reasoning tasks get the full non-exhausted free pool; the
  // downstream adaptive learner can spend the best model if its learned/task
  // score justifies doing so.
  if (survivors.length === 0) survivors = free;

  const candidates = survivors.map((entry) => entry.candidate);
  return {
    candidates,
    includedKeys: new Set(candidates.map(executionKey)),
  };
}

function recordAssessment(
  taskType: string,
  assessed: AssessedCandidate,
  included: boolean,
  selected: boolean
): void {
  if (!assessed.assessment.free) return;
  const key = observationKey(taskType, assessed.candidate.provider, assessed.candidate.model);
  const current = observations.get(key) ?? {
    taskType: normalizeTaskType(taskType),
    provider: assessed.candidate.provider,
    model: assessed.candidate.model,
    evaluations: 0,
    selections: 0,
    protectedEvaluations: 0,
    scarceEvaluations: 0,
    expiringEvaluations: 0,
    avgInventoryScore: 0,
    latestRemainingPercent: 0,
    latestResetAffinity: 0.5,
    latestReservePressure: 0,
    latestExpiringOpportunity: 0,
    updatedAt: Date.now(),
  };

  current.evaluations += 1;
  if (selected) current.selections += 1;
  if (!included) current.protectedEvaluations += 1;
  if (assessed.assessment.remainingPercent <= SCARCE_THRESHOLD * 100)
    current.scarceEvaluations += 1;
  if (assessed.assessment.resetAffinity >= EXPIRING_AFFINITY_THRESHOLD)
    current.expiringEvaluations += 1;
  current.avgInventoryScore +=
    (assessed.assessment.inventoryScore - current.avgInventoryScore) / current.evaluations;
  current.latestRemainingPercent = assessed.assessment.remainingPercent;
  current.latestResetAffinity = assessed.assessment.resetAffinity;
  current.latestReservePressure = assessed.assessment.reservePressure;
  current.latestExpiringOpportunity = assessed.assessment.expiringOpportunity;
  current.updatedAt = Date.now();
  observations.set(key, current);

  if (observations.size > MAX_OBSERVATIONS) {
    const oldest = [...observations.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) observations.delete(oldest[0]);
  }
}

/**
 * Return V4's no-side-effect quota-aware candidate pool for higher-level
 * orchestration such as CobaltRoute's multi-model race planner.
 */
export function getFreeQuotaRacePool(
  pool: ProviderCandidate[],
  taskType: string
): ProviderCandidate[] {
  // V6 lets Race trial at most one probation model beside trusted/qualified
  // capacity. Quarantined discoveries never enter the race.
  const qualificationPool = filterFreeModelQualificationPool(pool, {
    allowProbation: true,
    maxProbation: 1,
  });
  if (!enabled()) {
    const healthy = qualificationPool.filter(
      (candidate) => candidate.circuitBreakerState !== "OPEN"
    );
    return healthy.length > 0 ? healthy : qualificationPool;
  }
  return applyInventoryPolicy(assessPool(qualificationPool, normalizeTaskType(taskType)), taskType)
    .candidates;
}

/**
 * CobaltRoute adaptive selection with a quota-inventory pre-policy.
 *
 * The adaptive learner still makes the final quality/task decision. This layer
 * only removes obviously wasteful free-quota choices (near-exhausted accounts
 * with healthier alternatives, and scarce premium inventory on routine work).
 */
export function selectQuotaAwareAdaptiveCandidate(
  pool: ProviderCandidate[],
  context: FreeQuotaIntelligenceContext
): AdaptiveSelection {
  // Normal adaptive routing holds novel probation models whenever a trusted or
  // already-qualified alternative exists. Race mode owns controlled probation.
  const qualificationPool = filterFreeModelQualificationPool(pool);
  if (!enabled()) {
    return selectAdaptiveCandidate(qualificationPool, context);
  }

  const taskType = normalizeTaskType(context.taskType);
  const assessed = assessPool(qualificationPool, taskType);
  const policy = applyInventoryPolicy(assessed, taskType);
  const selected = selectAdaptiveCandidate(policy.candidates, context);

  const selectedKey = `${selected.provider}\u0000${selected.model}\u0000${selected.connectionId || ""}`;
  let selectedAssessment: FreeQuotaAssessment | null = null;

  for (const entry of assessed) {
    const key = executionKey(entry.candidate);
    const isSelected = key === selectedKey;
    const included = policy.includedKeys.has(key);
    recordAssessment(taskType, entry, included, isSelected);
    if (isSelected) selectedAssessment = entry.assessment;
  }

  if (!selectedAssessment?.free) return selected;

  return {
    ...selected,
    reason: `${selected.reason} | FreeQuota(${selectedAssessment.reason})`,
  };
}

export function getFreeQuotaIntelligenceSnapshot(): FreeQuotaIntelligenceSnapshot {
  let evaluations = 0;
  let selections = 0;
  let protectedEvaluations = 0;
  let scarceEvaluations = 0;
  let expiringEvaluations = 0;
  const providers = new Set<string>();
  const models = new Set<string>();

  const values = [...observations.values()];
  for (const observation of values) {
    evaluations += observation.evaluations;
    selections += observation.selections;
    protectedEvaluations += observation.protectedEvaluations;
    scarceEvaluations += observation.scarceEvaluations;
    expiringEvaluations += observation.expiringEvaluations;
    providers.add(observation.provider);
    models.add(`${observation.provider}\u0000${observation.model}`);
  }

  return {
    generatedAt: Date.now(),
    enabled: enabled(),
    summary: {
      evaluations,
      selections,
      protectedEvaluations,
      scarceEvaluations,
      expiringEvaluations,
      modelCount: models.size,
      providerCount: providers.size,
    },
    observations: values
      .map((value) => ({ ...value }))
      .sort(
        (a, b) =>
          b.selections - a.selections ||
          b.evaluations - a.evaluations ||
          b.avgInventoryScore - a.avgInventoryScore
      )
      .slice(0, 50),
  };
}

/** Test/ops hook. Quota intelligence itself is intentionally non-persistent. */
export function resetFreeQuotaIntelligence(): void {
  observations.clear();
}
