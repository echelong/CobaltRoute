"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type RacePlan = {
  planId: string;
  taskType: string;
  width: number;
  status: "planned" | "won" | "exhausted" | "cancelled";
  dispatches: number;
  failures: number;
  winner: { provider: string; model: string } | null;
  candidates: Array<{ provider: string; model: string; score: number }>;
  createdAt: number;
  completedAt: number | null;
  updatedAt: number;
};

type Snapshot = {
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
  plans: RacePlan[];
};

const EMPTY: Snapshot = {
  generatedAt: 0,
  enabled: true,
  summary: {
    plans: 0,
    active: 0,
    won: 0,
    exhausted: 0,
    cancelled: 0,
    dispatches: 0,
    failures: 0,
    averageWidth: 0,
  },
  plans: [],
};

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

export default function MultiModelRacePanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cobalt/multi-model-race", { cache: "no-store" });
      if (!response.ok) throw new Error(`Race API returned ${response.status}`);
      setSnapshot((await response.json()) as Snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load multi-model race data");
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

  const rows = useMemo(() => snapshot.plans.slice(0, 12), [snapshot.plans]);

  return (
    <section className="mx-auto w-full max-w-7xl px-4 pb-8 md:px-8">
      <div className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-6 md:p-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Multi-Model Race + Verification v5
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">Verified race engine</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                CobaltRoute races a small provider-diverse set of free models, reuses
                OmniRoute&apos;s response-quality verifier, and returns the first verified winner
                while cancelling the remaining contenders.
              </p>
            </div>
            <div className="text-xs text-muted-foreground">
              {snapshot.enabled ? "Race enabled" : "Race disabled"}
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
            label="Race plans"
            value={number(snapshot.summary.plans)}
            hint={`${snapshot.summary.active} currently active`}
          />
          <Stat
            label="Verified wins"
            value={number(snapshot.summary.won)}
            hint={`${snapshot.summary.exhausted} race groups exhausted`}
          />
          <Stat
            label="Dispatches"
            value={number(snapshot.summary.dispatches)}
            hint={`${snapshot.summary.failures} contenders failed before a winner`}
          />
          <Stat
            label="Average width"
            value={snapshot.summary.averageWidth.toFixed(1)}
            hint="Maximum race width is three models"
          />
        </div>

        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Task</th>
                <th className="px-6 py-3 text-right font-medium">Width</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Winner</th>
                <th className="px-6 py-3 font-medium">Contenders</th>
                <th className="px-6 py-3 text-right font-medium">Dispatches</th>
                <th className="px-6 py-3 text-right font-medium">Failures</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-muted-foreground">
                    Waiting for auto/race or a race router strategy request.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.planId}>
                    <td className="px-6 py-3 capitalize">{row.taskType}</td>
                    <td className="px-6 py-3 text-right">{row.width}</td>
                    <td className="px-6 py-3 capitalize">{row.status}</td>
                    <td className="max-w-64 truncate px-6 py-3 font-medium">
                      {row.winner ? `${row.winner.provider}/${row.winner.model}` : "—"}
                    </td>
                    <td className="max-w-[34rem] truncate px-6 py-3 text-muted-foreground">
                      {row.candidates
                        .map(
                          (candidate) =>
                            `${candidate.provider}/${candidate.model} (${candidate.score.toFixed(2)})`
                        )
                        .join(" · ")}
                    </td>
                    <td className="px-6 py-3 text-right">{row.dispatches}</td>
                    <td className="px-6 py-3 text-right">{row.failures}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-border p-5 text-xs leading-5 text-muted-foreground md:px-8">
          Race telemetry is ephemeral and metadata-only. Prompt text, generated responses,
          credentials and provider connection identifiers are not exposed in this view.
        </div>
      </div>
    </section>
  );
}
