/**
 * CobaltRoute Multi-Model Race + Verification
 *
 * Builds a small, quota-aware and provider-diverse race panel from the same
 * candidates OmniRoute already prepared for auto routing. Execution stays in
 * OmniRoute's normal combo attempt loop, so every contender passes the existing
 * response-quality verifier and the first verified success wins.
 *
 * Race telemetry is ephemeral and aggregate-only. Prompts, responses,
 * credentials and connection ids are never exposed by the snapshot.
 *
 * Built by Cobalt.
 */

import type { ProviderCandidate, ScoringWeights } from "./scoring.ts";
import { scorePool } from "./scoring.ts";
import { getTaskFitness } from "./taskFitness.ts";
import { clamp01 } from "../../utils/number.ts";
import {
  getAdaptiveLearningSnapshot,
  recordAdaptiveOutcome,
  type AdaptiveLearningEntry,
} from "./adaptiveRouter.ts";
import { getFreeQuotaRacePool, scoreFreeQuotaCandidate } from "./freeQuotaIntelligence.ts";
import { getFreeModelQualificationState } from "@/lib/discovery/freeModelQualification";

const MAX_RACE_WIDTH = 3;
const MIN_RACE_WIDTH = 2;
const MAX_RECENT_PLANS = 100;
const RACE_WINNER_REWARD = 0.76;

export interface MultiModelRaceContext {
  taskType: string;
  weights?: ScoringWeights;
  raceWidth?: number;
}

export interface MultiModelRaceCandidate {
  provider: string;
  model: string;
  connectionId?: string;
  score: number;
  baseScore: number;
  learnedScore: number;
  taskFit: number;
  quality: number;
  reliability: number;
  inventoryScore: number;
}

export interface MultiModelRacePlan {
  enabled: boolean;
  planId: string | null;
  taskType: string;
  width: number;
  candidates: MultiModelRaceCandidate[];
  reason: string;
}

type RaceStatus = "planned" | "won" | "exhausted" | "cancelled";

interface RuntimeRacePlan {
  planId: string;
  taskType: string;
  width: number;
  candidates: MultiModelRaceCandidate[];
  status: RaceStatus;
  dispatches: number;
  failures: number;
  winner: { provider: string; model: string } | null;
  createdAt: number;
  completedAt: number | null;
  updatedAt: number;
}

export interface MultiModelRaceSnapshot {
  generatedAt: number;
  enabled: boolean;
  summary: {
    plans: number;
    active: number;
    won: number;
    exhausted: number;
    cancelled: number;
    dispatches: number;
    failures: number;
    averageWidth: number;
  };
  plans: Array<{
    planId: string;
    taskType: string;
    width: number;
    status: RaceStatus;
    dispatches: number;
    failures: number;
    winner: { provider: string; model: string } | null;
    candidates: Array<{
      provider: string;
      model: string;
      score: number;
    }>;
    createdAt: number;
    completedAt: number | null;
    updatedAt: number;
  }>;
}

const plans = new Map<string, RuntimeRacePlan>();
let planSequence = 0;

function normalizeTaskType(taskType: string | null | undefined): string {
  return (
    String(taskType || "default")
      .trim()
      .toLowerCase() || "default"
  );
}

