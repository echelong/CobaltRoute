/**
 * CobaltRoute Free-Model Discovery + Qualification
 *
 * Turns OmniRoute's existing live model-sync catalog into a conservative
 * admission pipeline for newly discovered free models. Known release-catalog
 * free models are trusted immediately. Novel free candidates enter probation,
 * can be sampled by Multi-Model Race, and are promoted only after verified
 * successful outcomes. Quality/model-compatibility failures can quarantine a
 * candidate; quota/network failures stay non-poisoning.
 *
 * The persistent store contains aggregate provider/model qualification state
 * only. It never stores prompts, responses, credentials or connection ids.
 *
 * Built by Cobalt.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { on } from "@/lib/events/eventBus";
import {
  FREE_MODEL_BUDGETS,
  grantsFreeAccess,
} from "@omniroute/open-sse/config/freeModelCatalog.ts";
import { classifyTier } from "@omniroute/open-sse/services/tierResolver.ts";

const STORE_VERSION = 1;
const MAX_ENTRIES = 2_000;
const DEFAULT_QUALIFY_SUCCESSES = 2;
const DEFAULT_QUARANTINE_FAILURES = 2;
const DEFAULT_RECOVERY_SUCCESSES = 3;

type QualificationStatus = "probation" | "qualified" | "quarantined";
export type FreeModelQualificationState = "trusted" | QualificationStatus | "unknown";

export interface FreeModelQualificationEntry {
  provider: string;
  model: string;
  status: QualificationStatus;
  source: string;
  discoveries: number;
  successfulProbes: number;
  qualityFailures: number;
  operationalFailures: number;
  consecutiveSuccesses: number;
  lastReason: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastOutcomeAt: number;
  updatedAt: number;
}

export interface FreeModelDiscoverySnapshot {
  generatedAt: number;
  enabled: boolean;
  summary: {
    modelCount: number;
    probation: number;
    qualified: number;
    quarantined: number;
    successfulProbes: number;
    qualityFailures: number;
    operationalFailures: number;
    failOpenSelections: number;
  };
  models: FreeModelQualificationEntry[];
}

export interface QualificationCandidate {
  provider: string;
  model: string;
  costPer1MTokens?: number;
  accountTier?: string;
  isFree?: boolean;
}

export type FreeModelQualificationOutcome = "success" | "quality_failure" | "operational_failure";

const entries = new Map<string, FreeModelQualificationEntry>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let failOpenSelections = 0;

function normalize(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeModel(provider: string, model: string): string {
  const p = normalize(provider);
  const raw = normalize(model);
  for (const separator of ["/", ":"]) {
    const prefix = `${p}${separator}`;
    if (p && raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return raw;
}

function entryKey(provider: string, model: string): string {
  return `${normalize(provider)}\u0000${normalizeModel(provider, model)}`;
}

function enabled(): boolean {
  return process.env.COBALTROUTE_FREE_MODEL_DISCOVERY !== "0";
}

function persistenceEnabled(): boolean {
  return process.env.COBALTROUTE_DISCOVERY_PERSIST !== "0";
}

export function getFreeModelDiscoveryStorePath(): string {
  const override = process.env.COBALTROUTE_DISCOVERY_STORE_PATH?.trim();
  return override || join(process.cwd(), ".data", "cobaltroute", "free-model-discovery.json");
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function qualificationSuccessThreshold(): number {
  return positiveInt(
    process.env.COBALTROUTE_DISCOVERY_QUALIFY_SUCCESSES,
    DEFAULT_QUALIFY_SUCCESSES
  );
}

function quarantineFailureThreshold(): number {
  return positiveInt(
    process.env.COBALTROUTE_DISCOVERY_QUARANTINE_FAILURES,
    DEFAULT_QUARANTINE_FAILURES
  );
}

function recoverySuccessThreshold(): number {
  return positiveInt(
    process.env.COBALTROUTE_DISCOVERY_RECOVERY_SUCCESSES,
    DEFAULT_RECOVERY_SUCCESSES
  );
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled()) return;
  const path = getFreeModelDiscoveryStorePath();
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: number;
      entries?: FreeModelQualificationEntry[];
    };
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.entries)) return;
    for (const entry of parsed.entries) {
      if (!entry?.provider || !entry?.model) continue;
      if (
        entry.status !== "probation" &&
        entry.status !== "qualified" &&
        entry.status !== "quarantined"
      ) {
        continue;
      }
      entries.set(entryKey(entry.provider, entry.model), { ...entry });
    }
  } catch {
    // Corrupt qualification state must never block routing. Start cold instead.
  }
}

function persistNow(): void {
  if (!persistenceEnabled()) return;
  const path = getFreeModelDiscoveryStorePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          version: STORE_VERSION,
          updatedAt: Date.now(),
          entries: [...entries.values()],
        },
        null,
        2
      )
    );
    renameSync(tmp, path);
  } catch {
    // Qualification persistence is advisory. Runtime routing must remain usable.
  }
}

function schedulePersist(): void {
  if (!persistenceEnabled()) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 250);
  persistTimer.unref?.();
}

function pruneEntries(): void {
  if (entries.size <= MAX_ENTRIES) return;
  const oldest = [...entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
  if (oldest) entries.delete(oldest[0]);
}

export function isKnownCatalogFreeModel(provider: string, model: string): boolean {
  const providerId = normalize(provider);
  const modelId = normalizeModel(provider, model);
  return FREE_MODEL_BUDGETS.some(
    (entry) =>
      normalize(entry.provider) === providerId &&
      normalizeModel(entry.provider, entry.modelId) === modelId &&
      grantsFreeAccess(entry.freeType)
  );
}

export function isFreeModelCandidate(candidate: QualificationCandidate): boolean {
  if (candidate.isFree === true) return true;
  if (candidate.accountTier?.toLowerCase() === "free") return true;
  if (
    typeof candidate.costPer1MTokens === "number" &&
    Number.isFinite(candidate.costPer1MTokens) &&
    candidate.costPer1MTokens <= 0
  ) {
    return true;
  }
  if (isKnownCatalogFreeModel(candidate.provider, candidate.model)) return true;
  try {
    return (
      classifyTier(candidate.provider, normalizeModel(candidate.provider, candidate.model)).tier ===
      "free"
    );
  } catch {
    return false;
  }
}

export function registerDiscoveredFreeModel(
  provider: string,
  model: string,
  source = "runtime"
): FreeModelQualificationEntry | null {
  if (!enabled()) return null;
  if (!provider || !model || isKnownCatalogFreeModel(provider, model)) return null;
  ensureLoaded();
  const key = entryKey(provider, model);
  const now = Date.now();
  const current = entries.get(key);
  if (current) {
    current.discoveries += 1;
    current.lastSeenAt = now;
    current.updatedAt = now;
    if (source) current.source = source;
    schedulePersist();
    return { ...current };
  }
  const entry: FreeModelQualificationEntry = {
    provider,
    model: normalizeModel(provider, model),
    status: "probation",
    source,
    discoveries: 1,
    successfulProbes: 0,
    qualityFailures: 0,
    operationalFailures: 0,
    consecutiveSuccesses: 0,
    lastReason: null,
    firstSeenAt: now,
    lastSeenAt: now,
    lastOutcomeAt: 0,
    updatedAt: now,
  };
  entries.set(key, entry);
  pruneEntries();
  schedulePersist();
  return { ...entry };
}

export function registerSyncedFreeModels(
  provider: string,
  models: Array<{ id: string; isFree?: boolean }>
): number {
  if (!enabled()) return 0;
  let discovered = 0;
  for (const model of models) {
    if (!model?.id) continue;
    if (
      !isFreeModelCandidate({
        provider,
        model: model.id,
        ...(typeof model.isFree === "boolean" ? { isFree: model.isFree } : {}),
      })
    ) {
      continue;
    }
    if (isKnownCatalogFreeModel(provider, model.id)) continue;
    registerDiscoveredFreeModel(provider, model.id, "model-sync");
    discovered += 1;
  }
  return discovered;
}

function stateForCandidate(candidate: QualificationCandidate): FreeModelQualificationState {
  if (!isFreeModelCandidate(candidate)) return "trusted";
  if (isKnownCatalogFreeModel(candidate.provider, candidate.model)) return "trusted";

  // Qualification applies only after V6 has actually discovered the model
  // through model sync or an explicit qualification probe. An arbitrary
  // free-looking runtime candidate must not silently become probation here:
  // doing so would change the behaviour of existing OmniRoute/V5 pools before
  // discovery has observed them.
  ensureLoaded();
  return entries.get(entryKey(candidate.provider, candidate.model))?.status ?? "unknown";
}

export function getFreeModelQualificationState(
  provider: string,
  model: string
): FreeModelQualificationState {
  if (isKnownCatalogFreeModel(provider, model)) return "trusted";
  ensureLoaded();
  return entries.get(entryKey(provider, model))?.status ?? "unknown";
}

/**
 * Admission gate used by CobaltRoute routing.
 *
 * - known catalog free models and already-qualified discoveries pass;
 * - quarantined discoveries never pass;
 * - normal adaptive routing holds probation models when a trusted alternative exists;
 * - race mode may admit a bounded probation sample (normally one) beside trusted models;
 * - if probation is literally the only non-quarantined capacity, fail open to preserve
 *   availability while still tracking the candidate as probation.
 */
