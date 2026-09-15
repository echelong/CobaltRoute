"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Observation = {
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
};

type Snapshot = {
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
  observations: Observation[];
};

const EMPTY: Snapshot = {
  generatedAt: 0,
  enabled: true,
  summary: {
    evaluations: 0,
    selections: 0,
    protectedEvaluations: 0,
    scarceEvaluations: 0,
    expiringEvaluations: 0,
    modelCount: 0,
    providerCount: 0,
  },
  observations: [],
};

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function number(value: number) {
  return new Intl.NumberFormat().format(value);
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-border/70 p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

export default function FreeQuotaIntelligencePanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cobalt/free-quota-intelligence", { cache: "no-store" });
      if (!response.ok) throw new Error(`Free Quota API returned ${response.status}`);
      setSnapshot((await response.json()) as Snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load free quota intelligence");
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

  const rows = useMemo(() => snapshot.observations.slice(0, 12), [snapshot.observations]);

  return (
    <section className="mx-auto w-full max-w-7xl px-4 pb-8 md:px-8">
      <div className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-6 md:p-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Free Quota Intelligence v4
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">Expiring inventory</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                CobaltRoute spends free quota that is healthy and approaching reset, protects scarce
                high-value capacity on routine tasks, and avoids nearly exhausted accounts before a
                hard provider cutoff.
              </p>
            </div>
            <div className="text-xs text-muted-foreground">
              {snapshot.enabled ? "Policy enabled" : "Policy disabled"}
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
          <Stat
            label="Inventory evaluations"
            value={number(snapshot.summary.evaluations)}
            hint={`${snapshot.summary.modelCount} models across ${snapshot.summary.providerCount} providers`}
          />
          <Stat
            label="Protected choices"
            value={number(snapshot.summary.protectedEvaluations)}
            hint="Scarce free inventory removed from routine selection"
          />
          <Stat
            label="Scarce quota"
            value={number(snapshot.summary.scarceEvaluations)}
            hint="Evaluations at or below 20% remaining"
          />
          <Stat
            label="Reset-soon quota"
            value={number(snapshot.summary.expiringEvaluations)}
            hint="Quota with strong reset-window affinity"
          />
        </div>

        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[940px] text-sm">
            <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Task</th>
                <th className="px-6 py-3 font-medium">Model</th>
                <th className="px-6 py-3 font-medium">Provider</th>
                <th className="px-6 py-3 text-right font-medium">Remaining</th>
                <th className="px-6 py-3 text-right font-medium">Inventory</th>
                <th className="px-6 py-3 text-right font-medium">Reset</th>
                <th className="px-6 py-3 text-right font-medium">Reserve</th>
                <th className="px-6 py-3 text-right font-medium">Selected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-muted-foreground">
                    Waiting for adaptive free-model routing activity.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={`${row.taskType}:${row.provider}:${row.model}`}>
                    <td className="px-6 py-3 capitalize">{row.taskType}</td>
                    <td className="max-w-72 truncate px-6 py-3 font-medium" title={row.model}>
                      {row.model}
                    </td>
                    <td className="px-6 py-3 text-muted-foreground">{row.provider}</td>
                    <td className="px-6 py-3 text-right">
                      {Math.round(row.latestRemainingPercent)}%
                    </td>
                    <td className="px-6 py-3 text-right">{pct(row.avgInventoryScore)}</td>
                    <td className="px-6 py-3 text-right">{pct(row.latestResetAffinity)}</td>
                    <td className="px-6 py-3 text-right">{pct(row.latestReservePressure)}</td>
                    <td className="px-6 py-3 text-right">
                      {row.selections}/{row.evaluations}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-border p-5 text-xs leading-5 text-muted-foreground md:px-8">
          Free-quota observations are intentionally ephemeral because quota state expires. Router
          Brain never exposes or persists provider connection IDs from this policy.
        </div>
      </div>
    </section>
  );
}
