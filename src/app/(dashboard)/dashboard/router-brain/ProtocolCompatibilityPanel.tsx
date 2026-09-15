"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Profile = {
  provider: string;
  model: string;
  successes: number;
  failures: number;
  toolFailures: number;
  schemaFailures: number;
  responseShapeFailures: number;
  unsupportedParameterFailures: number;
  repairsApplied: number;
  requestRepairs: number;
  responseRepairs: number;
  learnedUnsupportedParameters: string[];
  compatibilityScore: number;
  lastIssue: string | null;
  updatedAt: number;
};

type Snapshot = {
  generatedAt: number;
  enabled: boolean;
  summary: {
    modelCount: number;
    providerCount: number;
    successes: number;
    failures: number;
    repairsApplied: number;
    toolFailures: number;
    schemaFailures: number;
    responseShapeFailures: number;
    unsupportedParameterFailures: number;
    learnedUnsupportedParameters: number;
  };
  models: Profile[];
};

const EMPTY: Snapshot = {
  generatedAt: 0,
  enabled: true,
  summary: {
    modelCount: 0,
    providerCount: 0,
    successes: 0,
    failures: 0,
    repairsApplied: 0,
    toolFailures: 0,
    schemaFailures: 0,
    responseShapeFailures: 0,
    unsupportedParameterFailures: 0,
    learnedUnsupportedParameters: 0,
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

export default function ProtocolCompatibilityPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cobalt/protocol-compatibility", { cache: "no-store" });
      if (!response.ok) throw new Error(`Protocol compatibility API returned ${response.status}`);
      setSnapshot((await response.json()) as Snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load protocol compatibility");
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
                Protocol + Tool Compatibility Repair v7
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                Compatibility intelligence
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                CobaltRoute repairs deterministic request and tool-call protocol mismatches, learns
                safe optional parameters a model rejects, and gently de-prioritizes targets with
                repeated compatibility failures without confusing quota or network faults with
                protocol defects.
              </p>
            </div>
            <div className="text-xs text-muted-foreground">
              {snapshot.enabled ? "Compatibility repair enabled" : "Compatibility repair disabled"}
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
            label="Repairs"
            value={snapshot.summary.repairsApplied}
            hint="Deterministic protocol fixes"
          />
          <Stat label="Models" value={snapshot.summary.modelCount} hint="Compatibility profiles" />
          <Stat
            label="Failures"
            value={snapshot.summary.failures}
            hint="Protocol-specific evidence"
          />
          <Stat
            label="Learned params"
            value={snapshot.summary.learnedUnsupportedParameters}
            hint="Safe optional fields suppressed"
          />
        </div>

        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Model</th>
                <th className="px-6 py-3 font-medium">Provider</th>
                <th className="px-6 py-3 text-right font-medium">Score</th>
                <th className="px-6 py-3 text-right font-medium">Repairs</th>
                <th className="px-6 py-3 text-right font-medium">Tool</th>
                <th className="px-6 py-3 text-right font-medium">Schema</th>
                <th className="px-6 py-3 text-right font-medium">Params</th>
                <th className="px-6 py-3 text-right font-medium">Shape</th>
                <th className="px-6 py-3 font-medium">Latest issue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-8 text-center text-muted-foreground">
                    No protocol quirks have been observed yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={`${row.provider}:${row.model}`}>
                    <td className="max-w-80 truncate px-6 py-3 font-medium" title={row.model}>
                      {row.model}
                    </td>
                    <td className="px-6 py-3 text-muted-foreground">{row.provider}</td>
                    <td className="px-6 py-3 text-right">
                      {(row.compatibilityScore * 100).toFixed(0)}%
                    </td>
                    <td className="px-6 py-3 text-right">{row.repairsApplied}</td>
                    <td className="px-6 py-3 text-right">{row.toolFailures}</td>
                    <td className="px-6 py-3 text-right">{row.schemaFailures}</td>
                    <td className="px-6 py-3 text-right">{row.unsupportedParameterFailures}</td>
                    <td className="px-6 py-3 text-right">{row.responseShapeFailures}</td>
                    <td
                      className="max-w-80 truncate px-6 py-3 text-muted-foreground"
                      title={row.lastIssue || ""}
                    >
                      {row.lastIssue || "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-border p-5 text-xs leading-5 text-muted-foreground md:px-8">
          Compatibility telemetry is aggregate-only and ephemeral. CobaltRoute does not retain
          prompts, responses, headers, credentials or connection IDs here. Schema coercion and
          format translation remain owned by OmniRoute&apos;s existing translator pipeline.
        </div>
      </div>
    </section>
  );
}
