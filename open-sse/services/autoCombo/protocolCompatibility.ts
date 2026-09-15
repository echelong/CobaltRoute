/**
 * CobaltRoute Protocol + Tool Compatibility Repair
 *
 * Adds a conservative compatibility overlay on top of OmniRoute's existing
 * translator, schema coercion, and response-quality machinery. Repairs are
 * deterministic: no prompt rewriting and no semantic guessing.
 *
 * Runtime compatibility evidence is aggregate-only and ephemeral. Prompts,
 * responses, credentials, headers and connection ids are never retained.
 *
 * Built by Cobalt.
 */

const MAX_PROFILES = 1_000;
const MAX_UNSUPPORTED_PARAMETERS = 16;
const MIN_COMPATIBILITY_SCORE = 0.25;

export type ProtocolCompatibilityFailureKind =
  "tool" | "schema" | "response_shape" | "unsupported_parameter";

export type ProtocolRepairSource = "request" | "response";

export interface ProtocolCompatibilityProfile {
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
}

export interface ProtocolCompatibilitySnapshot {
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
  models: ProtocolCompatibilityProfile[];
}

type JsonRecord = Record<string, unknown>;

const profiles = new Map<string, ProtocolCompatibilityProfile>();

const SAFE_OPTIONAL_PARAMETERS = new Set([
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "stop",
  "logprobs",
  "top_logprobs",
  "parallel_tool_calls",
  "n",
  "user",
  "service_tier",
  "store",
  "metadata",
  "reasoning_effort",
  "verbosity",
  "stream_options",
  "prediction",
]);

const STANDARD_TOOL_CHOICES = new Set(["auto", "none", "required"]);

