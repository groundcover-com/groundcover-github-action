import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { type Context, context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { TestCase } from "../test-results";

const emit = jest.fn<(record: Record<string, unknown>) => void>();
const getLogger = jest.fn(() => ({ emit }));
const SeverityNumber = { INFO: 9, WARN: 13, ERROR: 17 };
jest.unstable_mockModule("@opentelemetry/api-logs", () => ({
  logs: { getLogger },
  SeverityNumber,
}));

const { traceTestCases } = await import("./test-trace.js");
type TestCaseJobContext = Parameters<typeof traceTestCases>[1];

function hrTimeToMs(value: [number, number]): number {
  return value[0] * 1000 + value[1] / 1_000_000;
}

function buildCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    name: "TestSuite/TestAll/leaf_case",
    classname: "metrics/v2",
    suite: "groundcover.com/internal/services/router/api/metrics/v2",
    timeSeconds: 1.5,
    status: "passed",
    leaf: true,
    collateral: false,
    ...overrides,
  };
}

const jobContext: TestCaseJobContext = {
  id: 10,
  name: "test / router:test",
  run_id: 20,
  run_attempt: 2,
  head_sha: "0123456789abcdef0123456789abcdef01234567",
  head_branch: "shaiyallin/dx-657",
  started_at: "2026-01-29T17:16:20Z",
};

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
    const tracer = trace.getTracer("test");
    tracer.startActiveSpan("test / router:test", (jobSpan) => {
      traceTestCases([buildCase(), buildCase({ name: "TestOther" })], jobContext);
      jobSpan.end();

      const spans = exporter.getFinishedSpans();
      const testSpans = spans.filter((s) => s.name !== "test / router:test");
      expect(testSpans).toHaveLength(2);
      for (const span of testSpans) {
        expect(span.parentSpanContext?.spanId).toBe(jobSpan.spanContext().spanId);
        expect(span.spanContext().traceId).toBe(jobSpan.spanContext().traceId);
        expect(span.kind).toBe(SpanKind.INTERNAL);
      }
    });
  });

  it("sets test and github attributes on each span", () => {
    traceTestCases([buildCase()], jobContext);

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes).toMatchObject({
      "test.name": "TestSuite/TestAll/leaf_case",
      "test.classname": "metrics/v2",
      "test.suite": "groundcover.com/internal/services/router/api/metrics/v2",
      "test.status": "passed",
      "test.duration_ms": 1500,
      "test.leaf": true,
      "test.collateral": false,
      "github.job.id": 10,
      "github.job.name": "test / router:test",
      "github.run_id": 20,
      "github.run_attempt": 2,
      "github.head_sha": "0123456789abcdef0123456789abcdef01234567",
      "github.head_branch": "shaiyallin/dx-657",
    });
  });

  it("anchors span timing at the job start with the case duration", () => {
    traceTestCases([buildCase({ timeSeconds: 3 })], jobContext);

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;

    expect(hrTimeToMs(span.startTime)).toBe(new Date(jobContext.started_at).getTime());
    expect(hrTimeToMs(span.endTime) - hrTimeToMs(span.startTime)).toBeCloseTo(3000);
  });

  it("marks failed and errored cases as error spans with the failure message", () => {
    traceTestCases(
      [
        buildCase({ name: "TestFails", status: "failed", message: "Not equal: 5 != 4" }),
        buildCase({ name: "TestErrors", status: "error" }),
        buildCase({ name: "TestPasses" }),
      ],
      jobContext,
    );

    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s]));
    expect(byName.get("TestFails")?.status.code).toBe(SpanStatusCode.ERROR);
    expect(byName.get("TestFails")?.attributes["test.failure.message"]).toBe("Not equal: 5 != 4");
    expect(byName.get("TestFails")?.attributes["error"]).toBe(true);
    expect(byName.get("TestErrors")?.status.code).toBe(SpanStatusCode.ERROR);
    expect(byName.get("TestPasses")?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(byName.get("TestPasses")?.attributes["error"]).toBe(false);
  });

  it("emits skipped cases with a skipped status and no error", () => {
    traceTestCases([buildCase({ name: "TestSkipped", status: "skipped", timeSeconds: 0 })], jobContext);

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes["test.status"]).toBe("skipped");
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("emits a log record with the failure output, correlated to the failed test's span", () => {
    traceTestCases(
      [
        buildCase({ name: "TestFails", status: "failed", message: "Not equal: 5 != 4", output: "=== RUN TestFails" }),
        buildCase({ name: "TestPasses", output: "chatty pass" }),
      ],
      jobContext,
    );

    expect(emit).toHaveBeenCalledTimes(1);
    const record = emit.mock.calls[0]?.[0];
    expect(record?.["severityText"]).toBe("ERROR");
    expect(record?.["body"]).toContain("Not equal: 5 != 4");
    expect(record?.["body"]).toContain("=== RUN TestFails");
    expect(record?.["attributes"]).toMatchObject({
      "test.name": "TestFails",
      "test.status": "failed",
      "github.job.name": "test / router:test",
    });

    const failedSpan = exporter.getFinishedSpans().find((s) => s.name === "TestFails");
    const recordSpan = trace.getSpan(record?.["context"] as Context);
    expect(recordSpan?.spanContext().spanId).toBe(failedSpan?.spanContext().spanId);
    expect(recordSpan?.spanContext().traceId).toBe(failedSpan?.spanContext().traceId);
  });

  it("emits no log record for failures without message or output", () => {
    traceTestCases([buildCase({ name: "TestFails", status: "failed" })], jobContext);

    expect(emit).not.toHaveBeenCalled();
  });
});