export function filterFreeModelQualificationPool<T extends QualificationCandidate>(
  pool: T[],
  options: { allowProbation?: boolean; maxProbation?: number } = {}
): T[] {
  if (!enabled() || pool.length === 0) return pool;
  const classified = pool.map((candidate) => ({ candidate, state: stateForCandidate(candidate) }));
  // Unknown means V6 has not discovered/claimed this model yet. Preserve
  // pre-V6 routing for those candidates; only tracked probation/quarantine
  // entries are subject to qualification admission policy.
  const safe = classified.filter(
    (entry) => entry.state === "trusted" || entry.state === "qualified" || entry.state === "unknown"
  );
  const probation = classified.filter((entry) => entry.state === "probation");

  const result = safe.map((entry) => entry.candidate);
  if (options.allowProbation === true && probation.length > 0) {
    const maxProbation = Math.max(0, Math.floor(options.maxProbation ?? 1));
    result.push(...probation.slice(0, maxProbation).map((entry) => entry.candidate));
  }

  if (result.length > 0) return result;

  // Do not turn discovery into an outage if a deployment has only brand-new free
  // capacity. Quarantined entries remain excluded; probation-only capacity may run.
  const failOpen = probation.map((entry) => entry.candidate);
  if (failOpen.length > 0) {
    failOpenSelections += 1;
    return failOpen;
  }
  return [];
}