function enabled(): boolean {
  return process.env.COBALTROUTE_PROTOCOL_COMPATIBILITY !== "0";
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeIdentity(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeModel(provider: string, model: string): string {
  const providerId = normalizeIdentity(provider);
  const raw = normalizeIdentity(model);
  for (const separator of ["/", ":"]) {
    const prefix = `${providerId}${separator}`;
    if (providerId && raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return raw;
}

function keyFor(provider: string, model: string): string {
  return `${normalizeIdentity(provider)}\u0000${normalizeModel(provider, model)}`;
}

function calculateScore(
  profile: Pick<ProtocolCompatibilityProfile, "successes" | "failures">
): number {
  if (profile.failures <= 0) return 1;
  const raw = (profile.successes + 3) / (profile.successes + profile.failures * 2 + 3);
  return Math.max(MIN_COMPATIBILITY_SCORE, Math.min(1, raw));
}

function defaultProfile(provider: string, model: string): ProtocolCompatibilityProfile {
  return {
    provider,
    model: normalizeModel(provider, model),
    successes: 0,
    failures: 0,
    toolFailures: 0,
    schemaFailures: 0,
    responseShapeFailures: 0,
    unsupportedParameterFailures: 0,
    repairsApplied: 0,
    requestRepairs: 0,
    responseRepairs: 0,
    learnedUnsupportedParameters: [],
    compatibilityScore: 1,
    lastIssue: null,
    updatedAt: Date.now(),
  };
}

function getOrCreate(provider: string, model: string): ProtocolCompatibilityProfile {
  const key = keyFor(provider, model);
  const existing = profiles.get(key);
  if (existing) return existing;
  const created = defaultProfile(provider, model);
  profiles.set(key, created);
  pruneProfiles();
  return created;
}

function pruneProfiles(): void {
  if (profiles.size <= MAX_PROFILES) return;
  const oldest = [...profiles.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
  if (oldest) profiles.delete(oldest[0]);
}

function refreshScore(profile: ProtocolCompatibilityProfile): void {
  profile.compatibilityScore = calculateScore(profile);
  profile.updatedAt = Date.now();
}

function operationalFailure(error: string, status?: number): boolean {
  if (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }
  return /rate.?limit|quota|credit|cooldown|timeout|timed out|network|connection reset|capacity|overload|temporarily unavailable|service unavailable/i.test(
    error
  );
}

function normalizeUnsupportedParameter(value: string | null): string | null {
  if (!value) return null;
  const topLevel = value
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .split(/[.[\]]/, 1)[0]
    ?.trim()
    .toLowerCase();
  if (!topLevel || !SAFE_OPTIONAL_PARAMETERS.has(topLevel)) return null;
  return topLevel;
}

export function extractUnsupportedParameter(error: string): string | null {
  const text = String(error || "");
  const patterns = [
    /unrecognized request argument supplied:\s*["'`]?([a-zA-Z0-9_.-]+)/i,
    /(?:unsupported|unknown|unrecognized|unexpected)\s+(?:request\s+)?(?:parameter|param|argument|field)\s*[:=]?\s*["'`]?([a-zA-Z0-9_.-]+)/i,
    /(?:parameter|param|argument|field)\s+["'`]?([a-zA-Z0-9_.-]+)["'`]?\s+(?:is\s+)?(?:unsupported|not supported|not allowed|unrecognized|unknown)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const parameter = normalizeUnsupportedParameter(match?.[1] ?? null);
    if (parameter) return parameter;
  }
  return null;
}

export function classifyProtocolCompatibilityFailure(
  error: string,
  status?: number
): { kind: ProtocolCompatibilityFailureKind; parameter: string | null } | null {
  const text = String(error || "");
  if (!text.trim() || operationalFailure(text, status)) return null;

  const parameter = extractUnsupportedParameter(text);
  if (parameter) return { kind: "unsupported_parameter", parameter };

  if (
    /invalid tool|malformed tool|tool.?call|function.?call|tool arguments|function arguments|tool_use|unknown tool|unsupported tool/i.test(
      text
    )
  ) {
    return { kind: "tool", parameter: null };
  }

  if (
    /json schema|invalid schema|schema validation|structured output|response_format/i.test(text)
  ) {
    return { kind: "schema", parameter: null };
  }

  if (
    /malformed response|invalid json|invalid response|response shape|empty choices|empty response|upstream response failed quality validation/i.test(
      text
    )
  ) {
    return { kind: "response_shape", parameter: null };
  }

  return null;
}

export function recordProtocolCompatibilityIssue(input: {
  provider: string;
  model: string;
  kind: ProtocolCompatibilityFailureKind;
  reason?: string;
  parameter?: string | null;
}): ProtocolCompatibilityProfile | null {
  if (!enabled() || !input.provider || !input.model) return null;
  const profile = getOrCreate(input.provider, input.model);
  profile.failures += 1;
  if (input.kind === "tool") profile.toolFailures += 1;
  if (input.kind === "schema") profile.schemaFailures += 1;
  if (input.kind === "response_shape") profile.responseShapeFailures += 1;
  if (input.kind === "unsupported_parameter") profile.unsupportedParameterFailures += 1;

  const parameter = normalizeUnsupportedParameter(input.parameter ?? null);
  if (
    input.kind === "unsupported_parameter" &&
    parameter &&
    !profile.learnedUnsupportedParameters.includes(parameter)
  ) {
    profile.learnedUnsupportedParameters.push(parameter);
    if (profile.learnedUnsupportedParameters.length > MAX_UNSUPPORTED_PARAMETERS) {
      profile.learnedUnsupportedParameters.splice(
        0,
        profile.learnedUnsupportedParameters.length - MAX_UNSUPPORTED_PARAMETERS
      );
    }
  }

  profile.lastIssue = input.reason?.slice(0, 240) || input.kind;
  refreshScore(profile);
  return { ...profile, learnedUnsupportedParameters: [...profile.learnedUnsupportedParameters] };
}

export function recordProtocolCompatibilityFailure(input: {
  provider: string;
  model: string;
  error: string;
  status?: number;
}): ProtocolCompatibilityProfile | null {
  const classified = classifyProtocolCompatibilityFailure(input.error, input.status);
  if (!classified) return null;
  return recordProtocolCompatibilityIssue({
    provider: input.provider,
    model: input.model,
    kind: classified.kind,
    reason: input.error,
    parameter: classified.parameter,
  });
}

export function recordProtocolCompatibilitySuccess(
  provider: string,
  model: string
): ProtocolCompatibilityProfile | null {
  if (!enabled()) return null;
  const profile = profiles.get(keyFor(provider, model));
  if (!profile) return null;
  profile.successes += 1;
  refreshScore(profile);
  return { ...profile, learnedUnsupportedParameters: [...profile.learnedUnsupportedParameters] };
}

function recordRepair(
  provider: string | null | undefined,
  model: string | null | undefined,
  source: ProtocolRepairSource,
  repairs: string[]
): void {
  if (!enabled() || !provider || !model || repairs.length === 0) return;
  const profile = getOrCreate(provider, model);
  profile.repairsApplied += repairs.length;
  if (source === "request") profile.requestRepairs += repairs.length;
  else profile.responseRepairs += repairs.length;
  profile.updatedAt = Date.now();
}

export function getProtocolCompatibilityScore(provider: string, model: string): number {
  if (!enabled()) return 1;
  return profiles.get(keyFor(provider, model))?.compatibilityScore ?? 1;
}

function normalizeFunctionDefinition(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  const parameters = isRecord(value.parameters)
    ? value.parameters
    : { type: "object", properties: {} };
  return {
    name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    parameters,
  };
}

function normalizeTool(value: unknown): { tool: unknown; changed: boolean } {
  if (!isRecord(value)) return { tool: value, changed: false };

  if (value.type === "function" && isRecord(value.function)) {
    const normalized = normalizeFunctionDefinition(value.function);
    if (!normalized) return { tool: value, changed: false };
    const changed =
      normalized.parameters !== value.function.parameters ||
      value.function.name !== normalized.name;
    return {
      tool: { ...value, function: { ...value.function, ...normalized } },
      changed,
    };
  }

  const bare = normalizeFunctionDefinition(value);
  if (bare) {
    return {
      tool: { type: "function", function: bare },
      changed: true,
    };
  }

  return { tool: value, changed: false };
}

function normalizeToolChoice(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || STANDARD_TOOL_CHOICES.has(trimmed)) return { value, changed: false };
    return {
      value: { type: "function", function: { name: trimmed } },
      changed: true,
    };
  }

  if (!isRecord(value)) return { value, changed: false };

  if (typeof value.name === "string" && value.name.trim()) {
    return {
      value: { type: "function", function: { name: value.name.trim() } },
      changed: true,
    };
  }

  if (
    value.type === "function" &&
    typeof value.name === "string" &&
    value.name.trim() &&
    !isRecord(value.function)
  ) {
    return {
      value: { type: "function", function: { name: value.name.trim() } },
      changed: true,
    };
  }

  return { value, changed: false };
}

function normalizeJsonSchemaResponseFormat(value: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(value) || value.type !== "json_schema" || isRecord(value.json_schema)) {
    return { value, changed: false };
  }

  const schema = isRecord(value.schema) ? value.schema : null;
  if (!schema) return { value, changed: false };
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : "response";
  const jsonSchema: JsonRecord = { name, schema };
  if (typeof value.strict === "boolean") jsonSchema.strict = value.strict;

  const next: JsonRecord = { ...value, json_schema: jsonSchema };
  delete next.name;
  delete next.schema;
  delete next.strict;
  return { value: next, changed: true };
}

export function repairOpenAIRequestProtocol(
  body: unknown,
  context: { provider?: string | null; model?: string | null } = {}
): unknown {
  if (!enabled() || !isRecord(body)) return body;
  const next: JsonRecord = { ...body };
  const repairs: string[] = [];

  const existingTools = Array.isArray(next.tools) ? next.tools : [];
  const legacyFunctions = Array.isArray(next.functions) ? next.functions : [];
  if (legacyFunctions.length > 0) {
    const wrappedLegacy = legacyFunctions
      .map((entry) => normalizeFunctionDefinition(entry))
      .filter((entry): entry is JsonRecord => entry !== null)
      .map((entry) => ({ type: "function", function: entry }));
    if (wrappedLegacy.length > 0) {
      next.tools = [...existingTools, ...wrappedLegacy];
      repairs.push("legacy_functions");
    }
    delete next.functions;
  }

  if (Array.isArray(next.tools)) {
    let toolsChanged = false;
    next.tools = next.tools.map((tool) => {
      const normalized = normalizeTool(tool);
      if (normalized.changed) toolsChanged = true;
      return normalized.tool;
    });
    if (toolsChanged) repairs.push("tool_shape");
  }

  if (next.function_call !== undefined) {
    if (next.tool_choice === undefined) {
      const normalized = normalizeToolChoice(next.function_call);
      next.tool_choice = normalized.value;
    }
    delete next.function_call;
    repairs.push("legacy_function_call");
  } else if (next.tool_choice !== undefined) {
    const normalized = normalizeToolChoice(next.tool_choice);
    if (normalized.changed) {
      next.tool_choice = normalized.value;
      repairs.push("tool_choice");
    }
  }

  const responseFormat = normalizeJsonSchemaResponseFormat(next.response_format);
  if (responseFormat.changed) {
    next.response_format = responseFormat.value;
    repairs.push("response_format");
  }

  const hasTools = Array.isArray(next.tools) && next.tools.length > 0;
  if (!hasTools) {
    if (next.tool_choice !== undefined) {
      delete next.tool_choice;
      repairs.push("stale_tool_choice");
    }
    if (next.parallel_tool_calls !== undefined) {
      delete next.parallel_tool_calls;
      repairs.push("stale_parallel_tool_calls");
    }
  }

  const provider = context.provider || "";
  const model = context.model || "";
  if (provider && model) {
    const profile = profiles.get(keyFor(provider, model));
    for (const parameter of profile?.learnedUnsupportedParameters ?? []) {
      if (SAFE_OPTIONAL_PARAMETERS.has(parameter) && parameter in next) {
        delete next[parameter];
        repairs.push(`learned_parameter:${parameter}`);
      }
    }
  }

  recordRepair(provider, model, "request", repairs);
  return repairs.length > 0 ? next : body;
}

function normalizeToolArguments(value: unknown): string {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value !== "string") {
    try {
      return JSON.stringify(value);
    } catch {
      return "{}";
    }
  }

  let candidate = value.trim();
  if (!candidate) return "{}";
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidate = fenced[1].trim();

  try {
    let parsed: unknown = JSON.parse(candidate);
    if (typeof parsed === "string") {
      const nested = parsed.trim();
      if (nested.startsWith("{") || nested.startsWith("[")) {
        parsed = JSON.parse(nested);
      }
    }
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed);
  } catch {
    // Keep the provider string when it is not safely parseable.
  }
  return value;
}

function parseTextualToolCall(content: unknown): { name: string; arguments: string } | null {
  if (typeof content !== "string") return null;
  const match = content.match(/^\s*\[Tool call:\s*([^\]\n]+)\]\s*\nArguments:\s*([\s\S]+?)\s*$/i);
  if (!match) return null;
  const name = match[1]?.trim() || "";
  const rawArgs = match[2]?.trim() || "";
  if (!name || !rawArgs) return null;
  try {
    let parsed: unknown = JSON.parse(rawArgs);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    if (!parsed || typeof parsed !== "object") return null;
    return { name, arguments: JSON.stringify(parsed) };
  } catch {
    return null;
  }
}

function normalizeResponseToolCall(
  value: unknown,
  choiceIndex: number,
  callIndex: number
): { value: unknown; changed: boolean } {
  if (!isRecord(value)) return { value, changed: false };
  const fn = isRecord(value.function) ? value.function : value;
  const name = typeof fn.name === "string" ? fn.name.trim() : "";
  if (!name) return { value, changed: false };
  const args = normalizeToolArguments(fn.arguments);
  const id =
    typeof value.id === "string" && value.id.trim()
      ? value.id
      : `call_cobalt_${choiceIndex}_${callIndex}`;
  const normalized: JsonRecord = {
    ...value,
    id,
    type: "function",
    function: {
      ...(isRecord(value.function) ? value.function : {}),
      name,
      arguments: args,
    },
  };
  delete normalized.name;
  delete normalized.arguments;
  const changed =
    value.id !== id ||
    value.type !== "function" ||
    !isRecord(value.function) ||
    value.function.name !== name ||
    value.function.arguments !== args;
  return { value: normalized, changed };
}

export function repairOpenAIProtocolResponse(body: unknown): unknown {
  if (!enabled() || !isRecord(body) || !Array.isArray(body.choices)) return body;

  let changed = false;
  const choices = body.choices.map((choiceValue, choiceIndex) => {
    if (!isRecord(choiceValue) || !isRecord(choiceValue.message)) return choiceValue;
    const choice: JsonRecord = { ...choiceValue };
    const message: JsonRecord = { ...choiceValue.message };

    if (!Array.isArray(message.tool_calls) && isRecord(message.function_call)) {
      message.tool_calls = [
        {
          id: `call_cobalt_${choiceIndex}_0`,
          type: "function",
          function: {
            name:
              typeof message.function_call.name === "string"
                ? message.function_call.name.trim()
                : "",
            arguments: normalizeToolArguments(message.function_call.arguments),
          },
        },
      ];
      delete message.function_call;
      changed = true;
    }

    if (Array.isArray(message.tool_calls)) {
      let toolsChanged = false;
      message.tool_calls = message.tool_calls.map((call, callIndex) => {
        const normalized = normalizeResponseToolCall(call, choiceIndex, callIndex);
        if (normalized.changed) toolsChanged = true;
        return normalized.value;
      });
      if (toolsChanged) changed = true;
    }

    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      const textual = parseTextualToolCall(message.content);
      if (textual) {
        message.tool_calls = [
          {
            id: `call_cobalt_${choiceIndex}_0`,
            type: "function",
            function: { name: textual.name, arguments: textual.arguments },
          },
        ];
        message.content = "";
        changed = true;
      }
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      if (choice.finish_reason == null || choice.finish_reason === "stop") {
        choice.finish_reason = "tool_calls";
        changed = true;
      }
    }

    choice.message = message;
    return choice;
  });

  if (!changed) return body;
  return { ...body, choices };
}

export function getProtocolCompatibilitySnapshot(): ProtocolCompatibilitySnapshot {
  const values = [...profiles.values()].map((profile) => ({
    ...profile,
    learnedUnsupportedParameters: [...profile.learnedUnsupportedParameters],
  }));
  const providers = new Set(values.map((entry) => entry.provider));

  return {
    generatedAt: Date.now(),
    enabled: enabled(),
    summary: {
      modelCount: values.length,
      providerCount: providers.size,
      successes: values.reduce((sum, entry) => sum + entry.successes, 0),
      failures: values.reduce((sum, entry) => sum + entry.failures, 0),
      repairsApplied: values.reduce((sum, entry) => sum + entry.repairsApplied, 0),
      toolFailures: values.reduce((sum, entry) => sum + entry.toolFailures, 0),
      schemaFailures: values.reduce((sum, entry) => sum + entry.schemaFailures, 0),
      responseShapeFailures: values.reduce((sum, entry) => sum + entry.responseShapeFailures, 0),
      unsupportedParameterFailures: values.reduce(
        (sum, entry) => sum + entry.unsupportedParameterFailures,
        0
      ),
      learnedUnsupportedParameters: values.reduce(
        (sum, entry) => sum + entry.learnedUnsupportedParameters.length,
        0
      ),
    },
    models: values
      .sort(
        (a, b) =>
          b.failures - a.failures ||
          b.repairsApplied - a.repairsApplied ||
          a.compatibilityScore - b.compatibilityScore ||
          b.updatedAt - a.updatedAt
      )
      .slice(0, 100),
  };
}

/** Test/ops hook. Compatibility evidence is intentionally ephemeral. */
export function resetProtocolCompatibility(): void {
  profiles.clear();
}
