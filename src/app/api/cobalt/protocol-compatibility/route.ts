import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getProtocolCompatibilitySnapshot,
  recordProtocolCompatibilityIssue,
  recordProtocolCompatibilitySuccess,
  type ProtocolCompatibilityFailureKind,
} from "@omniroute/open-sse/services/autoCombo/protocolCompatibility.ts";

export const dynamic = "force-dynamic";

const KINDS = new Set<ProtocolCompatibilityFailureKind>([
  "tool",
  "schema",
  "response_shape",
  "unsupported_parameter",
]);

/**
 * Management-only Router Brain compatibility telemetry and explicit evidence seam.
 * No prompts, responses, headers, credentials or connection ids are accepted.
 *
 * Built by Cobalt.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  return NextResponse.json(getProtocolCompatibilitySnapshot(), {
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
  const outcome = typeof value.outcome === "string" ? value.outcome.trim() : "";
  const reason = typeof value.reason === "string" ? value.reason : undefined;
  const parameter = typeof value.parameter === "string" ? value.parameter : undefined;

  if (!provider || !model) {
    return NextResponse.json({ error: "provider and model are required" }, { status: 400 });
  }

  const entry =
    outcome === "success"
      ? recordProtocolCompatibilitySuccess(provider, model)
      : KINDS.has(outcome as ProtocolCompatibilityFailureKind)
        ? recordProtocolCompatibilityIssue({
            provider,
            model,
            kind: outcome as ProtocolCompatibilityFailureKind,
            ...(reason ? { reason } : {}),
            ...(parameter ? { parameter } : {}),
          })
        : null;

  if (outcome !== "success" && !KINDS.has(outcome as ProtocolCompatibilityFailureKind)) {
    return NextResponse.json(
      { error: "outcome must be success, tool, schema, response_shape, or unsupported_parameter" },
      { status: 400 }
    );
  }

  return NextResponse.json({ entry, compatibility: getProtocolCompatibilitySnapshot() });
}
