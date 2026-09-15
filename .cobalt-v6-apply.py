from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    print(f"wrote {path}")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one replacement match, found {count}")
    write(path, text.replace(old, new, 1))


qualification = r'''/**
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
export type FreeModelQualificationState =
  | "trusted"
  | QualificationStatus
  | "unknown";

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

export type FreeModelQualificationOutcome =
  | "success"
  | "quality_failure"
  | "operational_failure";

const entries = new Map<string, FreeModelQualificationEntry>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let failOpenSelections = 0;

function normalize(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
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
    return classifyTier(candidate.provider, normalizeModel(candidate.provider, candidate.model)).tier === "free";
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
  ensureLoaded();
  const existing = entries.get(entryKey(candidate.provider, candidate.model));
  if (existing) return existing.status;
  const created = registerDiscoveredFreeModel(candidate.provider, candidate.model, "runtime");
  return created?.status ?? "unknown";
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
  const safe = classified.filter(
    (entry) => entry.state === "trusted" || entry.state === "qualified"
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
'''

api_route = r'''import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getFreeModelDiscoverySnapshot,
  recordFreeModelQualificationOutcome,
  type FreeModelQualificationOutcome,
} from "@/lib/discovery/freeModelQualification";

export const dynamic = "force-dynamic";

const OUTCOMES = new Set<FreeModelQualificationOutcome>([
  "success",
  "quality_failure",
  "operational_failure",
]);

/**
 * Management-only Router Brain view and explicit qualification-feedback seam.
 * No prompts, responses, credentials or connection ids are accepted or returned.
 *
 * Built by Cobalt.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;
  return NextResponse.json(getFreeModelDiscoverySnapshot(), {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }
  const value = body as Record<string, unknown>;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const outcome = typeof value.outcome === "string" ? value.outcome : "";
  const reason = typeof value.reason === "string" ? value.reason : undefined;

  if (!provider || !model || !OUTCOMES.has(outcome as FreeModelQualificationOutcome)) {
    return NextResponse.json(
      { error: "provider, model and a valid outcome are required" },
      { status: 400 }
    );
  }

  const entry = recordFreeModelQualificationOutcome({
    provider,
    model,
    outcome: outcome as FreeModelQualificationOutcome,
    ...(reason ? { reason } : {}),
  });

  return NextResponse.json({ entry, discovery: getFreeModelDiscoverySnapshot() });
}
'''

