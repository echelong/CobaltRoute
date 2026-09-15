import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProtocolCompatibilityFailure,
  getProtocolCompatibilityScore,
  getProtocolCompatibilitySnapshot,
  recordProtocolCompatibilityFailure,
  recordProtocolCompatibilitySuccess,
  repairOpenAIProtocolResponse,
  repairOpenAIRequestProtocol,
  resetProtocolCompatibility,
} from "../../open-sse/services/autoCombo/protocolCompatibility.ts";

process.env.COBALTROUTE_PROTOCOL_COMPATIBILITY = "1";

function reset() {
  resetProtocolCompatibility();
  process.env.COBALTROUTE_PROTOCOL_COMPATIBILITY = "1";
}

test("cold compatibility is neutral", () => {
  reset();
  assert.equal(getProtocolCompatibilityScore("alpha", "model-a"), 1);
});

test("legacy functions and function_call become modern tools", () => {
  reset();
  const repaired = repairOpenAIRequestProtocol(
    {
      functions: [
        {
          name: "lookup",
          description: "Look something up",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      function_call: { name: "lookup" },
    },
    { provider: "alpha", model: "model-a" }
  ) as Record<string, unknown>;

  assert.equal("functions" in repaired, false);
  assert.equal("function_call" in repaired, false);
  assert.equal(Array.isArray(repaired.tools), true);
  assert.deepEqual(repaired.tool_choice, {
    type: "function",
    function: { name: "lookup" },
  });
});

test("bare tools and legacy json_schema response format are normalized", () => {
  reset();
  const repaired = repairOpenAIRequestProtocol({
    tools: [{ name: "ping" }],
    response_format: {
      type: "json_schema",
      name: "answer",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
      strict: true,
    },
  }) as Record<string, unknown>;

  const tools = repaired.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0]?.type, "function");
  assert.deepEqual((tools[0]?.function as Record<string, unknown>).parameters, {
    type: "object",
    properties: {},
  });

  const format = repaired.response_format as Record<string, unknown>;
  assert.equal("schema" in format, false);
  assert.deepEqual(format.json_schema, {
    name: "answer",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
    strict: true,
  });
});

test("OpenAI response repair fixes tool ids and object arguments", () => {
  reset();
  const repaired = repairOpenAIProtocolResponse({
    id: "chatcmpl-test",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ function: { name: "lookup", arguments: { q: "cobalt" } } }],
        },
        finish_reason: "stop",
      },
    ],
  }) as Record<string, unknown>;

  const choice = (repaired.choices as Array<Record<string, unknown>>)[0]!;
  const message = choice.message as Record<string, unknown>;
  const call = (message.tool_calls as Array<Record<string, unknown>>)[0]!;
  const fn = call.function as Record<string, unknown>;

  assert.equal(call.type, "function");
  assert.equal(typeof call.id, "string");
  assert.equal(fn.arguments, JSON.stringify({ q: "cobalt" }));
  assert.equal(choice.finish_reason, "tool_calls");
});

test("textual tool marker becomes a structured call only with valid JSON", () => {
  reset();
  const repaired = repairOpenAIProtocolResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: '[Tool call: search]\nArguments: {"q":"router"}',
        },
      },
    ],
  }) as Record<string, unknown>;

  const choice = (repaired.choices as Array<Record<string, unknown>>)[0]!;
  const message = choice.message as Record<string, unknown>;
  const call = (message.tool_calls as Array<Record<string, unknown>>)[0]!;
  assert.equal((call.function as Record<string, unknown>).name, "search");
  assert.equal(choice.finish_reason, "tool_calls");
});

test("protocol failures lower compatibility while operational failures do not", () => {
  reset();
  assert.ok(
    recordProtocolCompatibilityFailure({
      provider: "alpha",
      model: "model-a",
      error: "invalid tool call arguments",
      status: 400,
    })
  );
  const degraded = getProtocolCompatibilityScore("alpha", "model-a");
  assert.ok(degraded < 1);

  assert.equal(
    recordProtocolCompatibilityFailure({
      provider: "beta",
      model: "model-b",
      error: "429 quota exhausted",
      status: 429,
    }),
    null
  );
  assert.equal(getProtocolCompatibilityScore("beta", "model-b"), 1);
});

test("successful requests recover an existing compatibility profile", () => {
  reset();
  recordProtocolCompatibilityFailure({
    provider: "alpha",
    model: "model-a",
    error: "malformed response shape",
    status: 400,
  });
  const before = getProtocolCompatibilityScore("alpha", "model-a");
  recordProtocolCompatibilitySuccess("alpha", "model-a");
  const after = getProtocolCompatibilityScore("alpha", "model-a");
  assert.ok(after > before);
});

test("unsupported optional parameter is learned and removed from later requests", () => {
  reset();
  const classified = classifyProtocolCompatibilityFailure(
    "Unrecognized request argument supplied: temperature",
    400
  );
  assert.deepEqual(classified, { kind: "unsupported_parameter", parameter: "temperature" });

  recordProtocolCompatibilityFailure({
    provider: "quirky",
    model: "free-model",
    error: "Unrecognized request argument supplied: temperature",
    status: 400,
  });

  const repaired = repairOpenAIRequestProtocol(
    { messages: [{ role: "user", content: "hi" }], temperature: 0.2, top_p: 0.9 },
    { provider: "quirky", model: "quirky/free-model" }
  ) as Record<string, unknown>;

  assert.equal("temperature" in repaired, false);
  assert.equal(repaired.top_p, 0.9);
});

test("snapshot is aggregate-only and never exposes request content or connection ids", () => {
  reset();
  recordProtocolCompatibilityFailure({
    provider: "private-provider",
    model: "private-model",
    error: "invalid schema",
    status: 400,
  });
  repairOpenAIRequestProtocol(
    {
      messages: [{ role: "user", content: "SECRET-PROMPT-CONTENT" }],
      functions: [{ name: "x" }],
    },
    {
      provider: "private-provider",
      model: "private-model",
    }
  );

  const serialized = JSON.stringify(getProtocolCompatibilitySnapshot());
  assert.equal(serialized.includes("SECRET-PROMPT-CONTENT"), false);
  assert.equal(serialized.includes("connectionId"), false);
  assert.equal(serialized.includes("headers"), false);
});
