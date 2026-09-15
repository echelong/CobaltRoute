import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getAdaptiveBrainSnapshot,
  recordAdaptiveOutcome,
} from "@omniroute/open-sse/services/autoCombo/adaptiveRouter.ts";

export const dynamic = "force-dynamic";

async function requireAuth(request: Request): Promise<Response | null> {
  return requireManagementAuth(request, { alwaysRequireAuth: true });
}

export async function GET(request: Request) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  return NextResponse.json(getAdaptiveBrainSnapshot(), {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

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
  const taskType = typeof input.taskType === "string" ? input.taskType.trim() : "";
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const reward = Number(input.reward);

  if (!taskType || !provider || !model || !Number.isFinite(reward) || reward < 0 || reward > 1) {
    return NextResponse.json(
      {
        error: "taskType, provider, model, and reward (0..1) are required",
      },
      { status: 400 }
    );
  }

  const entry = recordAdaptiveOutcome({ taskType, provider, model, reward });
  return NextResponse.json({ ok: true, entry, brain: getAdaptiveBrainSnapshot() });
}
