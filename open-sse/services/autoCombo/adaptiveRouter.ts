/**
 * Cobalt Adaptive Router
 *
 * Task-aware contextual routing layered on top of OmniRoute's existing
 * 16-factor scorer. The adaptive layer never stores prompts or responses.
 * It persists only aggregate provider/model/task statistics.
 *
 * Built by Cobalt.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { on } from "@/lib/events/eventBus";
import type { ProviderCandidate, ScoringWeights } from "./scoring.ts";
import { scorePool } from "./scoring.ts";
import { getTaskFitness } from "./taskFitness.ts";
import { clamp01 } from "../../utils/number.ts";

const STORE_VERSION = 1;
const MAX_ENTRIES = 5_000;
const REWARD_ALPHA = 0.25;
const PROXY_ALPHA = 0.15;
const DEFAULT_EXPLORATION_RATE = 0.08;
const AUTOMATIC_SUCCESS_REWARD = 0.7;
const AUTOMATIC_QUALITY_FAILURE_REWARD = 0.08;
const AUTOMATIC_OPERATIONAL_FAILURE_REWARD = 0.48;
const AUTOMATIC_UNKNOWN_FAILURE_REWARD = 0.3;
const PENDING_SELECTION_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_PER_MODEL = 64;

export interface AdaptiveRoutingContext {
  taskType: string;
  weights?: ScoringWeights;
  explorationRate?: number;
}

export interface AdaptiveLearningEntry {
  taskType: string;
  provider: string;
  model: string;
  selections: number;
  observations: number;
  proxyObservations: number;
  rewardMean: number;
  rewardEwma: number;
  proxyEwma: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  lastSelectedAt: number;
  lastObservedAt: number;
  updatedAt: number;
}

export interface AdaptiveOutcomeInput {
  taskType: string;
  provider: string;
  model: string;
  /** Semantic/task reward in [0,1]. 1 = solved perfectly, 0 = failed. */
  reward: number;
}

export interface AdaptiveSelection {
  provider: string;
  model: string;
  connectionId?: string;
  score: number;
  reason: string;
  candidatesConsidered: number;
}

export interface AdaptiveBrainLeader {
  taskType: string;
  provider: string;
  model: string;
  learnedScore: number;
  rewardMean: number;
  rewardEwma: number;
  selections: number;
  observations: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  updatedAt: number;
}

export interface AdaptiveBrainSnapshot {
  generatedAt: number;
  summary: {
    taskCount: number;
    modelCount: number;
    providerCount: number;
    selections: number;
    observations: number;
    proxyObservations: number;
    positiveOutcomes: number;
    negativeOutcomes: number;
  };
  leaders: AdaptiveBrainLeader[];
  tasks: Array<{
    taskType: string;
    modelCount: number;
    selections: number;
    observations: number;
    leader: AdaptiveBrainLeader | null;
  }>;
}

interface PersistedStore {
  version: number;
  updatedAt: number;
  entries: AdaptiveLearningEntry[];
}

interface PendingSelection {
  taskType: string;
  provider: string;
  model: string;
  selectedAt: number;
}

const entries = new Map<string, AdaptiveLearningEntry>();
const pendingSelections = new Map<string, PendingSelection[]>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeTaskType(taskType: string | null | undefined): string {
  const normalized = String(taskType || "default").trim().toLowerCase();
  return normalized || "default";
}