panel = r'''"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ModelEntry = {
  provider: string;
  model: string;
  status: "probation" | "qualified" | "quarantined";
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
};

type Snapshot = {
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
  models: ModelEntry[];
};

const EMPTY: Snapshot = {
  generatedAt: 0,
  enabled: true,
  summary: {
    modelCount: 0,
    probation: 0,
    qualified: 0,
    quarantined: 0,
    successfulProbes: 0,
    qualityFailures: 0,
    operationalFailures: 0,
    failOpenSelections: 0,
  },
  models: [],
};

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-xl border border-border/70 p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{new Intl.NumberFormat().format(value)}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

export default function FreeModelDiscoveryPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cobalt/free-model-discovery", { cache: "no-store" });
      if (!response.ok) throw new Error(`Free-model discovery API returned ${response.status}`);
      setSnapshot((await response.json()) as Snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load free-model discovery");
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load(), 0);
    const refreshTimer = window.setInterval(() => void load(), 5000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
    };
  }, [load]);

  const rows = useMemo(() => snapshot.models.slice(0, 20), [snapshot.models]);

  return (
    <section className="mx-auto w-full max-w-7xl px-4 pb-8 md:px-8">
      <div className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-6 md:p-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Automatic Free-Model Discovery v6
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                Qualification pipeline
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                Live provider model syncs can discover new free candidates automatically. New
                models enter probation, Race can trial one beside trusted contenders, verified
                successes promote them, and repeated quality or compatibility failures quarantine
                them without treating quota or network errors as model defects.
              </p>
            </div>
            <div className="text-xs text-muted-foreground">
              {snapshot.enabled ? "Discovery enabled" : "Discovery disabled"}
              {snapshot.generatedAt
                ? ` · updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`
                : ""}
            </div>
          </div>
        </div>

        {error ? (
          <div className="border-b border-border px-6 py-3 text-sm text-destructive md:px-8">
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-4 md:p-8">
          <Stat label="Discovered" value={snapshot.summary.modelCount} hint="Novel free models seen" />
          <Stat label="Probation" value={snapshot.summary.probation} hint="Awaiting verified evidence" />
          <Stat label="Qualified" value={snapshot.summary.qualified} hint="Admitted by evidence" />
          <Stat label="Quarantined" value={snapshot.summary.quarantined} hint="Held out after quality failures" />
        </div>

        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Model</th>
                <th className="px-6 py-3 font-medium">Provider</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Source</th>
                <th className="px-6 py-3 text-right font-medium">Success</th>
                <th className="px-6 py-3 text-right font-medium">Quality fail</th>
                <th className="px-6 py-3 text-right font-medium">Operational</th>
                <th className="px-6 py-3 font-medium">Latest evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-muted-foreground">
                    Waiting for a provider model sync to discover a novel free model.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={`${row.provider}:${row.model}`}>
                    <td className="max-w-80 truncate px-6 py-3 font-medium" title={row.model}>
                      {row.model}
                    </td>
                    <td className="px-6 py-3 text-muted-foreground">{row.provider}</td>
                    <td className="px-6 py-3 capitalize">{row.status}</td>
                    <td className="px-6 py-3 text-muted-foreground">{row.source}</td>
                    <td className="px-6 py-3 text-right">{row.successfulProbes}</td>
                    <td className="px-6 py-3 text-right">{row.qualityFailures}</td>
                    <td className="px-6 py-3 text-right">{row.operationalFailures}</td>
                    <td className="max-w-72 truncate px-6 py-3 text-muted-foreground" title={row.lastReason || ""}>
                      {row.lastReason || "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-border p-5 text-xs leading-5 text-muted-foreground md:px-8">
          Qualification persistence contains aggregate provider/model evidence only. CobaltRoute
          does not store prompts, responses, credentials or connection IDs in this discovery store.
        </div>
      </div>
    </section>
  );
}
'''

