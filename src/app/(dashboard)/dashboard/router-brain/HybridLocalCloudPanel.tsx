"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type TaskObservation = {
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
};

type ModelObservation = {
  taskType: string;
  provider: string;
  model: string;
  locality: "local" | "cloud";
  selections: number;
  mixedPoolSelections: number;
  avgMerit: number;
  updatedAt: number;
};

type Snapshot = {
  generatedAt: number;
  enabled: boolean;
  policy: "balanced" | "local-first" | "cloud-first";
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
  tasks: TaskObservation[];
  models: ModelObservation[];
};

const EMPTY: Snapshot = {
  generatedAt: 0,
  enabled: true,
  policy: "balanced",
  explicitLocalProviderCount: 0,
  summary: {
    decisions: 0,
    mixedPools: 0,
    localSelections: 0,
    cloudSelections: 0,
    localOffloads: 0,
    cloudFallbacks: 0,
    localCandidatesSeen: 0,
    cloudCandidatesSeen: 0,
    modelCount: 0,
    providerCount: 0,
    taskCount: 0,
  },
  tasks: [],
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

export default function HybridLocalCloudPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cobalt/hybrid-local-cloud", { cache: "no-store" });
      if (!response.ok) throw new Error(`Hybrid routing API returned ${response.status}`);
      setSnapshot((await response.json()) as Snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load hybrid routing intelligence");
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

  const models = useMemo(() => snapshot.models.slice(0, 20), [snapshot.models]);
  const localShare =
    snapshot.summary.decisions > 0
      ? Math.round((snapshot.summary.localSelections / snapshot.summary.decisions) * 100)
      : 0;

  return (
    <section className="mx-auto w-full max-w-7xl px-4 pb-8 md:px-8">
      <div className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-6 md:p-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Hybrid Local + Cloud Routing v8
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">Local when it wins, cloud when it should</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                CobaltRoute compares healthy local/self-hosted capacity with cloud capacity by task,
                learned outcomes, quality, reliability and existing scoring. Routine work gets a
                privacy/cost-friendly local bias while stronger cloud models remain an automatic fallback.
              </p>
            </div>
            <div className="text-xs text-muted-foreground">
              {snapshot.enabled ? `Enabled · ${snapshot.policy}` : "Hybrid routing disabled"}
              {snapshot.generatedAt
                ? ` · updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`
                : ""}
            </div>
          </div>
        </div>

        {error ? (
          <div className="border-b border-border px-6 py-3 text-sm text-destructive md:px-8">{error}</div>
        ) : null}

        <div className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-4 md:p-8">
          <Stat label="Local selections" value={snapshot.summary.localSelections} hint={`${localShare}% of hybrid decisions`} />
          <Stat label="Cloud fallbacks" value={snapshot.summary.cloudFallbacks} hint="Cloud won from a mixed pool" />
          <Stat label="Local offloads" value={snapshot.summary.localOffloads} hint="Mixed requests kept on-device/self-hosted" />
          <Stat label="Mixed pools" value={snapshot.summary.mixedPools} hint="Both local and cloud were available" />
        </div>

        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Task</th>
                <th className="px-6 py-3 font-medium">Model</th>
                <th className="px-6 py-3 font-medium">Provider</th>
                <th className="px-6 py-3 font-medium">Lane</th>
                <th className="px-6 py-3 text-right font-medium">Selections</th>
                <th className="px-6 py-3 text-right font-medium">Mixed</th>
                <th className="px-6 py-3 text-right font-medium">Merit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {models.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-muted-foreground">
                    No hybrid routing decisions have been observed yet.
                  </td>
                </tr>
              ) : (
                models.map((row) => (
                  <tr key={`${row.taskType}:${row.provider}:${row.model}`}>
                    <td className="px-6 py-3 text-muted-foreground">{row.taskType}</td>
                    <td className="max-w-80 truncate px-6 py-3 font-medium" title={row.model}>{row.model}</td>
                    <td className="px-6 py-3 text-muted-foreground">{row.provider}</td>
                    <td className="px-6 py-3 capitalize">{row.locality}</td>
                    <td className="px-6 py-3 text-right">{row.selections}</td>
                    <td className="px-6 py-3 text-right">{row.mixedPoolSelections}</td>
                    <td className="px-6 py-3 text-right">{(row.avgMerit * 100).toFixed(0)}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-border p-5 text-xs leading-5 text-muted-foreground md:px-8">
          Locality telemetry is aggregate-only and ephemeral. Endpoint URLs, connection IDs, prompts,
          responses and credentials are not exposed or persisted here. Custom local-compatible provider
          IDs can be explicitly opted in with COBALTROUTE_LOCAL_PROVIDER_IDS.
        </div>
      </div>
    </section>
  );
}
