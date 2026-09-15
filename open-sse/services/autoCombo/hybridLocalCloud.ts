/**
 * CobaltRoute Hybrid Local + Cloud Routing
 *
 * Chooses whether an adaptive request should run on a local/self-hosted model
 * pool or a cloud pool before the normal quota-aware adaptive selector makes
 * the final provider/model decision. This keeps the existing Cobalt learning,
 * free-quota inventory and compatibility layers authoritative while adding a
 * privacy/cost-friendly local execution lane with automatic cloud fallback.
 *
 * Locality is derived from OmniRoute's existing local-provider registry plus an
 * optional explicit provider-id allowlist. Endpoint URLs, connection ids,
 * prompts and responses are never persisted or exposed by this module.
 *
 * Built by Cobalt.
 */

import { isLocalProvider } from "@/shared/constants/providers";
import { filterFreeModelQualificationPool } from "@/lib/discovery/freeModelQualification";
import type { ProviderCandidate, ScoringWeights } from "./scoring.ts";
import { scorePool } from "./scoring.ts";
import { getTaskFitness } from "./taskFitness.ts";
import {
  getAdaptiveLearningSnapshot,
  type AdaptiveLearningEntry,
  type AdaptiveSelection,
} from "./adaptiveRouter.ts";
import {
  selectQuotaAwareAdaptiveCandidate,
  type FreeQuotaIntelligenceContext,
} from "./freeQuotaIntelligence.ts";
import { clamp01 } from "../../utils/number.ts";

const MAX_MODEL_OBSERVATIONS = 400;
const MAX_TASK_OBSERVATIONS = 100;

export type HybridRoutingPolicy = "balanced" | "local-first" | "cloud-first";
export type HybridLocality = "local" | "cloud";

export interface HybridLocalCloudContext extends FreeQuotaIntelligenceContext {
  policy?: HybridRoutingPolicy;
}

export interface HybridLocalCloudSelection extends AdaptiveSelection {
  locality: HybridLocality;
  policy: HybridRoutingPolicy;
  localCandidates: number;
  cloudCandidates: number;
  localMerit: number | null;
  cloudMerit: number | null;
}

interface HybridModelObservation {
  taskType: string;
  provider: string;
  model: string;
  locality: HybridLocality;
  selections: number;
  mixedPoolSelections: number;
  avgMerit: number;
  updatedAt: number;
}

interface HybridTaskObservation {
  taskType: string;
  decisions: number;
  mixedPools: number;
  localSelections: number;
  cloudSelections: number;
  localOffloads: number;
  cloudFallbacks: number;
  localCandidatesSeen: number;
  cloudCandidatesSeen: number;
  updatedAt: number;
}

export interface HybridLocalCloudSnapshot {
  generatedAt: number;
  enabled: boolean;
  policy: HybridRoutingPolicy;
  explicitLocalProviderCount: number;
  summary: {
    decisions: number;
    mixedPools: number;
    localSelections: number;
    cloudSelections: number;
    localOffloads: number;
    cloudFallbacks: number;
    localCandidatesSeen: number;
    cloudCandidatesSeen: number;
    modelCount: number;
    providerCount: number;
    taskCount: number;
  };
  tasks: HybridTaskObservation[];
  models: HybridModelObservation[];
}

const modelObservations = new Map<string, HybridModelObservation>();
const taskObservations = new Map<string, HybridTaskObservation>();

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