tests = r'''import test from "node:test";
import assert from "node:assert/strict";
import {
  filterFreeModelQualificationPool,
  getFreeModelDiscoverySnapshot,
  getFreeModelQualificationState,
  isKnownCatalogFreeModel,
  recordFreeModelQualificationOutcome,
  registerSyncedFreeModels,
  resetFreeModelDiscovery,
} from "../../src/lib/discovery/freeModelQualification.ts";
import {
  FREE_MODEL_BUDGETS,
  grantsFreeAccess,
} from "../../open-sse/config/freeModelCatalog.ts";

process.env.COBALTROUTE_DISCOVERY_PERSIST = "0";
process.env.COBALTROUTE_FREE_MODEL_DISCOVERY = "1";
process.env.COBALTROUTE_DISCOVERY_QUALIFY_SUCCESSES = "2";
process.env.COBALTROUTE_DISCOVERY_QUARANTINE_FAILURES = "2";

function candidate(provider: string, model: string) {
  return {
    provider,
    model,
    costPer1MTokens: 0,
    accountTier: "free",
  };
}

function reset() {
  resetFreeModelDiscovery();
}

test("release-catalog free models are trusted without probation", () => {
  reset();
  const known = FREE_MODEL_BUDGETS.find((entry) => grantsFreeAccess(entry.freeType));
  assert.ok(known);
  assert.equal(isKnownCatalogFreeModel(known.provider, known.modelId), true);
  assert.equal(getFreeModelQualificationState(known.provider, known.modelId), "trusted");
  assert.equal(getFreeModelDiscoverySnapshot().summary.modelCount, 0);
});

test("model sync automatically registers novel explicit-free models as probation", () => {
  reset();
  const count = registerSyncedFreeModels("cobalt-v6-sync", [
    { id: "new-free-model", isFree: true },
    { id: "paid-model", isFree: false },
  ]);
  assert.equal(count, 1);
  assert.equal(getFreeModelQualificationState("cobalt-v6-sync", "new-free-model"), "probation");
});

test("normal adaptive admission holds probation behind a qualified alternative", () => {
  reset();
  const qualified = candidate("cobalt-qualified", "stable-free");
  const probation = candidate("cobalt-probation", "new-free");

  recordFreeModelQualificationOutcome({
    provider: qualified.provider,
    model: qualified.model,
    outcome: "success",
  });
  recordFreeModelQualificationOutcome({
    provider: qualified.provider,
    model: qualified.model,
    outcome: "success",
  });

  const filtered = filterFreeModelQualificationPool([qualified, probation]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].provider, qualified.provider);
  assert.equal(getFreeModelQualificationState(probation.provider, probation.model), "probation");
});

test("race admission may trial at most one probation model beside trusted capacity", () => {
  reset();
  const known = FREE_MODEL_BUDGETS.find((entry) => grantsFreeAccess(entry.freeType));
  assert.ok(known);
  const trusted = candidate(known.provider, known.modelId);
  const probationA = candidate("cobalt-probation-a", "new-a");
  const probationB = candidate("cobalt-probation-b", "new-b");

  const filtered = filterFreeModelQualificationPool([trusted, probationA, probationB], {
    allowProbation: true,
    maxProbation: 1,
  });
  assert.equal(filtered.length, 2);
  assert.ok(filtered.some((entry) => entry.provider === trusted.provider));
  assert.equal(
    filtered.filter((entry) => entry.provider.startsWith("cobalt-probation")).length,
    1
  );
});

test("two verified successes promote a novel free model", () => {
  reset();
  const provider = "cobalt-promote";
  const model = "new-free";

  recordFreeModelQualificationOutcome({ provider, model, outcome: "success" });
  assert.equal(getFreeModelQualificationState(provider, model), "probation");
  recordFreeModelQualificationOutcome({ provider, model, outcome: "success" });
  assert.equal(getFreeModelQualificationState(provider, model), "qualified");
});

test("repeated quality failures quarantine but operational failures do not", () => {
  reset();
  const operationalProvider = "cobalt-operational";
  const qualityProvider = "cobalt-quality";
  const model = "new-free";

  recordFreeModelQualificationOutcome({
    provider: operationalProvider,
    model,
    outcome: "operational_failure",
    reason: "429 quota exhausted",
  });
  recordFreeModelQualificationOutcome({
    provider: operationalProvider,
    model,
    outcome: "operational_failure",
    reason: "network timeout",
  });
  assert.equal(getFreeModelQualificationState(operationalProvider, model), "probation");

  recordFreeModelQualificationOutcome({
    provider: qualityProvider,
    model,
    outcome: "quality_failure",
    reason: "malformed tool call",
  });
  recordFreeModelQualificationOutcome({
    provider: qualityProvider,
    model,
    outcome: "quality_failure",
    reason: "invalid schema",
  });
  assert.equal(getFreeModelQualificationState(qualityProvider, model), "quarantined");
});

test("discovery snapshot is aggregate-only", () => {
  reset();
  recordFreeModelQualificationOutcome({
    provider: "cobalt-private",
    model: "new-free",
    outcome: "success",
    reason: "validated combo success",
  });
  const serialized = JSON.stringify(getFreeModelDiscoverySnapshot());
  assert.equal(serialized.includes("connectionId"), false);
  assert.equal(serialized.includes("prompt"), false);
  assert.equal(serialized.includes("response"), false);
  assert.equal(serialized.includes("credential"), false);
});
'''

