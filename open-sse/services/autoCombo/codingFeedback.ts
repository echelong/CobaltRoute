/**
 * CobaltRoute deterministic coding feedback.
 *
 * Converts objective verifier outcomes (tests, builds, typechecks, lint,
 * schemas, tool calls and patch validation) into one bounded adaptive reward.
 * Only aggregate verifier statistics are persisted; command output, prompts,
 * responses and source code are never stored here.
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
import { recordAdaptiveOutcome, type AdaptiveLearningEntry } from "./adaptiveRouter.ts";
import { clamp01 } from "../../utils/number.ts";

const STORE_VERSION = 1;
const MAX_AGGREGATES = 2_500;
const MAX_RECENT_VERIFICATION_IDS = 1_000;
const REWARD_EWMA_ALPHA = 0.25;

export type CodingVerificationKind =
  | "test"
  | "build"
  | "typecheck"
  | "lint"
  | "schema"
  | "tool"
  | "patch"
  | "custom";

export type CodingVerificationStatus = "pass" | "fail" | "partial" | "skipped";

export interface CodingVerificationCheck {
  kind: CodingVerificationKind;
  status: CodingVerificationStatus;
  /** Optional relative importance. Bounded to 0.1..2.0. */
  weight?: number;
}

export interface CodingVerificationReportInput {
  provider: string;
  model: string;
  /** Defaults to coding. */
  taskType?: string;
  /** Optional idempotency key. Reusing it does not learn twice. */
  verificationId?: string;
  checks: CodingVerificationCheck[];
}

export interface CodingFeedbackAggregate {
  taskType: string;
  provider: string;
  model: string;
  reports: number;
  checks: number;
  passed: number;
  failed: number;
  partial: number;
  skipped: number;
  rewardMean: number;
  rewardEwma: number;
  lastReward: number;
  lastVerifiedAt: number;
  updatedAt: number;
}

export interface CodingFeedbackKindSummary {
  kind: CodingVerificationKind;
  checks: number;
  passed: number;
  failed: number;
  partial: number;
  skipped: number;
}

export interface CodingFeedbackSnapshot {
  generatedAt: number;
  summary: {
    reports: number;
    checks: number;
    passed: number;
    failed: number;
    partial: number;
    skipped: number;
    objectiveSuccessRate: number;
    modelCount: number;
    taskCount: number;
  };
  byKind: CodingFeedbackKindSummary[];
  leaders: Array<CodingFeedbackAggregate & { objectiveSuccessRate: number }>;
}

export interface CodingVerificationResult {
  duplicate: boolean;
  reward: number | null;
  checksApplied: number;
  adaptiveEntry: AdaptiveLearningEntry | null;
  aggregate: CodingFeedbackAggregate | null;
}

interface PersistedCodingFeedbackStore {
  version: number;
  updatedAt: number;
  aggregates: CodingFeedbackAggregate[];
  recentVerificationIds: string[];
  byKind: CodingFeedbackKindSummary[];
}

const DEFAULT_KIND_WEIGHTS: Record<CodingVerificationKind, number> = {
  test: 1,
  build: 1,
  typecheck: 0.9,
  lint: 0.6,
  schema: 0.9,
  tool: 0.9,
  patch: 0.8,
  custom: 0.75,
};

const aggregates = new Map<string, CodingFeedbackAggregate>();
const kindStats = new Map<CodingVerificationKind, CodingFeedbackKindSummary>();
const recentVerificationIds: string[] = [];
const recentVerificationIdSet = new Set<string>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeIdentity(value: string | null | undefined): string {
  return String(value || "").trim();
}

function normalizeTaskType(value: string | null | undefined): string {
  return normalizeIdentity(value).toLowerCase() || "coding";
}

function aggregateKey(taskType: string, provider: string, model: string): string {
  return `${normalizeTaskType(taskType)}\u0000${provider}\u0000${model}`;
}

function persistenceEnabled(): boolean {
  return process.env.COBALTROUTE_CODING_FEEDBACK_PERSIST !== "0";
}