function normalizedModel(provider: string, model: string): string {
  const providerId = normalizeIdentity(provider);
  const raw = normalizeIdentity(model);
  for (const separator of ["/", ":"]) {
    const prefix = `${providerId}${separator}`;
    if (providerId && raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return raw;
}

function modelKey(provider: string, model: string): string {
  return `${normalizeIdentity(provider)}\u0000${normalizedModel(provider, model)}`;
}

function executionKey(candidate: {
  provider: string;
  model: string;
  connectionId?: string;
}): string {
  return `${normalizeIdentity(candidate.provider)}\u0000${normalizedModel(candidate.provider, candidate.model)}\u0000${candidate.connectionId || ""}`;
}

function observationKey(taskType: string, provider: string, model: string): string {
  return `${normalizeTaskType(taskType)}\u0000${modelKey(provider, model)}`;
}

function hybridEnabled(): boolean {
  return process.env.COBALTROUTE_HYBRID_LOCAL_CLOUD !== "0";
}

function explicitLocalProviderIds(): Set<string> {
  return new Set(
    String(process.env.COBALTROUTE_LOCAL_PROVIDER_IDS || "")
      .split(",")
      .map((value) => normalizeIdentity(value))
      .filter(Boolean)
  );
}

export function resolveHybridRoutingPolicy(
  explicit?: HybridRoutingPolicy | null
): HybridRoutingPolicy {
  if (explicit === "local-first" || explicit === "cloud-first" || explicit === "balanced") {
    return explicit;
  }
  const configured = normalizeIdentity(process.env.COBALTROUTE_HYBRID_POLICY);
  if (configured === "local-first" || configured === "cloud-first") return configured;
  return "balanced";
}

/**
 * True when a provider belongs to OmniRoute's local/self-hosted registry or is
 * explicitly opted in via COBALTROUTE_LOCAL_PROVIDER_IDS.
 */
export function isHybridLocalProvider(provider: string | null | undefined): boolean {
  const normalized = normalizeIdentity(provider);
  if (!normalized) return false;
  if (isLocalProvider(normalized)) return true;
  return explicitLocalProviderIds().has(normalized);
}

function isFreeLike(candidate: ProviderCandidate): boolean {
  return candidate.costPer1MTokens <= 0 || candidate.accountTier === "free";
}

function taskLocalBias(taskType: string): number {
  const task = normalizeTaskType(taskType);
  if (
    task === "default" ||
    task === "general" ||
    task === "chat" ||
    task === "simple" ||
    task === "documentation" ||
    task === "writing" ||
    task === "summarization" ||
    task === "translation"
  ) {
    return 0.09;
  }
  if (task === "coding" || task === "debugging" || task === "review") return 0.04;
  if (task === "planning") return 0.01;
  if (task === "analysis" || task === "reasoning") return -0.02;
  if (task === "vision" || task === "multimodal") return -0.03;
  return 0.03;
}

function policyBias(policy: HybridRoutingPolicy): number {
  if (policy === "local-first") return 0.18;
  if (policy === "cloud-first") return -0.18;
  return 0;
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

function reliability(candidate: ProviderCandidate): number {
  const rate = candidate.failureRate ?? candidate.errorRate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return 1;
  return clamp01(1 - rate);
}

function buildBaseScores(
  pool: ProviderCandidate[],
  taskType: string,
  weights?: ScoringWeights
): Map<string, number> {
  return new Map(
    scorePool(pool, taskType, weights, getTaskFitness).map((entry) => [
      executionKey(entry),
      entry.score,
    ])
  );
}

function poolMerit(
  pool: ProviderCandidate[],
  taskType: string,
  baseScores: ReadonlyMap<string, number>
): { merit: number; provider: string; model: string } | null {
  if (pool.length === 0) return null;
  const learning = new Map(
    getAdaptiveLearningSnapshot(taskType).map((entry) => [
      modelKey(entry.provider, entry.model),
      entry,
    ])
  );

  let best: { merit: number; provider: string; model: string } | null = null;
  for (const candidate of pool) {
    const base = clamp01(baseScores.get(executionKey(candidate)) ?? 0);
    const learned = learnedSignal(learning.get(modelKey(candidate.provider, candidate.model)));
    const fit = clamp01(getTaskFitness(candidate.model, taskType));
    const quality = clamp01(candidate.quality ?? 0.5);
    const stable = reliability(candidate);
    const merit = clamp01(
      base * 0.45 + learned * 0.25 + fit * 0.1 + quality * 0.1 + stable * 0.1
    );
    if (!best || merit > best.merit) {
      best = { merit, provider: candidate.provider, model: candidate.model };
    }
  }
  return best;
}

function pruneOldest<T extends { updatedAt: number }>(map: Map<string, T>, limit: number): void {
  if (map.size <= limit) return;
  const oldest = [...map.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
  if (oldest) map.delete(oldest[0]);
}

function recordDecision(input: {
  taskType: string;
  selected: AdaptiveSelection;
  locality: HybridLocality;
  localCandidates: number;
  cloudCandidates: number;
  selectedMerit: number;
}): void {
  const taskType = normalizeTaskType(input.taskType);
  const mixed = input.localCandidates > 0 && input.cloudCandidates > 0;
  const task = taskObservations.get(taskType) ?? {
    taskType,
    decisions: 0,
    mixedPools: 0,
    localSelections: 0,
    cloudSelections: 0,
    localOffloads: 0,
    cloudFallbacks: 0,
    localCandidatesSeen: 0,
    cloudCandidatesSeen: 0,
    updatedAt: Date.now(),
  };
  task.decisions += 1;
  if (mixed) task.mixedPools += 1;
  if (input.locality === "local") {
    task.localSelections += 1;
    if (mixed) task.localOffloads += 1;
  } else {
    task.cloudSelections += 1;
    if (mixed) task.cloudFallbacks += 1;
  }
  task.localCandidatesSeen += input.localCandidates;
  task.cloudCandidatesSeen += input.cloudCandidates;
  task.updatedAt = Date.now();
  taskObservations.set(taskType, task);
  pruneOldest(taskObservations, MAX_TASK_OBSERVATIONS);

  const key = observationKey(taskType, input.selected.provider, input.selected.model);
  const model = modelObservations.get(key) ?? {
    taskType,
    provider: input.selected.provider,
    model: input.selected.model,
    locality: input.locality,
    selections: 0,
    mixedPoolSelections: 0,
    avgMerit: 0,
    updatedAt: Date.now(),
  };
  model.selections += 1;
  if (mixed) model.mixedPoolSelections += 1;
  model.avgMerit += (input.selectedMerit - model.avgMerit) / model.selections;
  model.updatedAt = Date.now();
  modelObservations.set(key, model);
  pruneOldest(modelObservations, MAX_MODEL_OBSERVATIONS);
}

function appendHybridReason(
  selected: AdaptiveSelection,
  locality: HybridLocality,
  policy: HybridRoutingPolicy,
  localMerit: number | null,
  cloudMerit: number | null,
  bias: number
): AdaptiveSelection {
  const localLabel = localMerit === null ? "n/a" : localMerit.toFixed(3);
  const cloudLabel = cloudMerit === null ? "n/a" : cloudMerit.toFixed(3);
  return {
    ...selected,
    reason:
      `${selected.reason} | Hybrid(${policy} ${locality}; ` +
      `local=${localLabel} cloud=${cloudLabel} bias=${bias.toFixed(3)})`,
  };
}

/**
 * Select through a local or cloud lane, then let V6+V4+V1 choose the exact model.
 * Only the ultimately chosen lane calls the adaptive selector, so comparison
 * itself does not create phantom adaptive selections or duplicate learning.
 */
export function selectHybridLocalCloudCandidate(
  pool: ProviderCandidate[],
  context: HybridLocalCloudContext
): HybridLocalCloudSelection {
  if (pool.length === 0) throw new Error("HybridLocalCloud: no candidates available");

  const policy = resolveHybridRoutingPolicy(context.policy);
  if (!hybridEnabled()) {
    const selected = selectQuotaAwareAdaptiveCandidate(pool, context);
    const locality: HybridLocality = isHybridLocalProvider(selected.provider) ? "local" : "cloud";
    return {
      ...selected,
      locality,
      policy,
      localCandidates: pool.filter((candidate) => isHybridLocalProvider(candidate.provider)).length,
      cloudCandidates: pool.filter((candidate) => !isHybridLocalProvider(candidate.provider)).length,
      localMerit: null,
      cloudMerit: null,
    };
  }

  const healthy = pool.filter((candidate) => candidate.circuitBreakerState !== "OPEN");
  let source = healthy.length > 0 ? healthy : pool;

  // Mirror V6's normal adaptive admission before comparing lanes. Otherwise a
  // quarantined or probation model could make a lane look artificially strong
  // even though the downstream selector would refuse to spend a request on it.
  const qualified = filterFreeModelQualificationPool(source);
  if (qualified.length > 0) source = qualified;

  // Preserve V1's global free-first contract BEFORE splitting local vs cloud.
  // Without this, a strong paid cloud lane could beat a free local/cloud lane,
  // then free-only would only be applied inside the already-chosen cloud lane.
  if (process.env.COBALTROUTE_FREE_ONLY !== "0") {
    const free = source.filter(isFreeLike);
    if (free.length > 0) source = free;
  }

  const local = source.filter((candidate) => isHybridLocalProvider(candidate.provider));
  const cloud = source.filter((candidate) => !isHybridLocalProvider(candidate.provider));
  const taskType = normalizeTaskType(context.taskType);
  const baseScores = buildBaseScores(source, taskType, context.weights);
  const localBest = poolMerit(local, taskType, baseScores);
  const cloudBest = poolMerit(cloud, taskType, baseScores);
  const bias = taskLocalBias(taskType) + policyBias(policy);

  let lane: ProviderCandidate[];
  let locality: HybridLocality;
  if (local.length === 0) {
    lane = cloud.length > 0 ? cloud : source;
    locality = "cloud";
  } else if (cloud.length === 0) {
    lane = local;
    locality = "local";
  } else if ((localBest?.merit ?? 0) + bias >= (cloudBest?.merit ?? 0)) {
    lane = local;
    locality = "local";
  } else {
    lane = cloud;
    locality = "cloud";
  }

  const selected = selectQuotaAwareAdaptiveCandidate(lane, context);
  const selectedMerit =
    locality === "local" ? (localBest?.merit ?? selected.score) : (cloudBest?.merit ?? selected.score);
  recordDecision({
    taskType,
    selected,
    locality,
    localCandidates: local.length,
    cloudCandidates: cloud.length,
    selectedMerit,
  });
  const explained = appendHybridReason(
    selected,
    locality,
    policy,
    localBest?.merit ?? null,
    cloudBest?.merit ?? null,
    bias
  );

  return {
    ...explained,
    locality,
    policy,
    localCandidates: local.length,
    cloudCandidates: cloud.length,
    localMerit: localBest?.merit ?? null,
    cloudMerit: cloudBest?.merit ?? null,
  };
}

export function getHybridLocalCloudSnapshot(): HybridLocalCloudSnapshot {
  const tasks = [...taskObservations.values()]
    .map((value) => ({ ...value }))
    .sort((a, b) => b.decisions - a.decisions || b.updatedAt - a.updatedAt);
  const models = [...modelObservations.values()]
    .map((value) => ({ ...value }))
    .sort((a, b) => b.selections - a.selections || b.updatedAt - a.updatedAt)
    .slice(0, 50);

  let decisions = 0;
  let mixedPools = 0;
  let localSelections = 0;
  let cloudSelections = 0;
  let localOffloads = 0;
  let cloudFallbacks = 0;
  let localCandidatesSeen = 0;
  let cloudCandidatesSeen = 0;
  for (const task of tasks) {
    decisions += task.decisions;
    mixedPools += task.mixedPools;
    localSelections += task.localSelections;
    cloudSelections += task.cloudSelections;
    localOffloads += task.localOffloads;
    cloudFallbacks += task.cloudFallbacks;
    localCandidatesSeen += task.localCandidatesSeen;
    cloudCandidatesSeen += task.cloudCandidatesSeen;
  }

  return {
    generatedAt: Date.now(),
    enabled: hybridEnabled(),
    policy: resolveHybridRoutingPolicy(),
    explicitLocalProviderCount: explicitLocalProviderIds().size,
    summary: {
      decisions,
      mixedPools,
      localSelections,
      cloudSelections,
      localOffloads,
      cloudFallbacks,
      localCandidatesSeen,
      cloudCandidatesSeen,
      modelCount: new Set(models.map((model) => `${model.provider}\u0000${model.model}`)).size,
      providerCount: new Set(models.map((model) => model.provider)).size,
      taskCount: tasks.length,
    },
    tasks: tasks.slice(0, 50),
    models,
  };
}

/** Test/ops hook. Hybrid telemetry is intentionally ephemeral. */
export function resetHybridLocalCloud(): void {
  modelObservations.clear();
  taskObservations.clear();
}