discovery_index = r'''/**
 * CobaltRoute / OmniRoute provider discovery service.
 *
 * V6 replaces the old Phase-1 placeholder scanner with a conservative scanner
 * built on OmniRoute's existing per-connection synchronized model catalogs.
 * No credential harvesting or arbitrary Internet crawling is performed here.
 *
 * Built by Cobalt.
 */

import { logger } from "../../../open-sse/utils/logger.ts";
import {
  FREE_MODEL_BUDGETS,
  grantsFreeAccess,
} from "../../../open-sse/config/freeModelCatalog.ts";
import {
  getCustomModels,
  getSyncedAvailableModelsByConnection,
} from "../db/models";
import {
  upsertDiscoveryResult as dbUpsertDiscoveryResult,
  getDiscoveryResults as dbGetDiscoveryResults,
  type DiscoveryResult as DbDiscoveryResult,
} from "../db/discoveryResults";
import {
  isFreeModelCandidate,
  registerDiscoveredFreeModel,
} from "./freeModelQualification";

const log = logger("DISCOVERY");

export interface DiscoveryConfig {
  enabled: boolean;
  scanInterval: number;
  maxConcurrentScans: number;
  targetProviders: string[];
  notificationWebhook?: string;
}

export interface DiscoveryResult {
  id?: number;
  providerId: string;
  method: "free_tier" | "web_cookie" | "auto_register" | "trial" | "public_api";
  endpoint?: string;
  authType: "none" | "cookie" | "api_key" | "oauth";
  models?: string[];
  rateLimit?: string;
  feasibility: number;
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
  status: "pending" | "testing" | "verified" | "rejected";
  notes?: string;
  discoveredAt?: string;
  verifiedAt?: string;
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  enabled: true,
  scanInterval: 24 * 60 * 60 * 1000,
  maxConcurrentScans: 3,
  targetProviders: [],
};

export async function probeEndpoint(
  url: string,
  signal?: AbortSignal
): Promise<{ accessible: boolean; status?: number; hasModels?: boolean }> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "CobaltRoute-Discovery/1.0" },
      signal,
    });
    return {
      accessible: res.ok,
      status: res.status,
      hasModels: res.ok && url.includes("/models"),
    };
  } catch {
    return { accessible: false };
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Scan the live synchronized catalog for one provider and register novel free
 * candidates with the V6 qualification engine.
 */
export async function scanProvider(
  providerId: string,
  _config: Partial<DiscoveryConfig> = {}
): Promise<DiscoveryResult[]> {
  const provider = providerId.trim();
  if (!provider) return [];

  const byConnection = await getSyncedAvailableModelsByConnection(provider);
  const synced = Object.values(byConnection).flat();
  const customRaw = await getCustomModels(provider);
  const custom = Array.isArray(customRaw) ? customRaw : [];
  const customFree = new Map<string, boolean>();
  for (const item of custom) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id === "string" && typeof row.isFree === "boolean") {
      customFree.set(normalize(row.id), row.isFree);
    }
  }

  const candidates = new Map<string, { id: string; isFree?: boolean }>();
  for (const model of synced) {
    const explicit =
      typeof model.isFree === "boolean" ? model.isFree : customFree.get(normalize(model.id));
    if (
      isFreeModelCandidate({
        provider,
        model: model.id,
        ...(typeof explicit === "boolean" ? { isFree: explicit } : {}),
      })
    ) {
      candidates.set(normalize(model.id), { id: model.id, ...(explicit === undefined ? {} : { isFree: explicit }) });
    }
  }

  for (const item of custom) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || row.isFree !== true) continue;
    candidates.set(normalize(row.id), { id: row.id, isFree: true });
  }

  const models = [...candidates.values()].map((candidate) => candidate.id).sort();
  for (const model of models) registerDiscoveredFreeModel(provider, model, "discovery-scan");

  const catalogEntries = FREE_MODEL_BUDGETS.filter(
    (entry) => normalize(entry.provider) === normalize(provider) && grantsFreeAccess(entry.freeType)
  );
  const authType =
    catalogEntries.length > 0 && catalogEntries.every((entry) => entry.freeType === "keyless")
      ? "none"
      : "api_key";
  const riskLevel = catalogEntries.some((entry) => entry.tos === "avoid") ? "medium" : "low";
  const connectionCount = Object.keys(byConnection).length;

  log.info("discovery.scan_complete", {
    providerId: provider,
    connectionCount,
    freeCandidates: models.length,
  });

  return [
    {
      providerId: provider,
      method: "free_tier",
      authType,
      models,
      feasibility: models.length > 0 ? 5 : 2,
      riskLevel,
      status: models.length > 0 ? "testing" : "pending",
      notes:
        models.length > 0
          ? `CobaltRoute V6 found ${models.length} free candidate(s) across ${connectionCount} synced connection catalog(s). Novel models remain in probation until verified routing/probe evidence qualifies them.`
          : `CobaltRoute V6 found no free candidate in ${connectionCount} synced connection catalog(s).`,
      discoveredAt: new Date().toISOString(),
    },
  ];
}

export function persistDiscoveryResult(result: DiscoveryResult): DiscoveryResult {
  return dbUpsertDiscoveryResult(result as DbDiscoveryResult) as DiscoveryResult;
}

export function getDiscoveryResults(providerId?: string): DiscoveryResult[] {
  return dbGetDiscoveryResults(providerId) as DiscoveryResult[];
}

export function isDiscoveryEnabled(): boolean {
  return process.env.COBALTROUTE_FREE_MODEL_DISCOVERY !== "0";
}
'''