function normalizeIdentity(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeModel(provider: string, model: string): string {
  const providerId = normalizeIdentity(provider);
  const raw = normalizeIdentity(model);
  for (const separator of ["/", ":"]) {
    const prefix = `${providerId}${separator}`;
    if (providerId && raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return raw;
}

function candidateKey(
  candidate: Pick<ProviderCandidate, "provider" | "model" | "connectionId">
): string {
  return `${candidate.provider}\u0000${candidate.model}\u0000${candidate.connectionId || ""}`;
}

function modelKey(provider: string, model: string): string {
  return `${normalizeIdentity(provider)}\u0000${normalizeModel(provider, model)}`;
}

function raceEnabled(): boolean {
  return process.env.COBALTROUTE_MULTI_MODEL_RACE !== "0";
}

export function isMultiModelRaceStrategy(name: string | null | undefined): boolean {
  const normalized = String(name || "")
    .trim()
    .toLowerCase();
  return normalized === "race" || normalized === "cobalt-race" || normalized === "adaptive-race";
}

function defaultWidthForTask(taskType: string): number {
  const task = normalizeTaskType(taskType);
  if (
    task === "coding" ||
    task === "debugging" ||
    task === "analysis" ||
    task === "review" ||
    task === "planning"
  ) {
    return 3;
  }
  return 2;
}

function requestedRaceWidth(taskType: string, explicit?: number): number {
  const envWidth = Number(process.env.COBALTROUTE_RACE_WIDTH);
  const raw =
    typeof explicit === "number" && Number.isFinite(explicit)
      ? explicit
      : Number.isFinite(envWidth) && envWidth > 0
        ? envWidth
        : defaultWidthForTask(taskType);
  return Math.max(MIN_RACE_WIDTH, Math.min(MAX_RACE_WIDTH, Math.floor(raw)));
}

export function resolveMultiModelRaceWidth(value: unknown, poolSize: number): number {
  if (!Number.isFinite(poolSize) || poolSize <= 0) return 0;
  const parsed = Number(value);
  const width =
    Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : Math.min(MAX_RACE_WIDTH, Math.floor(poolSize));
  return Math.max(1, Math.min(MAX_RACE_WIDTH, Math.floor(poolSize), width));
}

export function isMultiModelRaceMember(index: number, width: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < width;
}

export function isMultiModelRaceBarrier(index: number, width: number): boolean {
  return isMultiModelRaceMember(index, width) && index === width - 1;
}

function learnedSignal(entry: AdaptiveLearningEntry | undefined): number {
  if (!entry) return 0.5;
  const semanticConfidence = 1 - Math.exp(-entry.observations / 12);
  const proxyConfidence = 1 - Math.exp(-entry.proxyObservations / 20);
  const semantic = 0.5 + semanticConfidence * (entry.rewardEwma - 0.5);
  const proxy = 0.5 + proxyConfidence * (entry.proxyEwma - 0.5);
  if (entry.observations > 0) return clamp01(semantic * 0.8 + proxy * 0.2);
  if (entry.proxyObservations > 0) return clamp01(proxy);
  return 0.5;
}

function reliabilitySignal(candidate: ProviderCandidate): number {
  const rate = candidate.failureRate ?? candidate.errorRate;
  if (!Number.isFinite(rate) || Number(rate) < 0) return 1;
  return clamp01(1 - Number(rate));
}

function isFreeLike(candidate: ProviderCandidate): boolean {
  return candidate.costPer1MTokens <= 0 || candidate.accountTier === "free";
}

function nextPlanId(): string {
  planSequence = (planSequence + 1) % 1_000_000;
  return `race-${Date.now().toString(36)}-${planSequence.toString(36)}`;
}

function prunePlans(): void {
  if (plans.size <= MAX_RECENT_PLANS) return;
  const oldest = [...plans.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
  if (oldest) plans.delete(oldest.planId);
}

function storePlan(plan: MultiModelRacePlan): void {
  if (!plan.enabled || !plan.planId) return;
  const now = Date.now();
  plans.set(plan.planId, {
    planId: plan.planId,
    taskType: plan.taskType,
    width: plan.width,
    candidates: plan.candidates.map((candidate) => ({ ...candidate })),
    status: "planned",
    dispatches: 0,
    failures: 0,
    winner: null,
    createdAt: now,
    completedAt: null,
    updatedAt: now,
  });
  prunePlans();
}

/**
 * Select 2–3 contenders for a verified parallel race.
 *
 * The pool first passes through V4's no-side-effect free-quota inventory policy,
 * then candidates are ranked with existing OmniRoute score + learned task quality
 * + task fit + reliability + inventory. Provider diversity is preferred before
 * filling remaining slots.
 */
export function planMultiModelRace(
  pool: ProviderCandidate[],
  context: MultiModelRaceContext
): MultiModelRacePlan {
  const taskType = normalizeTaskType(context.taskType);

  if (!raceEnabled()) {
    return {
      enabled: false,
      planId: null,
      taskType,
      width: 0,
      candidates: [],
      reason: "MultiModelRace disabled by COBALTROUTE_MULTI_MODEL_RACE=0",
    };
  }

  const healthy = pool.filter((candidate) => candidate.circuitBreakerState !== "OPEN");
  let source = healthy.length > 0 ? healthy : pool;
  if (process.env.COBALTROUTE_FREE_ONLY !== "0") {
    const free = source.filter(isFreeLike);
    if (free.length > 0) source = free;
  }

  source = getFreeQuotaRacePool(source, taskType);
  if (source.length < 2) {
    return {
      enabled: false,
      planId: null,
      taskType,
      width: source.length,
      candidates: [],
      reason: `MultiModelRace needs at least 2 eligible candidates; found ${source.length}`,
    };
  }

  const baseRanked = scorePool(source, taskType, context.weights, getTaskFitness);
  const baseScores = new Map(
    baseRanked.map((candidate) => [candidateKey(candidate), candidate.score])
  );
  const learning = new Map(
    getAdaptiveLearningSnapshot(taskType).map((entry) => [
      modelKey(entry.provider, entry.model),
      entry,
    ])
  );

  const ranked = source
    .map((candidate) => {
      const baseScore = clamp01(baseScores.get(candidateKey(candidate)) ?? 0);
      const learnedScore = learnedSignal(
        learning.get(modelKey(candidate.provider, candidate.model))
      );
      const taskFit = clamp01(getTaskFitness(candidate.model, taskType));
      const quality = clamp01(candidate.quality ?? 0.5);
      const reliability = reliabilitySignal(candidate);
      const inventoryScore = scoreFreeQuotaCandidate(candidate, { taskType }).inventoryScore;
      const score = clamp01(
        baseScore * 0.38 +
          learnedScore * 0.2 +
          taskFit * 0.1 +
          quality * 0.1 +
          reliability * 0.08 +
          inventoryScore * 0.14
      );
      return {
        provider: candidate.provider,
        model: candidate.model,
        connectionId: candidate.connectionId,
        score,
        baseScore,
        learnedScore,
        taskFit,
        quality,
        reliability,
        inventoryScore,
      } satisfies MultiModelRaceCandidate;
    })
    .sort(
      (a, b) => b.score - a.score || b.learnedScore - a.learnedScore || b.baseScore - a.baseScore
    );

  const uniqueModels: MultiModelRaceCandidate[] = [];
  const seenModels = new Set<string>();
  for (const candidate of ranked) {
    const key = modelKey(candidate.provider, candidate.model);
    if (seenModels.has(key)) continue;
    seenModels.add(key);
    uniqueModels.push(candidate);
  }

  const desiredWidth = Math.min(
    requestedRaceWidth(taskType, context.raceWidth),
    uniqueModels.length
  );
  if (desiredWidth < 2) {
    return {
      enabled: false,
      planId: null,
      taskType,
      width: desiredWidth,
      candidates: [],
      reason: `MultiModelRace needs at least 2 distinct models; found ${desiredWidth}`,
    };
  }

  const chosen: MultiModelRaceCandidate[] = [];
  const chosenKeys = new Set<string>();
  const providers = new Set<string>();

  for (const candidate of uniqueModels) {
    if (chosen.length >= desiredWidth) break;
    const providerKey = normalizeIdentity(candidate.provider);
    if (providers.has(providerKey)) continue;
    chosen.push(candidate);
    providers.add(providerKey);
    chosenKeys.add(modelKey(candidate.provider, candidate.model));
  }

  for (const candidate of uniqueModels) {
    if (chosen.length >= desiredWidth) break;
    const key = modelKey(candidate.provider, candidate.model);
    if (chosenKeys.has(key)) continue;
    chosen.push(candidate);
    chosenKeys.add(key);
  }

  // V6 qualification lane: when the eligible pool contains one probation model,
  // ensure a race with trusted capacity actually exercises it instead of letting
  // pure ranking permanently starve the candidate of verification evidence.
  const probationCandidate = uniqueModels.find(
    (candidate) =>
      getFreeModelQualificationState(candidate.provider, candidate.model) === "probation" &&
      !chosen.some(
        (selected) =>
          modelKey(selected.provider, selected.model) ===
          modelKey(candidate.provider, candidate.model)
      )
  );
  const hasTrustedRaceMember = chosen.some((candidate) => {
    const state = getFreeModelQualificationState(candidate.provider, candidate.model);
    return state === "trusted" || state === "qualified";
  });
  if (probationCandidate && chosen.length >= 2 && hasTrustedRaceMember) {
    chosen[chosen.length - 1] = probationCandidate;
  }

  const planId = nextPlanId();
  const plan: MultiModelRacePlan = {
    enabled: chosen.length >= 2,
    planId: chosen.length >= 2 ? planId : null,
    taskType,
    width: chosen.length,
    candidates: chosen,
    reason:
      `MultiModelRace(task=${taskType}, width=${chosen.length}): ` +
      chosen
        .map(
          (candidate) => `${candidate.provider}/${candidate.model}=${candidate.score.toFixed(3)}`
        )
        .join(", "),
  };
  storePlan(plan);
  return plan;
}

function findPlannedCandidate(
  plan: RuntimeRacePlan,
  provider: string,
  model: string
): MultiModelRaceCandidate | undefined {
  const key = modelKey(provider, model);
  return plan.candidates.find((candidate) => modelKey(candidate.provider, candidate.model) === key);
}

export function recordMultiModelRaceDispatch(
  planId: string | null | undefined,
  provider: string,
  model: string
): void {
  if (!planId) return;
  const plan = plans.get(planId);
  if (!plan || plan.status !== "planned") return;
  if (!findPlannedCandidate(plan, provider, model)) return;
  plan.dispatches += 1;
  plan.updatedAt = Date.now();
}

export function recordMultiModelRaceFailure(
  planId: string | null | undefined,
  provider: string,
  model: string
): void {
  if (!planId) return;
  const plan = plans.get(planId);
  if (!plan || plan.status !== "planned") return;
  if (!findPlannedCandidate(plan, provider, model)) return;
  plan.failures += 1;
  plan.updatedAt = Date.now();
}

export function recordMultiModelRaceWinner(
  planId: string | null | undefined,
  provider: string,
  model: string
): void {
  if (!planId) return;
  const plan = plans.get(planId);
  if (!plan || plan.status !== "planned") return;
  const candidate = findPlannedCandidate(plan, provider, model);
  if (!candidate) return;

  const now = Date.now();
  plan.status = "won";
  plan.winner = { provider: candidate.provider, model: candidate.model };
  plan.completedAt = now;
  plan.updatedAt = now;

  recordAdaptiveOutcome({
    taskType: plan.taskType,
    provider: candidate.provider,
    model: candidate.model,
    reward: RACE_WINNER_REWARD,
  });
}

export function recordMultiModelRaceExhausted(planId: string | null | undefined): void {
  if (!planId) return;
  const plan = plans.get(planId);
  if (!plan || plan.status !== "planned") return;
  const now = Date.now();
  plan.status = "exhausted";
  plan.completedAt = now;
  plan.updatedAt = now;
}

export function recordMultiModelRaceCancelled(planId: string | null | undefined): void {
  if (!planId) return;
  const plan = plans.get(planId);
  if (!plan || plan.status !== "planned") return;
  const now = Date.now();
  plan.status = "cancelled";
  plan.completedAt = now;
  plan.updatedAt = now;
}

export function getMultiModelRaceSnapshot(): MultiModelRaceSnapshot {
  const values = [...plans.values()];
  const won = values.filter((plan) => plan.status === "won").length;
  const exhausted = values.filter((plan) => plan.status === "exhausted").length;
  const cancelled = values.filter((plan) => plan.status === "cancelled").length;
  const active = values.filter((plan) => plan.status === "planned").length;
  const dispatches = values.reduce((sum, plan) => sum + plan.dispatches, 0);
  const failures = values.reduce((sum, plan) => sum + plan.failures, 0);
  const averageWidth =
    values.length > 0 ? values.reduce((sum, plan) => sum + plan.width, 0) / values.length : 0;

  return {
    generatedAt: Date.now(),
    enabled: raceEnabled(),
    summary: {
      plans: values.length,
      active,
      won,
      exhausted,
      cancelled,
      dispatches,
      failures,
      averageWidth,
    },
    plans: values
      .map((plan) => ({
        planId: plan.planId,
        taskType: plan.taskType,
        width: plan.width,
        status: plan.status,
        dispatches: plan.dispatches,
        failures: plan.failures,
        winner: plan.winner ? { ...plan.winner } : null,
        candidates: plan.candidates.map((candidate) => ({
          provider: candidate.provider,
          model: candidate.model,
          score: candidate.score,
        })),
        createdAt: plan.createdAt,
        completedAt: plan.completedAt,
        updatedAt: plan.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50),
  };
}

export function resetMultiModelRace(): void {
  plans.clear();
  planSequence = 0;
}
