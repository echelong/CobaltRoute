import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getMultiModelRaceSnapshot } from "@omniroute/open-sse/services/autoCombo/multiModelRace.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/cobalt/multi-model-race
 *
 * Management-only view of CobaltRoute's recent race plans and winners.
 * Snapshot data is metadata-only and never exposes prompts, responses,
 * credentials or provider connection ids.
 *
 * Built by Cobalt.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  return NextResponse.json(getMultiModelRaceSnapshot(), {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
