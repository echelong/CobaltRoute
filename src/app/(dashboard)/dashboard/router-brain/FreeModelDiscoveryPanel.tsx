"use client";

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
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">Qualification pipeline</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                Live provider model syncs can discover new free candidates automatically. New models
                enter probation, Race can trial one beside trusted contenders, verified successes
                promote them, and repeated quality or compatibility failures quarantine them without
                treating quota or network errors as model defects.
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
          <Stat
            label="Discovered"
            value={snapshot.summary.modelCount}
            hint="Novel free models seen"
          />
          <Stat
            label="Probation"
            value={snapshot.summary.probation}
            hint="Awaiting verified evidence"
          />
          <Stat label="Qualified" value={snapshot.summary.qualified} hint="Admitted by evidence" />
          <Stat
            label="Quarantined"
            value={snapshot.summary.quarantined}
            hint="Held out after quality failures"
          />
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
                    <td
                      className="max-w-72 truncate px-6 py-3 text-muted-foreground"
                      title={row.lastReason || ""}
                    >
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
