import { type Attributes, context, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";
import { summarizeTestCases, type TestCase } from "../test-results";

interface TestCaseJobContext {
  id: number;
  name: string;
  run_id: number;
  run_attempt?: number;
  head_sha: string;
  head_branch?: string | null;
  started_at: string;
  completed_at: string;
}

/** One parsed JUnit file: its display name and the cases it reported. */
interface TestReport {
  name: string;
  cases: TestCase[];
}

/**
 * Each report gets a wrapper span carrying that file's rollup, so a job with
 * several JUnit files keeps them apart instead of one flat list of tests.
 *
 * JUnit reports carry durations but no per-test timestamps, so every test span
 * is anchored at the job start; durations are exact, overlaps are expected
 * (tests run in parallel anyway). The wrapper covers the job's own window.
 */
function traceTestReports(reports: TestReport[], job: TestCaseJobContext): void {
  const tracer = trace.getTracer("otel-cicd-export-action");
  const startTime = new Date(job.started_at);
  // Some skipped and post jobs report completed_at before started_at.
  const endTime = new Date(Math.max(startTime.getTime(), new Date(job.completed_at).getTime()));

  for (const report of reports) {
    tracer.startActiveSpan(
      `Tests / ${report.name}`,
      { attributes: reportToAttributes(report, job), startTime, kind: SpanKind.INTERNAL },
      (reportSpan) => {
        for (const testCase of report.cases) {
          traceTestCase(testCase, job, tracer, startTime);
        }
        reportSpan.end(endTime);
      },
    );
  }
}

function traceTestCase(
  testCase: TestCase,
  job: TestCaseJobContext,
  tracer: ReturnType<typeof trace.getTracer>,
  startTime: Date,
): void {
  const span = tracer.startSpan(testCase.name, {
    attributes: testCaseToAttributes(testCase, job),
    startTime,
    kind: SpanKind.INTERNAL,
  });

  if (testCase.status === "failed" || testCase.status === "error") {
    span.setStatus({ code: SpanStatusCode.ERROR, ...(testCase.message ? { message: testCase.message } : {}) });
    span.setAttribute(ATTR_ERROR_TYPE, testCase.status);
    emitTestFailureLog(testCase, job, span, startTime);
  }

  span.end(new Date(startTime.getTime() + testCase.timeSeconds * 1000));
}

function reportToAttributes(report: TestReport, job: TestCaseJobContext): Attributes {
  const summary = summarizeTestCases(report.cases);
  return {
    "test.report": report.name,
    "test.suites": summary.suites,
    "test.total": summary.total,
    "test.passed": summary.passed,
    "test.failed": summary.failed,
    "test.skipped": summary.skipped,
    "test.errors": summary.errors,
    "test.duration": summary.duration,
    "github.job.id": job.id,
    "github.job.name": job.name,
    "github.run_id": job.run_id,
    "github.run_attempt": job.run_attempt ?? 1,
    "github.head_sha": job.head_sha,
    ...(job.head_branch ? { "github.head_branch": job.head_branch } : {}),
    error: summary.failed + summary.errors > 0,
  };
}

/**
 * Correlating the record with the test's span is what makes a red span show
 * what the test printed. Only failures: passing-test stdout has no consumer
 * and real volume.
 */
function emitTestFailureLog(testCase: TestCase, job: TestCaseJobContext, span: Span, startTime: Date): void {
  const body = [testCase.message, testCase.output].filter(Boolean).join("\n");
  if (!body) {
    return;
  }

  const logger = logs.getLogger("otel-cicd-export-action");
  logger.emit({
    timestamp: startTime,
    body,
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    context: trace.setSpan(context.active(), span),
    attributes: {
      "test.name": testCase.name,
      "test.classname": testCase.classname,
      "test.suite": testCase.suite,
      "test.status": testCase.status,
      "github.job.id": job.id,
      "github.job.name": job.name,
    },
  });
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

export { traceTestReports, type TestCaseJobContext, type TestReport };
