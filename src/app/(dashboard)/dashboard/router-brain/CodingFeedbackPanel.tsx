"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type KindSummary = {
  kind: string;
  checks: number;
  passed: number;
  failed: number;
  partial: number;
  skipped: number;
};

type Leader = {
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
  objectiveSuccessRate: number;
};

type CodingFeedbackSnapshot = {
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
  byKind: KindSummary[];
  leaders: Leader[];
};

const EMPTY: CodingFeedbackSnapshot = {
  generatedAt: 0,
  summary: {
    reports: 0,
    checks: 0,
    passed: 0,
    failed: 0,
    partial: 0,
    skipped: 0,
    objectiveSuccessRate: 0,
    modelCount: 0,
    taskCount: 0,
  },
  byKind: [],
  leaders: [],
};

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export default function CodingFeedbackPanel() {
  const [snapshot, setSnapshot] = useState<CodingFeedbackSnapshot>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cobalt/coding-feedback", { cache: "no-store" });
      if (!response.ok) throw new Error(`Coding Feedback API returned ${response.status}`);
      const payload = (await response.json()) as CodingFeedbackSnapshot;
      setSnapshot(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load coding verification data");
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

  const leaders = useMemo(() => snapshot.leaders.slice(0, 8), [snapshot.leaders]);

  return (
    <section className="mx-auto w-full max-w-7xl space-y-5 px-4 pb-8 md:px-8">
      <div className="rounded-3xl border border-border bg-card p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
              Coding Feedback v3
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">Objective verifier loop</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Tests, builds, typechecks, lint, schema validation, tool calls and patch checks can
              now teach Router Brain whether a coding model actually produced working output.
            </p>
          </div>
          <div className="text-xs text-muted-foreground">
            {snapshot.generatedAt
              ? `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`
              : "Waiting for verifier data"}
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="text-sm text-muted-foreground">Verified reports</div>
          <div className="mt-2 text-3xl font-semibold tracking-tight">
            {compact(snapshot.summary.reports)}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Each report becomes one adaptive semantic outcome
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="text-sm text-muted-foreground">Objective success</div>
          <div className="mt-2 text-3xl font-semibold tracking-tight">
            {pct(snapshot.summary.objectiveSuccessRate)}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Partial checks count as half-success
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="text-sm text-muted-foreground">Verifier checks</div>
          <div className="mt-2 text-3xl font-semibold tracking-tight">
            {compact(snapshot.summary.checks)}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {snapshot.summary.passed} pass · {snapshot.summary.failed} fail · {snapshot.summary.partial} partial
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="text-sm text-muted-foreground">Verified models</div>
          <div className="mt-2 text-3xl font-semibold tracking-tight">
            {compact(snapshot.summary.modelCount)}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Across {snapshot.summary.taskCount} learned task types
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <h3 className="text-lg font-semibold">Checks by verifier</h3>
          <div className="mt-4 space-y-3">
            {snapshot.byKind.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
                No objective coding verification has been reported yet.
              </div>
            ) : (
              snapshot.byKind.map((item) => (
                <div key={item.kind} className="rounded-xl border border-border/70 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium capitalize">{item.kind}</div>
                    <div className="text-sm text-muted-foreground">{item.checks} checks</div>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {item.passed} pass · {item.failed} fail · {item.partial} partial · {item.skipped} skipped
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="p-5">
            <h3 className="text-lg font-semibold">Objectively verified models</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Ranked by pass rate, then verification volume.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="border-y border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">Task</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 text-right font-medium">Pass rate</th>
                  <th className="px-5 py-3 text-right font-medium">Reports</th>
                  <th className="px-5 py-3 text-right font-medium">Checks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leaders.length === 0 ? (
                  <tr>
                    <td className="px-5 py-8 text-center text-muted-foreground" colSpan={6}>
                      Waiting for deterministic verifier results.
                    </td>
                  </tr>
                ) : (
                  leaders.map((leader) => (
                    <tr key={`${leader.taskType}:${leader.provider}:${leader.model}`}>
                      <td className="px-5 py-3 capitalize">{leader.taskType}</td>
                      <td className="max-w-72 truncate px-5 py-3 font-medium" title={leader.model}>
                        {leader.model}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">{leader.provider}</td>
                      <td className="px-5 py-3 text-right font-medium">
                        {pct(leader.objectiveSuccessRate)}
                      </td>
                      <td className="px-5 py-3 text-right">{leader.reports}</td>
                      <td className="px-5 py-3 text-right">{leader.checks}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground shadow-sm">
        Verification reports store only aggregate pass/fail statistics and model/task identity.
        Command output, prompts, responses, source code, credentials and account identifiers are not
        persisted by this subsystem.
      </div>
    </section>
  );
}