write("src/lib/discovery/freeModelQualification.ts", qualification)
write("src/app/api/cobalt/free-model-discovery/route.ts", api_route)
write("src/app/(dashboard)/dashboard/router-brain/FreeModelDiscoveryPanel.tsx", panel)
write("tests/unit/cobalt-free-model-discovery.test.ts", tests)
write("src/lib/discovery/index.ts", discovery_index)

replace_once(
    "src/lib/db/models/synced.ts",
    '''  // #4264: image-input capability captured at sync time (e.g. OpenRouter\n  // `architecture.input_modalities`/`modality`) so the catalog can surface vision.\n  supportsVision?: boolean;\n}\n''',
    '''  // #4264: image-input capability captured at sync time (e.g. OpenRouter\n  // `architecture.input_modalities`/`modality`) so the catalog can surface vision.\n  supportsVision?: boolean;\n  /** Explicit provider/custom metadata that this model is free to use. */\n  isFree?: boolean;\n}\n'''
)
replace_once(
    "src/lib/db/models/synced.ts",
    '''    ...(record.supportsVision === true ? { supportsVision: true } : {}),\n  };\n''',
    '''    ...(record.supportsVision === true ? { supportsVision: true } : {}),\n    ...(typeof record.isFree === "boolean" ? { isFree: record.isFree } : {}),\n  };\n'''
)

replace_once(
    "src/lib/db/models.ts",
    '''  if (connectionId) await touchConnectionSyncedModelsAt(connectionId);\n  // Return the full unioned list for the provider\n  return getSyncedAvailableModels(providerId);\n''',
    '''  if (connectionId) await touchConnectionSyncedModelsAt(connectionId);\n  // CobaltRoute V6: every successful provider model sync is also a discovery\n  // opportunity. This is deliberately best-effort and never blocks model sync.\n  try {\n    const { registerSyncedFreeModels } = await import("../discovery/freeModelQualification");\n    registerSyncedFreeModels(providerId, normalizedModels);\n  } catch {\n    // Discovery qualification is advisory; synced catalog persistence already succeeded.\n  }\n  // Return the full unioned list for the provider\n  return getSyncedAvailableModels(providerId);\n'''
)

replace_once(
    "open-sse/services/autoCombo/freeQuotaIntelligence.ts",
    '''import { selectAdaptiveCandidate, type AdaptiveSelection } from "./adaptiveRouter.ts";\n''',
    '''import { selectAdaptiveCandidate, type AdaptiveSelection } from "./adaptiveRouter.ts";\nimport { filterFreeModelQualificationPool } from "@/lib/discovery/freeModelQualification";\n'''
)
replace_once(
    "open-sse/services/autoCombo/freeQuotaIntelligence.ts",
    '''export function getFreeQuotaRacePool(\n  pool: ProviderCandidate[],\n  taskType: string\n): ProviderCandidate[] {\n  if (!enabled()) {\n    const healthy = pool.filter((candidate) => candidate.circuitBreakerState !== "OPEN");\n    return healthy.length > 0 ? healthy : pool;\n  }\n  return applyInventoryPolicy(assessPool(pool, normalizeTaskType(taskType)), taskType).candidates;\n}\n''',
    '''export function getFreeQuotaRacePool(\n  pool: ProviderCandidate[],\n  taskType: string\n): ProviderCandidate[] {\n  // V6 lets Race trial at most one probation model beside trusted/qualified\n  // capacity. Quarantined discoveries never enter the race.\n  const qualificationPool = filterFreeModelQualificationPool(pool, {\n    allowProbation: true,\n    maxProbation: 1,\n  });\n  if (!enabled()) {\n    const healthy = qualificationPool.filter(\n      (candidate) => candidate.circuitBreakerState !== "OPEN"\n    );\n    return healthy.length > 0 ? healthy : qualificationPool;\n  }\n  return applyInventoryPolicy(\n    assessPool(qualificationPool, normalizeTaskType(taskType)),\n    taskType\n  ).candidates;\n}\n'''
)
replace_once(
    "open-sse/services/autoCombo/freeQuotaIntelligence.ts",
    '''export function selectQuotaAwareAdaptiveCandidate(\n  pool: ProviderCandidate[],\n  context: FreeQuotaIntelligenceContext\n): AdaptiveSelection {\n  if (!enabled()) {\n    return selectAdaptiveCandidate(pool, context);\n  }\n\n  const taskType = normalizeTaskType(context.taskType);\n  const assessed = assessPool(pool, taskType);\n''',
    '''export function selectQuotaAwareAdaptiveCandidate(\n  pool: ProviderCandidate[],\n  context: FreeQuotaIntelligenceContext\n): AdaptiveSelection {\n  // Normal adaptive routing holds novel probation models whenever a trusted or\n  // already-qualified alternative exists. Race mode owns controlled probation.\n  const qualificationPool = filterFreeModelQualificationPool(pool);\n  if (!enabled()) {\n    return selectAdaptiveCandidate(qualificationPool, context);\n  }\n\n  const taskType = normalizeTaskType(context.taskType);\n  const assessed = assessPool(qualificationPool, taskType);\n'''
)

