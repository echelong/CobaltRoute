import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getHybridLocalCloudSnapshot } from "@omniroute/open-sse/services/autoCombo/hybridLocalCloud.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/cobalt/hybrid-local-cloud
 *
 * Management-only observability for CobaltRoute's local/self-hosted versus
 * cloud routing policy. The snapshot is aggregate-only and never includes
 * prompts, responses, endpoint URLs, credentials or connection ids.
 *
 * Built by Cobalt.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  return NextResponse.json(getHybridLocalCloudSnapshot(), {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
