import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { components } from "@octokit/openapi-types";
import {
  ATTR_CICD_PIPELINE_TASK_NAME,
  ATTR_CICD_PIPELINE_TASK_RUN_ID,
  ATTR_CICD_PIPELINE_TASK_RUN_RESULT,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_FAILURE,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SUCCESS,
} from "@opentelemetry/semantic-conventions/incubating";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";

type Step = NonNullable<components["schemas"]["job"]["steps"]>[number];

const info = jest.fn<(message: string | number) => void>();
jest.unstable_mockModule("@actions/core", () => ({ info }));

const { traceStep } = await import("./step.js");

function buildStep(overrides: Partial<Step> = {}): Step {
  return {
    name: "Run tests",
    status: "completed",
    conclusion: "success",
    number: 1,
    started_at: "2026-01-29T17:16:45Z",
    completed_at: "2026-01-29T17:16:50Z",
    ...overrides,
  } as Step;
}

function hrTimeToMs(value: [number, number]): number {
  return value[0] * 1000 + value[1] / 1_000_000;
}

describe("traceStep", () => {
  const exporter = new InMemorySpanExporter();

  beforeAll(() => {
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(() => {
    exporter.reset();
    info.mockClear();
  });

  afterAll(() => {
    trace.disable();
  });

  it("creates a span with the step name", () => {
    traceStep(buildStep({ name: "Install dependencies" }));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("Install dependencies");
  });

  it("skips incomplete steps without completed_at or started_at", () => {
    traceStep(buildStep({ completed_at: null }));
    traceStep(buildStep({ started_at: null }));

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("skips steps with skipped conclusion", () => {
    traceStep(buildStep({ conclusion: "skipped" }));

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(info).toHaveBeenCalledWith("Step Run tests did not run.");
  });

  it("uses started_at as end time when completed_at is older", () => {
    traceStep(
      buildStep({
        started_at: "2026-01-29T17:16:50Z",
        completed_at: "2026-01-29T17:16:45Z",
      }),
    );

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;

    const startMs = hrTimeToMs(span.startTime);
    const endMs = hrTimeToMs(span.endTime);
    expect(endMs).toBe(startMs);
  });

  it("sets error status when a step fails", () => {
    traceStep(buildStep({ conclusion: "failure" }));

    const span = exporter.getFinishedSpans()[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("handles null optional fields in step attributes", () => {
    traceStep(
      buildStep({
        conclusion: null,
        started_at: "2026-01-29T17:16:45Z",
        completed_at: "2026-01-29T17:16:50Z",
      } as unknown as Partial<Step>),
    );

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    expect(span?.attributes["github.job.step.conclusion"]).toBeUndefined();
    expect(span?.attributes["error"]).toBe(false);
  });

  it("handles steps with null started_at and completed_at in attributes", () => {
    traceStep(
      buildStep({
        started_at: "2026-01-29T17:16:45Z",
        completed_at: "2026-01-29T17:16:50Z",
      }),
    );

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes["github.job.step.started_at"]).toBe("2026-01-29T17:16:45Z");
    expect(span?.attributes["github.job.step.completed_at"]).toBe("2026-01-29T17:16:50Z");
  });

  it("sets cicd.pipeline.task.* semconv attributes on step spans", () => {
    traceStep(buildStep({ name: "Run tests", number: 3, conclusion: "success" }), undefined, 10);

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes[ATTR_CICD_PIPELINE_TASK_NAME]).toBe("Run tests");
    expect(span?.attributes[ATTR_CICD_PIPELINE_TASK_RUN_ID]).toBe("10:3");
    expect(span?.attributes[ATTR_CICD_PIPELINE_TASK_RUN_RESULT]).toBe(CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SUCCESS);
  });

  it("sets error.type on failed steps", () => {
    traceStep(buildStep({ conclusion: "failure" }));

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes[ATTR_ERROR_TYPE]).toBe("failure");
    expect(span?.attributes[ATTR_CICD_PIPELINE_TASK_RUN_RESULT]).toBe(CICD_PIPELINE_TASK_RUN_RESULT_VALUE_FAILURE);
  });

  it("does not set error.type on successful steps", () => {
    traceStep(buildStep({ conclusion: "success" }));

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes[ATTR_ERROR_TYPE]).toBeUndefined();
  });

  it("uses INTERNAL span kind for steps", () => {
    traceStep(buildStep());

    const span = exporter.getFinishedSpans()[0];
    expect(span?.kind).toBe(SpanKind.INTERNAL);
  });
});