function normalizeIdentity(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function normalizedModelForProvider(provider: string, model: string): string {
  const providerId = normalizeIdentity(provider);
  const raw = normalizeIdentity(model);
  if (!providerId || !raw) return raw;
  for (const separator of ["/", ":"]) {
    const prefix = `${providerId}${separator}`;
    if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return raw;
}

function learningKey(taskType: string, provider: string, model: string): string {
  return `${normalizeTaskType(taskType)}\u0000${provider}\u0000${model}`;
}

function executionKey(candidate: {
  provider: string;
  model: string;
  connectionId?: string;
}): string {
  return `${candidate.provider}\u0000${candidate.model}\u0000${candidate.connectionId || ""}`;
}

function pendingKey(provider: string, model: string): string {
  return `${normalizeIdentity(provider)}\u0000${normalizedModelForProvider(provider, model)}`;
}

function persistenceEnabled(): boolean {
  return process.env.COBALTROUTE_ADAPTIVE_PERSIST !== "0";
}

function automaticFeedbackEnabled(): boolean {
  return process.env.COBALTROUTE_AUTOMATIC_FEEDBACK !== "0";
}

export function getAdaptiveStorePath(): string {
  const configured = process.env.COBALTROUTE_ADAPTIVE_STORE_PATH?.trim();
  return configured || join(process.cwd(), ".data", "cobaltroute", "adaptive-learning.json");
}

function defaultEntry(taskType: string, provider: string, model: string): AdaptiveLearningEntry {
  return {
    taskType: normalizeTaskType(taskType),
    provider,
    model,
    selections: 0,
    observations: 0,
    proxyObservations: 0,
    rewardMean: 0.5,
    rewardEwma: 0.5,
    proxyEwma: 0.5,
    positiveOutcomes: 0,
    negativeOutcomes: 0,
    lastSelectedAt: 0,
    lastObservedAt: 0,
    updatedAt: Date.now(),
  };
}

function sanitizePersistedEntry(value: unknown): AdaptiveLearningEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AdaptiveLearningEntry>;
  if (typeof raw.provider !== "string" || typeof raw.model !== "string") return null;

  const taskType = normalizeTaskType(raw.taskType);
  const finite = (value: unknown, fallback = 0): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

  return {
    taskType,
    provider: raw.provider,
    model: raw.model,
    selections: Math.floor(finite(raw.selections)),
    observations: Math.floor(finite(raw.observations)),
    proxyObservations: Math.floor(finite(raw.proxyObservations)),
    rewardMean: clamp01(finite(raw.rewardMean, 0.5)),
    rewardEwma: clamp01(finite(raw.rewardEwma, 0.5)),
    proxyEwma: clamp01(finite(raw.proxyEwma, 0.5)),
    positiveOutcomes: Math.floor(finite(raw.positiveOutcomes)),
    negativeOutcomes: Math.floor(finite(raw.negativeOutcomes)),
    lastSelectedAt: finite(raw.lastSelectedAt),
    lastObservedAt: finite(raw.lastObservedAt),
    updatedAt: finite(raw.updatedAt, Date.now()),
  };
}

function loadIfNeeded(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled()) return;

  const path = getAdaptiveStorePath();
  if (!existsSync(path)) return;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedStore>;
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.entries)) return;

    for (const raw of parsed.entries.slice(0, MAX_ENTRIES)) {
      const entry = sanitizePersistedEntry(raw);
      if (!entry) continue;
      entries.set(learningKey(entry.taskType, entry.provider, entry.model), entry);
    }
  } catch {
    // Corrupt/missing local learning data must never break the data plane.
  }
}

function getOrCreate(taskType: string, provider: string, model: string): AdaptiveLearningEntry {
  loadIfNeeded();
  const key = learningKey(taskType, provider, model);
  const current = entries.get(key);
  if (current) return current;
  const created = defaultEntry(taskType, provider, model);
  entries.set(key, created);
  return created;
}

