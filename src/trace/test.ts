import { type Attributes, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";
import type { TestCase } from "../test-results";

/** The slice of a workflow job needed to contextualize its test-case spans. */
interface TestCaseJobContext {
  id: number;
  name: string;
  run_id: number;
  run_attempt?: number;
  head_sha: string;
  head_branch?: string | null;
  started_at: string;
}

/**
 * Emit one span per test case as children of the active (job) span.
 *
 * JUnit reports carry durations but no per-test timestamps, so every span is
 * anchored at the job start; durations are exact, overlaps are expected
 * (tests run in parallel anyway).
 */
function traceTestCases(testCases: TestCase[], job: TestCaseJobContext): void {
  const tracer = trace.getTracer("otel-cicd-export-action");
  const startTime = new Date(job.started_at);

  for (const testCase of testCases) {
    const span = tracer.startSpan(testCase.name, {
      attributes: testCaseToAttributes(testCase, job),
      startTime,
      kind: SpanKind.INTERNAL,
    });

    if (testCase.status === "failed" || testCase.status === "error") {
      span.setStatus({ code: SpanStatusCode.ERROR, ...(testCase.message ? { message: testCase.message } : {}) });
      span.setAttribute(ATTR_ERROR_TYPE, testCase.status);
    }

    span.end(new Date(startTime.getTime() + testCase.timeSeconds * 1000));
  }
}

function testCaseToAttributes(testCase: TestCase, job: TestCaseJobContext): Attributes {
  return {
    "test.name": testCase.name,
    "test.classname": testCase.classname,
    "test.suite": testCase.suite,
    "test.status": testCase.status,
    "test.duration_ms": Math.round(testCase.timeSeconds * 1000),
    "test.leaf": testCase.leaf,
    "test.collateral": testCase.collateral,
    ...(testCase.message ? { "test.failure.message": testCase.message } : {}),
    "github.job.id": job.id,
    "github.job.name": job.name,
    "github.run_id": job.run_id,
    "github.run_attempt": job.run_attempt ?? 1,
    "github.head_sha": job.head_sha,
    ...(job.head_branch ? { "github.head_branch": job.head_branch } : {}),
    error: testCase.status === "failed" || testCase.status === "error",
  };
}

export { traceTestCases, type TestCaseJobContext };
