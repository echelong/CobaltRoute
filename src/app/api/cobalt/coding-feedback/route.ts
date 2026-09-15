import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getCodingFeedbackSnapshot,
  recordCodingVerification,
  type CodingVerificationCheck,
  type CodingVerificationKind,
  type CodingVerificationStatus,
} from "@omniroute/open-sse/services/autoCombo/codingFeedback.ts";
import { getAdaptiveBrainSnapshot } from "@omniroute/open-sse/services/autoCombo/adaptiveRouter.ts";

export const dynamic = "force-dynamic";

async function requireAuth(request: Request): Promise<Response | null> {
  return requireManagementAuth(request, { alwaysRequireAuth: true });
}

function isKind(value: unknown): value is CodingVerificationKind {
  return (
    value === "test" ||
    value === "build" ||
    value === "typecheck" ||
    value === "lint" ||
    value === "schema" ||
    value === "tool" ||
    value === "patch" ||
    value === "custom"
  );
}

function isStatus(value: unknown): value is CodingVerificationStatus {
  return value === "pass" || value === "fail" || value === "partial" || value === "skipped";
}

function parseChecks(value: unknown): CodingVerificationCheck[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;

  const checks: CodingVerificationCheck[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const check = raw as Record<string, unknown>;
    if (!isKind(check.kind) || !isStatus(check.status)) return null;

    const parsed: CodingVerificationCheck = {
      kind: check.kind,
      status: check.status,
    };
    if (check.weight !== undefined) {
      const weight = Number(check.weight);
      if (!Number.isFinite(weight) || weight <= 0) return null;
      parsed.weight = weight;
    }
    checks.push(parsed);
  }
  return checks;
}

export async function GET(request: Request) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  return NextResponse.json(getCodingFeedbackSnapshot(), {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

/**
 * POST /api/cobalt/coding-feedback
 *
 * Example:
 * {
 *   "provider": "openrouter",
 *   "model": "qwen/qwen3-coder:free",
 *   "taskType": "coding",
 *   "verificationId": "job-123",
 *   "checks": [
 *     { "kind": "test", "status": "pass" },
 *     { "kind": "typecheck", "status": "pass" },
 *     { "kind": "lint", "status": "fail" }
 *   ]
 * }
 */
export async function POST(request: Request) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const taskType = typeof input.taskType === "string" ? input.taskType.trim() : "coding";
  const verificationId =
    typeof input.verificationId === "string" ? input.verificationId.trim() : undefined;
  const checks = parseChecks(input.checks);

  if (!provider || !model || !taskType || !checks) {
    return NextResponse.json(
      {
        error:
          "provider, model, taskType, and checks (1..64 valid verifier checks) are required",
      },
      { status: 400 }
    );
  }

  try {
    const result = recordCodingVerification({
      provider,
      model,
      taskType,
      verificationId,
      checks,
    });

    return NextResponse.json({
      ok: true,
      result,
      codingFeedback: getCodingFeedbackSnapshot(),
      brain: getAdaptiveBrainSnapshot(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to record coding verification" },
      { status: 400 }
    );
  }
}