export function getCodingFeedbackStorePath(): string {
  const configured = process.env.COBALTROUTE_CODING_FEEDBACK_STORE_PATH?.trim();
  return configured || join(process.cwd(), ".data", "cobaltroute", "coding-feedback.json");
}

function emptyKindSummary(kind: CodingVerificationKind): CodingFeedbackKindSummary {
  return { kind, checks: 0, passed: 0, failed: 0, partial: 0, skipped: 0 };
}

function defaultAggregate(
  taskType: string,
  provider: string,
  model: string
): CodingFeedbackAggregate {
  return {
    taskType: normalizeTaskType(taskType),
    provider,
    model,
    reports: 0,
    checks: 0,
    passed: 0,
    failed: 0,
    partial: 0,
    skipped: 0,
    rewardMean: 0.5,
    rewardEwma: 0.5,
    lastReward: 0.5,
    lastVerifiedAt: 0,
    updatedAt: Date.now(),
  };
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sanitizeAggregate(value: unknown): CodingFeedbackAggregate | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CodingFeedbackAggregate>;
  if (typeof raw.provider !== "string" || typeof raw.model !== "string") return null;

  return {
    taskType: normalizeTaskType(raw.taskType),
    provider: raw.provider,
    model: raw.model,
    reports: Math.floor(finiteNonNegative(raw.reports)),
    checks: Math.floor(finiteNonNegative(raw.checks)),
    passed: Math.floor(finiteNonNegative(raw.passed)),
    failed: Math.floor(finiteNonNegative(raw.failed)),
    partial: Math.floor(finiteNonNegative(raw.partial)),
    skipped: Math.floor(finiteNonNegative(raw.skipped)),
    rewardMean: clamp01(finiteNonNegative(raw.rewardMean, 0.5)),
    rewardEwma: clamp01(finiteNonNegative(raw.rewardEwma, 0.5)),
    lastReward: clamp01(finiteNonNegative(raw.lastReward, 0.5)),
    lastVerifiedAt: finiteNonNegative(raw.lastVerifiedAt),
    updatedAt: finiteNonNegative(raw.updatedAt, Date.now()),
  };
}

function isVerificationKind(value: unknown): value is CodingVerificationKind {
  return (
    value === "test" ||
    value === "build" ||
    value === "typecheck" ||
    value === "lint" ||
    value === "schema" ||
    value === "tool" ||
    value === "patch" ||
    value === "custom"
  );
}

function sanitizeKindSummary(value: unknown): CodingFeedbackKindSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CodingFeedbackKindSummary>;
  if (!isVerificationKind(raw.kind)) return null;
  return {
    kind: raw.kind,
    checks: Math.floor(finiteNonNegative(raw.checks)),
    passed: Math.floor(finiteNonNegative(raw.passed)),
    failed: Math.floor(finiteNonNegative(raw.failed)),
    partial: Math.floor(finiteNonNegative(raw.partial)),
    skipped: Math.floor(finiteNonNegative(raw.skipped)),
  };
}

function rememberVerificationId(id: string): void {
  if (!id || recentVerificationIdSet.has(id)) return;
  recentVerificationIds.push(id);
  recentVerificationIdSet.add(id);
  while (recentVerificationIds.length > MAX_RECENT_VERIFICATION_IDS) {
    const removed = recentVerificationIds.shift();
    if (removed) recentVerificationIdSet.delete(removed);
  }
}