replace_once(
    "open-sse/services/autoCombo/multiModelRace.ts",
    '''import { getFreeQuotaRacePool, scoreFreeQuotaCandidate } from "./freeQuotaIntelligence.ts";\n''',
    '''import { getFreeQuotaRacePool, scoreFreeQuotaCandidate } from "./freeQuotaIntelligence.ts";\nimport { getFreeModelQualificationState } from "@/lib/discovery/freeModelQualification";\n'''
)
replace_once(
    "open-sse/services/autoCombo/multiModelRace.ts",
    '''  for (const candidate of uniqueModels) {\n    if (chosen.length >= desiredWidth) break;\n    const key = modelKey(candidate.provider, candidate.model);\n    if (chosenKeys.has(key)) continue;\n    chosen.push(candidate);\n    chosenKeys.add(key);\n  }\n\n  const planId = nextPlanId();\n''',
    '''  for (const candidate of uniqueModels) {\n    if (chosen.length >= desiredWidth) break;\n    const key = modelKey(candidate.provider, candidate.model);\n    if (chosenKeys.has(key)) continue;\n    chosen.push(candidate);\n    chosenKeys.add(key);\n  }\n\n  // V6 qualification lane: when the eligible pool contains one probation model,\n  // ensure a race with trusted capacity actually exercises it instead of letting\n  // pure ranking permanently starve the candidate of verification evidence.\n  const probationCandidate = uniqueModels.find(\n    (candidate) =>\n      getFreeModelQualificationState(candidate.provider, candidate.model) === "probation" &&\n      !chosen.some(\n        (selected) =>\n          modelKey(selected.provider, selected.model) ===\n          modelKey(candidate.provider, candidate.model)\n      )\n  );\n  const hasTrustedRaceMember = chosen.some((candidate) => {\n    const state = getFreeModelQualificationState(candidate.provider, candidate.model);\n    return state === "trusted" || state === "qualified";\n  });\n  if (probationCandidate && chosen.length >= 2 && hasTrustedRaceMember) {\n    chosen[chosen.length - 1] = probationCandidate;\n  }\n\n  const planId = nextPlanId();\n'''
)

write(
    "src/app/(dashboard)/dashboard/router-brain/page.tsx",
    '''import RouterBrainClient from "./RouterBrainClient";\nimport CodingFeedbackPanel from "./CodingFeedbackPanel";\nimport FreeQuotaIntelligencePanel from "./FreeQuotaIntelligencePanel";\nimport MultiModelRacePanel from "./MultiModelRacePanel";\nimport FreeModelDiscoveryPanel from "./FreeModelDiscoveryPanel";\n\nexport const dynamic = "force-dynamic";\n\nexport default function RouterBrainPage() {\n  return (\n    <>\n      <RouterBrainClient />\n      <CodingFeedbackPanel />\n      <FreeQuotaIntelligencePanel />\n      <MultiModelRacePanel />\n      <FreeModelDiscoveryPanel />\n    </>\n  );\n}\n'''
)

print("CobaltRoute V6 implementation applied successfully.")
