import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getFreeQuotaIntelligenceSnapshot } from "@omniroute/open-sse/services/autoCombo/freeQuotaIntelligence.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/cobalt/free-quota-intelligence
 *
 * Management-only runtime view of CobaltRoute's free-quota inventory policy.
 * The payload is aggregate-only and never includes connection/account ids.
 *
 * Built by Cobalt.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  return NextResponse.json(getFreeQuotaIntelligenceSnapshot(), {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
