import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { type Context, context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { TestCase } from "../test-results";
import { aJobContext, aJobName, aPackageName, aTestCase, aTestName } from "../__fixtures__/builders";

const emit = jest.fn<(record: Record<string, unknown>) => void>();
const getLogger = jest.fn(() => ({ emit }));
const SeverityNumber = { INFO: 9, WARN: 13, ERROR: 17 };
jest.unstable_mockModule("@opentelemetry/api-logs", () => ({
  logs: { getLogger },
  SeverityNumber,
}));

const { traceTestReports } = await import("./test-trace.js");

function aTestReport(name: string, cases: TestCase[]): { name: string; cases: TestCase[] } {
  return { name, cases };
}

function hrTimeToMs(value: [number, number]): number {
  return value[0] * 1000 + value[1] / 1_000_000;
}

describe("traceTestCases", () => {
  const exporter = new InMemorySpanExporter();

  beforeAll(() => {
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(() => {
    exporter.reset();
    emit.mockClear();
  });

  afterAll(() => {
    trace.disable();
  });

  function spanFor(testCase: { name: string }): ReadableSpan | undefined {
    return exporter.getFinishedSpans().find((span) => span.name === testCase.name);
  }

  it("nests each report's test cases under a per-report wrapper span, itself under the job span", () => {
    const job = aJobContext();
    const jobSpanName = aJobName();
    const report = aTestReport(aPackageName(), [aTestCase(), aTestCase()]);

    trace.getTracer("test").startActiveSpan(jobSpanName, (jobSpan) => {
      traceTestReports([report], job);
      jobSpan.end();

      const wrapper = exporter.getFinishedSpans().find((span) => span.name === `Tests / ${report.name}`);
      expect(wrapper?.parentSpanContext?.spanId).toBe(jobSpan.spanContext().spanId);

      const testSpans = report.cases.map((testCase) => spanFor(testCase));
      expect(testSpans).toHaveLength(report.cases.length);
      for (const span of testSpans) {
        expect(span?.parentSpanContext?.spanId).toBe(wrapper?.spanContext().spanId);
        expect(span?.spanContext().traceId).toBe(jobSpan.spanContext().traceId);
        expect(span?.kind).toBe(SpanKind.INTERNAL);
      }
    });
  });

  it("gives each report its own wrapper so two reports on one job stay distinct", () => {
    const first = aTestReport(aPackageName(), [aTestCase()]);
    const second = aTestReport(aPackageName(), [aTestCase(), aTestCase()]);

    traceTestReports([first, second], aJobContext());

    const wrappers = exporter.getFinishedSpans().filter((span) => span.name.startsWith("Tests / "));
    expect(wrappers.map((span) => span.name)).toEqual([`Tests / ${first.name}`, `Tests / ${second.name}`]);
    for (const report of [first, second]) {
      const wrapperId = wrappers.find((span) => span.name === `Tests / ${report.name}`)?.spanContext().spanId;
      for (const testCase of report.cases) {
        expect(spanFor(testCase)?.parentSpanContext?.spanId).toBe(wrapperId);
      }
    }
  });

  it("rolls that report's counts up onto its wrapper span", () => {
    const report = aTestReport(aPackageName(), [
      aTestCase({ status: "passed", timeSeconds: 2 }),
      aTestCase({ status: "failed", timeSeconds: 3 }),
      aTestCase({ status: "skipped", timeSeconds: 0 }),
      aTestCase({ status: "error", timeSeconds: 1 }),
      aTestCase({ status: "pending", timeSeconds: 0 }),
      aTestCase({ status: "other", timeSeconds: 0 }),
    ]);

    traceTestReports([report], aJobContext());

    expect(
      exporter.getFinishedSpans().find((span) => span.name === `Tests / ${report.name}`)?.attributes,
    ).toMatchObject({
      "test.total": report.cases.length,
      "test.passed": 1,
      "test.failed": 1,
      "test.skipped": 1,
      "test.errors": 1,
      "test.pending": 1,
      "test.other": 1,
      "test.duration": 6,
    });
  });

  it("spans the wrapper over the job's own window", () => {
    const job = aJobContext();
    const report = aTestReport(aPackageName(), [aTestCase()]);

    traceTestReports([report], job);

    const wrapper = exporter.getFinishedSpans().find((span) => span.name === `Tests / ${report.name}`);
    expect(wrapper).toBeDefined();
    if (!wrapper) return;

    expect(hrTimeToMs(wrapper.startTime)).toBe(new Date(job.started_at).getTime());
    expect(hrTimeToMs(wrapper.endTime)).toBe(
      Math.max(new Date(job.started_at).getTime(), new Date(job.completed_at).getTime()),
    );
  });

  it("sets test and github attributes on each span", () => {
    const testCase = aTestCase();
    const job = aJobContext();

    traceTestReports([aTestReport(aPackageName(), [testCase])], job);

    expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
      "test.name": testCase.name,
      "test.classname": testCase.classname,
      "test.suite": testCase.suite,
      "test.status": testCase.status,
      "test.duration_ms": Math.round(testCase.timeSeconds * 1000),
      "test.leaf": testCase.leaf,
      "test.collateral": testCase.collateral,
      "github.job.id": job.id,
      "github.job.name": job.name,
      "github.run_id": job.run_id,
      "github.run_attempt": job.run_attempt,
      "github.head_sha": job.head_sha,
      "github.head_branch": job.head_branch,
    });
  });

  it("anchors span timing at the job start with the case duration", () => {
    const testCase = aTestCase();
    const job = aJobContext();

    traceTestReports([aTestReport(aPackageName(), [testCase])], job);

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;

    expect(hrTimeToMs(span.startTime)).toBe(new Date(job.started_at).getTime());
    expect(hrTimeToMs(span.endTime) - hrTimeToMs(span.startTime)).toBeCloseTo(testCase.timeSeconds * 1000);
  });

  it("starts a span at the case's own start time when it is inside the job window", () => {
    const job = aJobContext();
    const startedAt = new Date(job.started_at).getTime() + 1000;
    const testCase = aTestCase({ startedAt, timeSeconds: 2 });

    traceTestReports([aTestReport(aPackageName(), [testCase])], job);

    const span = spanFor(testCase);
    expect(span).toBeDefined();
    if (!span) return;

    expect(hrTimeToMs(span.startTime)).toBe(startedAt);
    expect(hrTimeToMs(span.endTime)).toBe(startedAt + 2000);
  });

  it("anchors at the job start when the case's start time is outside the job window", () => {
    const job = aJobContext();
    const jobStart = new Date(job.started_at).getTime();
    const early = aTestCase({ startedAt: jobStart - 1 });
    const late = aTestCase({ startedAt: new Date(job.completed_at).getTime() + 1 });

    traceTestReports([aTestReport(aPackageName(), [early, late])], job);

    expect(hrTimeToMs(spanFor(early)?.startTime ?? [0, 0])).toBe(jobStart);
    expect(hrTimeToMs(spanFor(late)?.startTime ?? [0, 0])).toBe(jobStart);
  });

  it("marks failed and errored cases as error spans with the failure message", () => {
    const failed = aTestCase({ status: "failed", message: `assertion mismatch ${aTestName()}` });
    const errored = aTestCase({ status: "error" });
    const passed = aTestCase();

    traceTestReports([aTestReport(aPackageName(), [failed, errored, passed])], aJobContext());

    expect(spanFor(failed)).toMatchObject({
      status: { code: SpanStatusCode.ERROR },
      attributes: { "test.failure.message": failed.message, error: true },
    });
    expect(spanFor(errored)?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spanFor(passed)?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(spanFor(passed)?.attributes["error"]).toBe(false);
  });

  it.each(["skipped", "pending", "other"] as const)("emits %s cases with their status and no error", (status) => {
    const testCase = aTestCase({ status, timeSeconds: 0 });

    traceTestReports([aTestReport(aPackageName(), [testCase])], aJobContext());

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes["test.status"]).toBe(status);
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("emits a log record with the failure output, correlated to the failed test's span", () => {
    const failed = aTestCase({
      status: "failed",
      message: `assertion mismatch ${aTestName()}`,
      output: `stdout ${aTestName()}`,
    });
    const passed = aTestCase({ output: `stdout ${aTestName()}` });
    const job = aJobContext();

    traceTestReports([aTestReport(aPackageName(), [failed, passed])], job);

    expect(emit).toHaveBeenCalledTimes(1);
    const record = emit.mock.calls[0]?.[0];
    expect(record?.["severityText"]).toBe("ERROR");
    expect(record?.["body"]).toContain(failed.message);
    expect(record?.["body"]).toContain(failed.output);
    expect(record?.["attributes"]).toMatchObject({
      "test.name": failed.name,
      "test.status": failed.status,
      "github.job.name": job.name,
    });

    const failedSpan = spanFor(failed);
    expect(record?.["timestamp"]).toEqual(new Date(job.started_at));
    const recordSpan = trace.getSpan(record?.["context"] as Context);
    expect(recordSpan?.spanContext().spanId).toBe(failedSpan?.spanContext().spanId);
    expect(recordSpan?.spanContext().traceId).toBe(failedSpan?.spanContext().traceId);
  });

  it("emits no log record for failures without message or output", () => {
    traceTestReports([aTestReport(aPackageName(), [aTestCase({ status: "failed" })])], aJobContext());

    expect(emit).not.toHaveBeenCalled();
  });
});