function loadIfNeeded(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled()) return;

  const path = getCodingFeedbackStorePath();
  if (!existsSync(path)) return;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedCodingFeedbackStore>;
    if (parsed.version !== STORE_VERSION) return;

    if (Array.isArray(parsed.aggregates)) {
      for (const raw of parsed.aggregates.slice(0, MAX_AGGREGATES)) {
        const aggregate = sanitizeAggregate(raw);
        if (!aggregate) continue;
        aggregates.set(
          aggregateKey(aggregate.taskType, aggregate.provider, aggregate.model),
          aggregate
        );
      }
    }

    if (Array.isArray(parsed.byKind)) {
      for (const raw of parsed.byKind) {
        const summary = sanitizeKindSummary(raw);
        if (summary) kindStats.set(summary.kind, summary);
      }
    }

    if (Array.isArray(parsed.recentVerificationIds)) {
      for (const raw of parsed.recentVerificationIds.slice(-MAX_RECENT_VERIFICATION_IDS)) {
        if (typeof raw === "string" && raw.trim()) rememberVerificationId(raw.trim());
      }
    }
  } catch {
    // Verifier history is best-effort and must never interrupt routing.
  }
}

function pruneAggregates(): void {
  if (aggregates.size <= MAX_AGGREGATES) return;
  const ordered = [...aggregates.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const count = aggregates.size - MAX_AGGREGATES;
  for (let index = 0; index < count; index += 1) {
    const key = ordered[index]?.[0];
    if (key) aggregates.delete(key);
  }
}

function persistNow(): void {
  if (!persistenceEnabled()) return;
  loadIfNeeded();
  pruneAggregates();

  try {
    const path = getCodingFeedbackStorePath();
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp`;
    const payload: PersistedCodingFeedbackStore = {
      version: STORE_VERSION,
      updatedAt: Date.now(),
      aggregates: [...aggregates.values()],
      recentVerificationIds: [...recentVerificationIds],
      byKind: [...kindStats.values()],
    };
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch {
    // Do not let observability persistence affect request handling.
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

export function flushCodingFeedbackNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow();
}

function boundedWeight(check: CodingVerificationCheck): number {
  const configured = Number(check.weight);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(2, Math.max(0.1, configured));
  }
  return DEFAULT_KIND_WEIGHTS[check.kind];
}

function statusScore(status: CodingVerificationStatus): number | null {
  if (status === "pass") return 1;
  if (status === "fail") return 0;
  if (status === "partial") return 0.5;
  return null;
}

function updateKindStats(check: CodingVerificationCheck): void {
  const summary = kindStats.get(check.kind) || emptyKindSummary(check.kind);
  summary.checks += 1;
  if (check.status === "pass") summary.passed += 1;
  else if (check.status === "fail") summary.failed += 1;
  else if (check.status === "partial") summary.partial += 1;
  else summary.skipped += 1;
  kindStats.set(check.kind, summary);
}

function objectiveSuccessRate(aggregate: CodingFeedbackAggregate): number {
  const scored = aggregate.passed + aggregate.failed + aggregate.partial;
  if (scored === 0) return 0;
  return clamp01((aggregate.passed + aggregate.partial * 0.5) / scored);
}

/**
 * Record one objective coding verification report as exactly one adaptive
 * semantic observation, regardless of how many checks the report contains.
 */
export function recordCodingVerification(
  input: CodingVerificationReportInput
): CodingVerificationResult {
  loadIfNeeded();

  const provider = normalizeIdentity(input.provider);
  const model = normalizeIdentity(input.model);
  const taskType = normalizeTaskType(input.taskType);
  const verificationId = normalizeIdentity(input.verificationId);

  if (!provider || !model) {
    throw new Error("provider and model are required");
  }
  if (!Array.isArray(input.checks) || input.checks.length === 0) {
    throw new Error("at least one verification check is required");
  }
  if (input.checks.length > 64) {
    throw new Error("a verification report may contain at most 64 checks");
  }

  if (verificationId && recentVerificationIdSet.has(verificationId)) {
    return {
      duplicate: true,
      reward: null,
      checksApplied: 0,
      adaptiveEntry: null,
      aggregate:
        aggregates.get(aggregateKey(taskType, provider, model)) ?? null,
    };
  }

  let weightedScore = 0;
  let totalWeight = 0;
  let checksApplied = 0;
  let passed = 0;
  let failed = 0;
  let partial = 0;
  let skipped = 0;

  for (const check of input.checks) {
    if (!isVerificationKind(check?.kind)) {
      throw new Error(`unsupported verification kind: ${String(check?.kind)}`);
    }
    if (
      check.status !== "pass" &&
      check.status !== "fail" &&
      check.status !== "partial" &&
      check.status !== "skipped"
    ) {
      throw new Error(`unsupported verification status: ${String(check?.status)}`);
    }

    updateKindStats(check);
    if (check.status === "pass") passed += 1;
    else if (check.status === "fail") failed += 1;
    else if (check.status === "partial") partial += 1;
    else skipped += 1;

    const score = statusScore(check.status);
    if (score === null) continue;
    const weight = boundedWeight(check);
    weightedScore += score * weight;
    totalWeight += weight;
    checksApplied += 1;
  }

  if (checksApplied === 0 || totalWeight <= 0) {
    throw new Error("verification report must contain at least one non-skipped check");
  }

  const reward = clamp01(weightedScore / totalWeight);
  const key = aggregateKey(taskType, provider, model);
  const aggregate = aggregates.get(key) || defaultAggregate(taskType, provider, model);
  const now = Date.now();

  aggregate.reports += 1;
  aggregate.checks += input.checks.length;
  aggregate.passed += passed;
  aggregate.failed += failed;
  aggregate.partial += partial;
  aggregate.skipped += skipped;
  aggregate.rewardMean += (reward - aggregate.rewardMean) / aggregate.reports;
  aggregate.rewardEwma =
    aggregate.reports === 1
      ? reward
      : aggregate.rewardEwma + REWARD_EWMA_ALPHA * (reward - aggregate.rewardEwma);
  aggregate.lastReward = reward;
  aggregate.lastVerifiedAt = now;
  aggregate.updatedAt = now;
  aggregates.set(key, aggregate);

  if (verificationId) rememberVerificationId(verificationId);

  const adaptiveEntry = recordAdaptiveOutcome({ taskType, provider, model, reward });
  schedulePersist();

  return {
    duplicate: false,
    reward,
    checksApplied,
    adaptiveEntry,
    aggregate: { ...aggregate },
  };
}

export function getCodingFeedbackSnapshot(): CodingFeedbackSnapshot {
  loadIfNeeded();
  const values = [...aggregates.values()];
  let reports = 0;
  let checks = 0;
  let passed = 0;
  let failed = 0;
  let partial = 0;
  let skipped = 0;
  const models = new Set<string>();
  const tasks = new Set<string>();

  for (const aggregate of values) {
    reports += aggregate.reports;
    checks += aggregate.checks;
    passed += aggregate.passed;
    failed += aggregate.failed;
    partial += aggregate.partial;
    skipped += aggregate.skipped;
    models.add(`${aggregate.provider}\u0000${aggregate.model}`);
    tasks.add(aggregate.taskType);
  }

  const scoredChecks = passed + failed + partial;
  const successRate =
    scoredChecks > 0 ? clamp01((passed + partial * 0.5) / scoredChecks) : 0;

  return {
    generatedAt: Date.now(),
    summary: {
      reports,
      checks,
      passed,
      failed,
      partial,
      skipped,
      objectiveSuccessRate: successRate,
      modelCount: models.size,
      taskCount: tasks.size,
    },
    byKind: [...kindStats.values()].sort(
      (a, b) => b.checks - a.checks || a.kind.localeCompare(b.kind)
    ),
    leaders: values
      .map((aggregate) => ({
        ...aggregate,
        objectiveSuccessRate: objectiveSuccessRate(aggregate),
      }))
      .sort(
        (a, b) =>
          b.objectiveSuccessRate - a.objectiveSuccessRate ||
          b.reports - a.reports ||
          b.checks - a.checks
      )
      .slice(0, 50),
  };
}

/** Test/ops hook. Does not delete the persisted file. */
export function resetCodingFeedback(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  aggregates.clear();
  kindStats.clear();
  recentVerificationIds.length = 0;
  recentVerificationIdSet.clear();
  loaded = true;
}