export function recordFreeModelQualificationOutcome(input: {
  provider: string;
  model: string;
  outcome: FreeModelQualificationOutcome;
  reason?: string;
}): FreeModelQualificationEntry | null {
  if (!enabled() || !input.provider || !input.model) return null;
  if (isKnownCatalogFreeModel(input.provider, input.model)) return null;
  ensureLoaded();
  let entry = entries.get(entryKey(input.provider, input.model));
  if (!entry) {
    registerDiscoveredFreeModel(input.provider, input.model, "probe");
    entry = entries.get(entryKey(input.provider, input.model));
  }
  if (!entry) return null;

  const now = Date.now();
  entry.lastOutcomeAt = now;
  entry.lastSeenAt = now;
  entry.updatedAt = now;
  entry.lastReason = input.reason?.slice(0, 240) || null;

  if (input.outcome === "success") {
    entry.successfulProbes += 1;
    entry.consecutiveSuccesses += 1;
    if (entry.status === "quarantined") {
      if (entry.consecutiveSuccesses >= recoverySuccessThreshold()) {
        entry.status = "qualified";
        entry.qualityFailures = 0;
      }
    } else if (entry.consecutiveSuccesses >= qualificationSuccessThreshold()) {
      entry.status = "qualified";
    }
  } else if (input.outcome === "quality_failure") {
    entry.qualityFailures += 1;
    entry.consecutiveSuccesses = 0;
    if (entry.qualityFailures >= quarantineFailureThreshold()) {
      entry.status = "quarantined";
    }
  } else {
    entry.operationalFailures += 1;
    // Quota, timeout and network failures do not say anything about model quality.
  }

  schedulePersist();
  return { ...entry };
}

function classifyAutomaticFailure(error: string): FreeModelQualificationOutcome {
  const normalized = String(error || "").toLowerCase();
  if (
    /quality|malformed|invalid tool|tool.*invalid|schema|empty response|empty content|model.*not found|unsupported model|invalid model/.test(
      normalized
    )
  ) {
    return "quality_failure";
  }
  return "operational_failure";
}

declare global {
  var __cobaltFreeModelDiscoveryListenersInitialized: boolean | undefined;
}

function initAutomaticQualificationLearning(): void {
  if (globalThis.__cobaltFreeModelDiscoveryListenersInitialized) return;
  globalThis.__cobaltFreeModelDiscoveryListenersInitialized = true;

  on("combo.target.succeeded", (payload) => {
    if (getFreeModelQualificationState(payload.provider, payload.model) === "unknown") return;
    recordFreeModelQualificationOutcome({
      provider: payload.provider,
      model: payload.model,
      outcome: "success",
      reason: "validated combo success",
    });
  });

  on("combo.target.failed", (payload) => {
    if (getFreeModelQualificationState(payload.provider, payload.model) === "unknown") return;
    recordFreeModelQualificationOutcome({
      provider: payload.provider,
      model: payload.model,
      outcome: classifyAutomaticFailure(payload.error),
      reason: payload.error,
    });
  });
}

initAutomaticQualificationLearning();

export function getFreeModelDiscoverySnapshot(): FreeModelDiscoverySnapshot {
  ensureLoaded();
  const values = [...entries.values()];
  let probation = 0;
  let qualified = 0;
  let quarantined = 0;
  let successfulProbes = 0;
  let qualityFailures = 0;
  let operationalFailures = 0;

  for (const entry of values) {
    if (entry.status === "probation") probation += 1;
    else if (entry.status === "qualified") qualified += 1;
    else quarantined += 1;
    successfulProbes += entry.successfulProbes;
    qualityFailures += entry.qualityFailures;
    operationalFailures += entry.operationalFailures;
  }

  return {
    generatedAt: Date.now(),
    enabled: enabled(),
    summary: {
      modelCount: values.length,
      probation,
      qualified,
      quarantined,
      successfulProbes,
      qualityFailures,
      operationalFailures,
      failOpenSelections,
    },
    models: values
      .map((entry) => ({ ...entry }))
      .sort(
        (a, b) =>
          Number(b.status === "qualified") - Number(a.status === "qualified") ||
          b.updatedAt - a.updatedAt
      )
      .slice(0, 100),
  };
}

export function flushFreeModelDiscoveryNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow();
}

/** Test/ops hook. Does not delete an existing persisted file. */
export function resetFreeModelDiscovery(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  entries.clear();
  failOpenSelections = 0;
  loaded = true;
}
