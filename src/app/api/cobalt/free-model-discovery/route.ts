import { NextResponse } from "next/server";
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
