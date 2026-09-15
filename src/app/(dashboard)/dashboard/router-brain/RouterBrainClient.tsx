"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Leader = {
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
};

type BrainSnapshot = {
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
  leaders: Leader[];
  tasks: Array<{
    taskType: string;
    modelCount: number;
    selections: number;
    observations: number;
    leader: Leader | null;
  }>;
};

const EMPTY: BrainSnapshot = {
  generatedAt: 0,
  summary: {
    taskCount: 0,
    modelCount: 0,
    providerCount: 0,
    selections: 0,
    observations: 0,
    proxyObservations: 0,
    positiveOutcomes: 0,
    negativeOutcomes: 0,
  },
  leaders: [],
  tasks: [],
};

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
      <div className="mt-2 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

export default function RouterBrainClient() {
  const [brain, setBrain] = useState<BrainSnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cobalt/router-brain", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Router Brain API returned ${response.status}`);
      }
      const payload = (await response.json()) as BrainSnapshot;
      setBrain(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load Router Brain");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const topLeaders = useMemo(() => brain.leaders.slice(0, 12), [brain.leaders]);

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <section className="rounded-3xl border border-border bg-card p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
              CobaltRoute
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">Router Brain</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground md:text-base">
              Live view of what CobaltRoute is learning about free models by task. Automatic request
              outcomes and explicit evaluator feedback update these scores over time.
            </p>
          </div>
          <div className="text-xs text-muted-foreground">
            {loading
              ? "Loading…"
              : brain.generatedAt
                ? `Updated ${new Date(brain.generatedAt).toLocaleTimeString()}`
                : "Waiting for routing data"}
          </div>
        </div>
      </section>

      {error ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Models learned"
          value={compact(brain.summary.modelCount)}
          hint={`${brain.summary.providerCount} providers across ${brain.summary.taskCount} task types`}
        />
        <StatCard
          label="Adaptive selections"
          value={compact(brain.summary.selections)}
          hint="Requests where the adaptive strategy selected a model"
        />
        <StatCard
          label="Real outcomes"
          value={compact(brain.summary.observations)}
          hint={`${brain.summary.positiveOutcomes} strong positives · ${brain.summary.negativeOutcomes} strong negatives`}
        />
        <StatCard
          label="Proxy observations"
          value={compact(brain.summary.proxyObservations)}
          hint="Task fit, live quality and reliability observations"
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_1.5fr]">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div>
            <h2 className="text-lg font-semibold">Best model by task</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The current task-specific leaders learned from your workload.
            </p>
          </div>

          <div className="mt-5 space-y-3">
            {brain.tasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
                No adaptive routing history yet. Use the adaptive/cobalt router and this board will
                fill automatically.
              </div>
            ) : (
              brain.tasks.slice(0, 12).map((task) => (
                <div key={task.taskType} className="rounded-xl border border-border/70 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium capitalize">{task.taskType}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {task.modelCount} models · {task.observations} outcomes
                      </div>
                    </div>
                    {task.leader ? (
                      <div className="text-right">
                        <div className="max-w-52 truncate text-sm font-medium" title={task.leader.model}>
                          {task.leader.model}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {task.leader.provider} · {pct(task.leader.learnedScore)}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="p-5">
            <h2 className="text-lg font-semibold">Learned leaderboard</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Highest learned model/task scores across CobaltRoute.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-y border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">Task</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 text-right font-medium">Learned</th>
                  <th className="px-5 py-3 text-right font-medium">Outcomes</th>
                  <th className="px-5 py-3 text-right font-medium">Selections</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {topLeaders.length === 0 ? (
                  <tr>
                    <td className="px-5 py-8 text-center text-muted-foreground" colSpan={6}>
                      Waiting for adaptive routing data.
                    </td>
                  </tr>
                ) : (
                  topLeaders.map((leader) => (
                    <tr key={`${leader.taskType}:${leader.provider}:${leader.model}`}>
                      <td className="px-5 py-3 capitalize">{leader.taskType}</td>
                      <td className="max-w-80 truncate px-5 py-3 font-medium" title={leader.model}>
                        {leader.model}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">{leader.provider}</td>
                      <td className="px-5 py-3 text-right font-medium">
                        {pct(leader.learnedScore)}
                      </td>
                      <td className="px-5 py-3 text-right">{leader.observations}</td>
                      <td className="px-5 py-3 text-right">{leader.selections}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground shadow-sm">
        CobaltRoute stores aggregate learning statistics only. Router Brain does not persist prompt
        text, model responses, credentials, headers, or account identifiers.
      </section>
    </main>
  );
}
