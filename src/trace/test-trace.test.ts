import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { type Context, context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { aJobContext, aJobName, aTestCase, aTestName } from "../__fixtures__/builders";

const emit = jest.fn<(record: Record<string, unknown>) => void>();
const getLogger = jest.fn(() => ({ emit }));
const SeverityNumber = { INFO: 9, WARN: 13, ERROR: 17 };
jest.unstable_mockModule("@opentelemetry/api-logs", () => ({
  logs: { getLogger },
  SeverityNumber,
}));

const { traceTestCases } = await import("./test-trace.js");

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

  it("emits one span per test case, parented to the active (job) span", () => {
    const job = aJobContext();
    const jobSpanName = aJobName();

    trace.getTracer("test").startActiveSpan(jobSpanName, (jobSpan) => {
      traceTestCases([aTestCase(), aTestCase()], job);
      jobSpan.end();

      const testSpans = exporter.getFinishedSpans().filter((span) => span.name !== jobSpanName);
      expect(testSpans).toHaveLength(2);
      for (const span of testSpans) {
        expect(span.parentSpanContext?.spanId).toBe(jobSpan.spanContext().spanId);
        expect(span.spanContext().traceId).toBe(jobSpan.spanContext().traceId);
        expect(span.kind).toBe(SpanKind.INTERNAL);
      }
    });
  });

  it("sets test and github attributes on each span", () => {
    const testCase = aTestCase();
    const job = aJobContext();

    traceTestCases([testCase], job);

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

    traceTestCases([testCase], job);

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;

    expect(hrTimeToMs(span.startTime)).toBe(new Date(job.started_at).getTime());
    expect(hrTimeToMs(span.endTime) - hrTimeToMs(span.startTime)).toBeCloseTo(testCase.timeSeconds * 1000);
  });

  it("marks failed and errored cases as error spans with the failure message", () => {
    const failed = aTestCase({ status: "failed", message: `assertion mismatch ${aTestName()}` });
    const errored = aTestCase({ status: "error" });
    const passed = aTestCase();

    traceTestCases([failed, errored, passed], aJobContext());

    const byName = new Map(exporter.getFinishedSpans().map((span) => [span.name, span]));
    expect(byName.get(failed.name)?.status.code).toBe(SpanStatusCode.ERROR);
    expect(byName.get(failed.name)?.attributes["test.failure.message"]).toBe(failed.message);
    expect(byName.get(failed.name)?.attributes["error"]).toBe(true);
    expect(byName.get(errored.name)?.status.code).toBe(SpanStatusCode.ERROR);
    expect(byName.get(passed.name)?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(byName.get(passed.name)?.attributes["error"]).toBe(false);
  });

  it("emits skipped cases with a skipped status and no error", () => {
    const skipped = aTestCase({ status: "skipped", timeSeconds: 0 });

    traceTestCases([skipped], aJobContext());

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes["test.status"]).toBe("skipped");
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

    traceTestCases([failed, passed], job);

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

    const failedSpan = exporter.getFinishedSpans().find((span) => span.name === failed.name);
    const recordSpan = trace.getSpan(record?.["context"] as Context);
    expect(recordSpan?.spanContext().spanId).toBe(failedSpan?.spanContext().spanId);
    expect(recordSpan?.spanContext().traceId).toBe(failedSpan?.spanContext().traceId);
  });

  it("emits no log record for failures without message or output", () => {
    traceTestCases([aTestCase({ status: "failed" })], aJobContext());

    expect(emit).not.toHaveBeenCalled();
  });
});