function pruneEntries(): void {
  if (entries.size <= MAX_ENTRIES) return;
  const ordered = [...entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const deleteCount = entries.size - MAX_ENTRIES;
  for (let index = 0; index < deleteCount; index += 1) {
    const key = ordered[index]?.[0];
    if (key) entries.delete(key);
  }
}

function persistNow(): void {
  if (!persistenceEnabled()) return;
  loadIfNeeded();
  pruneEntries();

  try {
    const path = getAdaptiveStorePath();
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp`;
    const payload: PersistedStore = {
      version: STORE_VERSION,
      updatedAt: Date.now(),
      entries: [...entries.values()],
    };
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch {
    // Learning persistence is best-effort. Routing must stay available.
  }
}

function schedulePersist(): void {
  if (!persistenceEnabled() || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 250);

  const timer = persistTimer as unknown as { unref?: () => void };
  timer.unref?.();
}

export function flushAdaptiveLearningNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow();
}

function registerPendingSelection(taskType: string, provider: string, model: string): void {
  const key = pendingKey(provider, model);
  const now = Date.now();
  const queue = (pendingSelections.get(key) || []).filter(
    (selection) => now - selection.selectedAt <= PENDING_SELECTION_TTL_MS
  );
  queue.push({ taskType, provider, model, selectedAt: now });
  if (queue.length > MAX_PENDING_PER_MODEL) {
    queue.splice(0, queue.length - MAX_PENDING_PER_MODEL);
  }
  pendingSelections.set(key, queue);
}

function consumePendingSelection(provider: string, model: string): PendingSelection | null {
  const key = pendingKey(provider, model);
  const now = Date.now();
  const queue = (pendingSelections.get(key) || []).filter(
    (selection) => now - selection.selectedAt <= PENDING_SELECTION_TTL_MS
  );
  const selection = queue.shift() || null;
  if (queue.length > 0) pendingSelections.set(key, queue);
  else pendingSelections.delete(key);
  return selection;
}

function recordSelection(taskType: string, provider: string, model: string): AdaptiveLearningEntry {
  const entry = getOrCreate(taskType, provider, model);
  const now = Date.now();
  entry.selections += 1;
  entry.lastSelectedAt = now;
  entry.updatedAt = now;
  registerPendingSelection(taskType, provider, model);
  schedulePersist();
  return entry;
}

function recordProxyObservation(
  taskType: string,
  provider: string,
  model: string,
  reward: number
): void {
  const entry = getOrCreate(taskType, provider, model);
  const boundedReward = clamp01(reward);
  entry.proxyObservations += 1;
  entry.proxyEwma =
    entry.proxyObservations === 1
      ? boundedReward
      : entry.proxyEwma + PROXY_ALPHA * (boundedReward - entry.proxyEwma);
  entry.lastObservedAt = Date.now();
  entry.updatedAt = entry.lastObservedAt;
  schedulePersist();
}

/**
 * Record a real task outcome from a deterministic evaluator, test/build result,
 * tool validation, user feedback, or another semantic success signal.
 */
export function recordAdaptiveOutcome(input: AdaptiveOutcomeInput): AdaptiveLearningEntry {
  const entry = getOrCreate(input.taskType, input.provider, input.model);
  const reward = clamp01(Number.isFinite(input.reward) ? input.reward : 0.5);

  entry.observations += 1;
  entry.rewardMean += (reward - entry.rewardMean) / entry.observations;
  entry.rewardEwma =
    entry.observations === 1
      ? reward
      : entry.rewardEwma + REWARD_ALPHA * (reward - entry.rewardEwma);
  if (reward >= 0.75) entry.positiveOutcomes += 1;
  if (reward <= 0.25) entry.negativeOutcomes += 1;
  entry.lastObservedAt = Date.now();
  entry.updatedAt = entry.lastObservedAt;
  schedulePersist();
  return { ...entry };
}

function learnedSignal(entry: AdaptiveLearningEntry): number {
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
  if (!Number.isFinite(rate) || rate < 0) return 1;
  return clamp01(1 - rate);
}

function isFreeLike(candidate: ProviderCandidate): boolean {
  return candidate.costPer1MTokens <= 0 || candidate.accountTier === "free";
}

function totalSelectionsForTask(taskType: string): number {
  loadIfNeeded();
  const normalized = normalizeTaskType(taskType);
  let total = 0;
  for (const entry of entries.values()) {
    if (entry.taskType === normalized) total += entry.selections;
  }
  return total;
}

function explorationSignal(totalSelections: number, candidateSelections: number): number {
  const raw = Math.sqrt((2 * Math.log(totalSelections + 2)) / (candidateSelections + 1));
  return clamp01(raw / 2);
}

/**
 * Select a provider/model using OmniRoute's normal scorer as the strong prior,
 * then adapt it using task-specific outcomes and UCB-style exploration.
 */
export function selectAdaptiveCandidate(
  pool: ProviderCandidate[],
  context: AdaptiveRoutingContext
): AdaptiveSelection {
  loadIfNeeded();
  const healthy = pool.filter((candidate) => candidate.circuitBreakerState !== "OPEN");
  let candidates = healthy.length > 0 ? healthy : pool;
  if (candidates.length === 0) throw new Error("[AdaptiveStrategy] No candidates available");

  // CobaltRoute is free-model-first by default. This only narrows the pool when
  // at least one explicitly free candidate exists, so providers whose free quota
  // is represented externally are not accidentally made unreachable.
  if (process.env.COBALTROUTE_FREE_ONLY !== "0") {
    const free = candidates.filter(isFreeLike);
    if (free.length > 0) candidates = free;
  }

  const taskType = normalizeTaskType(context.taskType);
  const baseRanked = scorePool(candidates, taskType, context.weights, getTaskFitness);
  const baseScores = new Map(baseRanked.map((item) => [executionKey(item), item.score]));
  const totalSelections = totalSelectionsForTask(taskType);
  const explorationWeight = clamp01(
    context.explorationRate == null ? DEFAULT_EXPLORATION_RATE : context.explorationRate
  );

  const ranked = candidates
    .map((candidate) => {
      const entry = getOrCreate(taskType, candidate.provider, candidate.model);
      const base = baseScores.get(executionKey(candidate)) ?? 0;
      const learned = learnedSignal(entry);
      const quality = clamp01(candidate.quality ?? 0.5);
      const reliability = reliabilitySignal(candidate);
      const taskFit = clamp01(getTaskFitness(candidate.model, taskType));
      const free = isFreeLike(candidate) ? 1 : 0;
      const ucb = explorationSignal(totalSelections, entry.selections);

      const exploitation =
        base * 0.48 +
        learned * 0.24 +
        quality * 0.1 +
        reliability * 0.08 +
        taskFit * 0.05 +
        free * 0.05;
      const score = clamp01((exploitation + ucb * explorationWeight) / (1 + explorationWeight));

      return {
        candidate,
        entry,
        base,
        learned,
        quality,
        reliability,
        taskFit,
        free,
        ucb,
        score,
      };
    })
    .sort((a, b) => b.score - a.score || b.base - a.base);

  const winner = ranked[0];
  if (!winner) throw new Error("[AdaptiveStrategy] No candidates available after scoring");

  recordSelection(taskType, winner.candidate.provider, winner.candidate.model);
  recordProxyObservation(
    taskType,
    winner.candidate.provider,
    winner.candidate.model,
    winner.taskFit * 0.45 + winner.quality * 0.3 + winner.reliability * 0.25
  );

  return {
    provider: winner.candidate.provider,
    model: winner.candidate.model,
    connectionId: winner.candidate.connectionId,
    score: winner.score,
    candidatesConsidered: ranked.length,
    reason:
      `AdaptiveStrategy(task=${taskType}, score=${winner.score.toFixed(3)}): ` +
      `base=${winner.base.toFixed(3)} learned=${winner.learned.toFixed(3)} ` +
      `quality=${winner.quality.toFixed(3)} reliability=${winner.reliability.toFixed(3)} ` +
      `taskFit=${winner.taskFit.toFixed(3)} ucb=${winner.ucb.toFixed(3)} ` +
      `pulls=${winner.entry.selections} outcomes=${winner.entry.observations} ` +
      `free=${winner.free === 1 ? "yes" : "no"}`,
  };
}

export function getAdaptiveLearningSnapshot(taskType?: string): AdaptiveLearningEntry[] {
  loadIfNeeded();
  const normalized = taskType == null ? null : normalizeTaskType(taskType);
  return [...entries.values()]
    .filter((entry) => normalized == null || entry.taskType === normalized)
    .map((entry) => ({ ...entry }))
    .sort(
      (a, b) =>
        a.taskType.localeCompare(b.taskType) ||
        b.observations - a.observations ||
        b.selections - a.selections ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model)
    );
}

function toBrainLeader(entry: AdaptiveLearningEntry): AdaptiveBrainLeader {
  return {
    taskType: entry.taskType,
    provider: entry.provider,
    model: entry.model,
    learnedScore: learnedSignal(entry),
    rewardMean: entry.rewardMean,
    rewardEwma: entry.rewardEwma,
    selections: entry.selections,
    observations: entry.observations,
    positiveOutcomes: entry.positiveOutcomes,
    negativeOutcomes: entry.negativeOutcomes,
    updatedAt: entry.updatedAt,
  };
}

export function getAdaptiveBrainSnapshot(): AdaptiveBrainSnapshot {
  const snapshot = getAdaptiveLearningSnapshot();
  const taskGroups = new Map<string, AdaptiveLearningEntry[]>();
  const providers = new Set<string>();
  const models = new Set<string>();

  let selections = 0;
  let observations = 0;
  let proxyObservations = 0;
  let positiveOutcomes = 0;
  let negativeOutcomes = 0;

  for (const entry of snapshot) {
    providers.add(entry.provider);
    models.add(`${entry.provider}\u0000${entry.model}`);
    selections += entry.selections;
    observations += entry.observations;
    proxyObservations += entry.proxyObservations;
    positiveOutcomes += entry.positiveOutcomes;
    negativeOutcomes += entry.negativeOutcomes;
    const group = taskGroups.get(entry.taskType) || [];
    group.push(entry);
    taskGroups.set(entry.taskType, group);
  }

  const tasks = [...taskGroups.entries()]
    .map(([taskType, group]) => {
      const ranked = [...group].sort(
        (a, b) =>
          learnedSignal(b) - learnedSignal(a) ||
          b.observations - a.observations ||
          b.selections - a.selections
      );
      const leader = ranked[0] ? toBrainLeader(ranked[0]) : null;
      return {
        taskType,
        modelCount: group.length,
        selections: group.reduce((sum, entry) => sum + entry.selections, 0),
        observations: group.reduce((sum, entry) => sum + entry.observations, 0),
        leader,
      };
    })
    .sort((a, b) => b.observations - a.observations || b.selections - a.selections);

  const leaders = snapshot
    .map(toBrainLeader)
    .sort(
      (a, b) =>
        b.learnedScore - a.learnedScore ||
        b.observations - a.observations ||
        b.selections - a.selections
    )
    .slice(0, 50);

  return {
    generatedAt: Date.now(),
    summary: {
      taskCount: taskGroups.size,
      modelCount: models.size,
      providerCount: providers.size,
      selections,
      observations,
      proxyObservations,
      positiveOutcomes,
      negativeOutcomes,
    },
    leaders,
    tasks,
  };
}

function automaticFailureReward(error: string): number {
  const normalized = String(error || "").toLowerCase();
  if (
    /quality|malformed|invalid tool|tool.*invalid|schema|empty response|empty content/.test(normalized)
  ) {
    return AUTOMATIC_QUALITY_FAILURE_REWARD;
  }
  if (
    /429|rate.?limit|quota|credit|cooldown|timeout|timed out|network|capacity|unavailable|503|504/.test(
      normalized
    )
  ) {
    return AUTOMATIC_OPERATIONAL_FAILURE_REWARD;
  }
  return AUTOMATIC_UNKNOWN_FAILURE_REWARD;
}

export function recordAutomaticAdaptiveOutcome(input: {
  provider: string;
  model: string;
  outcome: "success" | "failure";
  error?: string;
}): AdaptiveLearningEntry | null {
  if (!automaticFeedbackEnabled()) return null;
  const pending = consumePendingSelection(input.provider, input.model);
  if (!pending) return null;
  return recordAdaptiveOutcome({
    taskType: pending.taskType,
    provider: pending.provider,
    model: pending.model,
    reward:
      input.outcome === "success"
        ? AUTOMATIC_SUCCESS_REWARD
        : automaticFailureReward(input.error || ""),
  });
}

declare global {
  var __cobaltAdaptiveOutcomeListenersInitialized: boolean | undefined;
}

function initAutomaticOutcomeLearning(): void {
  if (globalThis.__cobaltAdaptiveOutcomeListenersInitialized) return;
  globalThis.__cobaltAdaptiveOutcomeListenersInitialized = true;

  on("combo.target.succeeded", (payload) => {
    recordAutomaticAdaptiveOutcome({
      provider: payload.provider,
      model: payload.model,
      outcome: "success",
    });
  });

  on("combo.target.failed", (payload) => {
    recordAutomaticAdaptiveOutcome({
      provider: payload.provider,
      model: payload.model,
      outcome: "failure",
      error: payload.error,
    });
  });
}

initAutomaticOutcomeLearning();

/** Test/ops hook. Does not delete the persisted file. */
export function resetAdaptiveLearning(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  entries.clear();
  pendingSelections.clear();
  loaded = true;
}
