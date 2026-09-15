/**
 * CobaltRoute / OmniRoute provider discovery service.
 *
 * V6 replaces the old Phase-1 placeholder scanner with a conservative scanner
 * built on OmniRoute's existing per-connection synchronized model catalogs.
 * No credential harvesting or arbitrary Internet crawling is performed here.
 *
 * Built by Cobalt.
 */

import { logger } from "../../../open-sse/utils/logger.ts";
import { FREE_MODEL_BUDGETS, grantsFreeAccess } from "../../../open-sse/config/freeModelCatalog.ts";
import { getCustomModels, getSyncedAvailableModelsByConnection } from "../db/models";
import {
  upsertDiscoveryResult as dbUpsertDiscoveryResult,
  getDiscoveryResults as dbGetDiscoveryResults,
  type DiscoveryResult as DbDiscoveryResult,
} from "../db/discoveryResults";
import { isFreeModelCandidate, registerDiscoveredFreeModel } from "./freeModelQualification";

const log = logger("DISCOVERY");

export interface DiscoveryConfig {
  enabled: boolean;
  scanInterval: number;
  maxConcurrentScans: number;
  targetProviders: string[];
  notificationWebhook?: string;
}

export interface DiscoveryResult {
  id?: number;
  providerId: string;
  method: "free_tier" | "web_cookie" | "auto_register" | "trial" | "public_api";
  endpoint?: string;
  authType: "none" | "cookie" | "api_key" | "oauth";
  models?: string[];
  rateLimit?: string;
  feasibility: number;
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
  status: "pending" | "testing" | "verified" | "rejected";
  notes?: string;
  discoveredAt?: string;
  verifiedAt?: string;
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  enabled: true,
  scanInterval: 24 * 60 * 60 * 1000,
  maxConcurrentScans: 3,
  targetProviders: [],
};

export async function probeEndpoint(
  url: string,
  signal?: AbortSignal
): Promise<{ accessible: boolean; status?: number; hasModels?: boolean }> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "CobaltRoute-Discovery/1.0" },
      signal,
    });
    return {
      accessible: res.ok,
      status: res.status,
      hasModels: res.ok && url.includes("/models"),
    };
  } catch {
    return { accessible: false };
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Scan the live synchronized catalog for one provider and register novel free
 * candidates with the V6 qualification engine.
 */
export async function scanProvider(
  providerId: string,
  _config: Partial<DiscoveryConfig> = {}
): Promise<DiscoveryResult[]> {
  const provider = providerId.trim();
  if (!provider) return [];

  const byConnection = await getSyncedAvailableModelsByConnection(provider);
  const synced = Object.values(byConnection).flat();
  const customRaw = await getCustomModels(provider);
  const custom = Array.isArray(customRaw) ? customRaw : [];
  const customFree = new Map<string, boolean>();
  for (const item of custom) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id === "string" && typeof row.isFree === "boolean") {
      customFree.set(normalize(row.id), row.isFree);
    }
  }

  const candidates = new Map<string, { id: string; isFree?: boolean }>();
  for (const model of synced) {
    const explicit =
      typeof model.isFree === "boolean" ? model.isFree : customFree.get(normalize(model.id));
    if (
      isFreeModelCandidate({
        provider,
        model: model.id,
        ...(typeof explicit === "boolean" ? { isFree: explicit } : {}),
      })
    ) {
      candidates.set(normalize(model.id), {
        id: model.id,
        ...(explicit === undefined ? {} : { isFree: explicit }),
      });
    }
  }

  for (const item of custom) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || row.isFree !== true) continue;
    candidates.set(normalize(row.id), { id: row.id, isFree: true });
  }

  const models = [...candidates.values()].map((candidate) => candidate.id).sort();
  for (const model of models) registerDiscoveredFreeModel(provider, model, "discovery-scan");

  const catalogEntries = FREE_MODEL_BUDGETS.filter(
    (entry) => normalize(entry.provider) === normalize(provider) && grantsFreeAccess(entry.freeType)
  );
  const authType =
    catalogEntries.length > 0 && catalogEntries.every((entry) => entry.freeType === "keyless")
      ? "none"
      : "api_key";
  const riskLevel = catalogEntries.some((entry) => entry.tos === "avoid") ? "medium" : "low";
  const connectionCount = Object.keys(byConnection).length;

  log.info("discovery.scan_complete", {
    providerId: provider,
    connectionCount,
    freeCandidates: models.length,
  });

  return [
    {
      providerId: provider,
      method: "free_tier",
      authType,
      models,
      feasibility: models.length > 0 ? 5 : 2,
      riskLevel,
      status: models.length > 0 ? "testing" : "pending",
      notes:
        models.length > 0
          ? `CobaltRoute V6 found ${models.length} free candidate(s) across ${connectionCount} synced connection catalog(s). Novel models remain in probation until verified routing/probe evidence qualifies them.`
          : `CobaltRoute V6 found no free candidate in ${connectionCount} synced connection catalog(s).`,
      discoveredAt: new Date().toISOString(),
    },
  ];
}

export function persistDiscoveryResult(result: DiscoveryResult): DiscoveryResult {
  return dbUpsertDiscoveryResult(result as DbDiscoveryResult) as DiscoveryResult;
}

export function getDiscoveryResults(providerId?: string): DiscoveryResult[] {
  return dbGetDiscoveryResults(providerId) as DiscoveryResult[];
}

export function isDiscoveryEnabled(): boolean {
  return process.env.COBALTROUTE_FREE_MODEL_DISCOVERY !== "0";
}
