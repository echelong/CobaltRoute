import test from "node:test";
import assert from "node:assert/strict";
import {
  getAdaptiveLearningSnapshot,
  resetAdaptiveLearning,
} from "../../open-sse/services/autoCombo/adaptiveRouter.ts";
import {
  getCodingFeedbackSnapshot,
  recordCodingVerification,
  resetCodingFeedback,
} from "../../open-sse/services/autoCombo/codingFeedback.ts";

process.env.COBALTROUTE_ADAPTIVE_PERSIST = "0";
process.env.COBALTROUTE_CODING_FEEDBACK_PERSIST = "0";

function reset(): void {
  resetAdaptiveLearning();
  resetCodingFeedback();
}

function closeTo(actual: number, expected: number, epsilon = 1e-12): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

test("all-passing deterministic checks teach a perfect coding outcome", () => {
  reset();

  const result = recordCodingVerification({
    provider: "provider-a",
    model: "code-model",
    taskType: "coding",
    verificationId: "job-pass-1",
    checks: [
      { kind: "test", status: "pass" },
      { kind: "build", status: "pass" },
      { kind: "typecheck", status: "pass" },
    ],
  });

  assert.equal(result.duplicate, false);
  assert.equal(result.reward, 1);
  assert.equal(result.checksApplied, 3);

  const adaptive = getAdaptiveLearningSnapshot("coding")[0];
  assert.ok(adaptive);
  assert.equal(adaptive.observations, 1);
  assert.equal(adaptive.rewardMean, 1);
  assert.equal(adaptive.positiveOutcomes, 1);
});

test("mixed verifier checks become one weighted semantic reward", () => {
  reset();

  const result = recordCodingVerification({
    provider: "provider-a",
    model: "code-model",
    checks: [
      { kind: "test", status: "pass" },
      { kind: "build", status: "pass" },
      { kind: "lint", status: "fail" },
    ],
  });

  assert.notEqual(result.reward, null);
  closeTo(result.reward!, 2 / 2.6);

  const adaptive = getAdaptiveLearningSnapshot("coding")[0];
  assert.ok(adaptive);
  closeTo(adaptive.rewardMean, 2 / 2.6);
  assert.equal(adaptive.observations, 1);
});

test("skipped checks are tracked but do not affect reward", () => {
  reset();

  const result = recordCodingVerification({
    provider: "provider-b",
    model: "code-model-b",
    checks: [
      { kind: "test", status: "pass" },
      { kind: "lint", status: "skipped" },
    ],
  });

  assert.equal(result.reward, 1);
  assert.equal(result.checksApplied, 1);
  assert.equal(result.aggregate?.checks, 2);
  assert.equal(result.aggregate?.passed, 1);
  assert.equal(result.aggregate?.skipped, 1);
});

test("verification ids make retries idempotent", () => {
  reset();

  const report = {
    provider: "provider-c",
    model: "code-model-c",
    verificationId: "same-ci-job",
    checks: [{ kind: "test" as const, status: "pass" as const }],
  };

  const first = recordCodingVerification(report);
  const second = recordCodingVerification(report);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.reward, null);
  assert.equal(second.checksApplied, 0);

  const adaptive = getAdaptiveLearningSnapshot("coding")[0];
  assert.ok(adaptive);
  assert.equal(adaptive.observations, 1);

  const coding = getCodingFeedbackSnapshot();
  assert.equal(coding.summary.reports, 1);
  assert.equal(coding.summary.checks, 1);
});

test("all-skipped reports are rejected and do not teach the router", () => {
  reset();

  assert.throws(
    () =>
      recordCodingVerification({
        provider: "provider-d",
        model: "code-model-d",
        checks: [{ kind: "lint", status: "skipped" }],
      }),
    /at least one non-skipped check/
  );

  assert.equal(getAdaptiveLearningSnapshot("coding").length, 0);
});

test("coding feedback snapshot aggregates objective pass rates by verifier kind", () => {
  reset();

  recordCodingVerification({
    provider: "provider-a",
    model: "model-a",
    verificationId: "aggregate-a",
    checks: [
      { kind: "test", status: "pass" },
      { kind: "typecheck", status: "pass" },
    ],
  });
  recordCodingVerification({
    provider: "provider-b",
    model: "model-b",
    verificationId: "aggregate-b",
    checks: [
      { kind: "test", status: "fail" },
      { kind: "lint", status: "partial" },
    ],
  });

  const snapshot = getCodingFeedbackSnapshot();
  assert.equal(snapshot.summary.reports, 2);
  assert.equal(snapshot.summary.checks, 4);
  assert.equal(snapshot.summary.passed, 2);
  assert.equal(snapshot.summary.failed, 1);
  assert.equal(snapshot.summary.partial, 1);
  assert.equal(snapshot.summary.modelCount, 2);
  closeTo(snapshot.summary.objectiveSuccessRate, 2.5 / 4);

  const testKind = snapshot.byKind.find((entry) => entry.kind === "test");
  assert.ok(testKind);
  assert.equal(testKind.checks, 2);
  assert.equal(testKind.passed, 1);
  assert.equal(testKind.failed, 1);
});
