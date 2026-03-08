import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  ATTR_CICD_PIPELINE_TASK_TYPE,
  CICD_PIPELINE_TASK_TYPE_VALUE_BUILD,
  CICD_PIPELINE_TASK_TYPE_VALUE_DEPLOY,
  CICD_PIPELINE_TASK_TYPE_VALUE_TEST,
} from "@opentelemetry/semantic-conventions/incubating";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { components } from "@octokit/openapi-types";

type Job = components["schemas"]["job"];

const info = jest.fn<(message: string | number) => void>();
jest.unstable_mockModule("@actions/core", () => ({ info }));

const { traceJob } = await import("./job.js");

function hrTimeToMs(value: [number, number]): number {
  return value[0] * 1000 + value[1] / 1_000_000;
}

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 10,
    run_id: 20,
    workflow_name: "CI",
    head_branch: "main",
    run_url: "https://api.github.com/repos/acme/repo/actions/runs/20",
    run_attempt: 1,
    node_id: "CR_kwDOtest",
    head_sha: "0123456789abcdef0123456789abcdef01234567",
    url: "https://api.github.com/repos/acme/repo/actions/jobs/10",
    html_url: "https://github.com/acme/repo/actions/runs/20/job/10",
    status: "completed",
    conclusion: "success",
    created_at: "2026-01-29T17:16:10Z",
    started_at: "2026-01-29T17:16:20Z",
    completed_at: "2026-01-29T17:16:50Z",
    name: "Build",
    steps: [],
    check_run_url: "https://api.github.com/repos/acme/repo/check-runs/10",
    labels: ["ubuntu-latest"],
    runner_id: 1,
    runner_name: "runner-1",
    runner_group_id: 2,
    runner_group_name: "default",
    ...overrides,
  } as Job;
}

describe("traceJob", () => {
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

  it("creates a span with the job name", () => {
    traceJob(buildJob({ name: "Build Linux" }));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("Build Linux");
  });

  it("sets correct start and end times", () => {
    traceJob(
      buildJob({
        started_at: "2026-01-29T17:16:20Z",
        completed_at: "2026-01-29T17:16:50Z",
      }),
    );

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;

    expect(hrTimeToMs(span.startTime)).toBe(new Date("2026-01-29T17:16:20Z").getTime());
    expect(hrTimeToMs(span.endTime)).toBe(new Date("2026-01-29T17:16:50Z").getTime());
  });

  it("handles completed_at earlier than started_at", () => {
    traceJob(
      buildJob({
        started_at: "2026-01-29T17:16:50Z",
        completed_at: "2026-01-29T17:16:45Z",
      }),
    );

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;

    expect(hrTimeToMs(span.startTime)).toBe(hrTimeToMs(span.endTime));
  });

  it("skips incomplete jobs with no completed_at", () => {
    traceJob(buildJob({ completed_at: null }));

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(info).toHaveBeenCalledWith("Job 10 is not completed yet");
  });

  it("maps job name keywords into task type attributes", () => {
    traceJob(buildJob({ name: "Build package" }));
    traceJob(buildJob({ id: 11, name: "Test package" }));
    traceJob(buildJob({ id: 12, name: "Deploy package" }));

    const spans = exporter.getFinishedSpans();
    expect(spans[0]?.attributes[ATTR_CICD_PIPELINE_TASK_TYPE]).toBe(CICD_PIPELINE_TASK_TYPE_VALUE_BUILD);
    expect(spans[1]?.attributes[ATTR_CICD_PIPELINE_TASK_TYPE]).toBe(CICD_PIPELINE_TASK_TYPE_VALUE_TEST);
    expect(spans[2]?.attributes[ATTR_CICD_PIPELINE_TASK_TYPE]).toBe(CICD_PIPELINE_TASK_TYPE_VALUE_DEPLOY);
  });

  it("includes annotations as span attributes", () => {
    const annotations = [
      {
        annotation_level: "warning",
        message: "Potential issue",
      },
    ] as components["schemas"]["check-annotation"][];

    traceJob(buildJob(), annotations);

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes["github.job.annotations.0.level"]).toBe("warning");
    expect(span?.attributes["github.job.annotations.0.message"]).toBe("Potential issue");
  });

  it("sets error status on failed jobs", () => {
    traceJob(buildJob({ conclusion: "failure" }));

    const span = exporter.getFinishedSpans()[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("handles jobs with no steps", () => {
    const job = buildJob();
    delete (job as Record<string, unknown>)["steps"];
    traceJob(job);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
  });

  it("handles null optional fields in job attributes", () => {
    traceJob(
      buildJob({
        html_url: null,
        runner_id: null,
        runner_group_id: null,
        runner_group_name: null,
        runner_name: null,
        conclusion: null,
        completed_at: "2026-01-29T17:16:50Z",
        workflow_name: null,
        head_branch: null,
        run_attempt: undefined,
      } as unknown as Partial<Job>),
    );

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    expect(span?.attributes["github.job.html_url"]).toBeUndefined();
    expect(span?.attributes["github.job.runner_id"]).toBeUndefined();
    expect(span?.attributes["github.job.runner_name"]).toBeUndefined();
    expect(span?.attributes["github.job.conclusion"]).toBeUndefined();
    expect(span?.attributes["github.job.workflow_name"]).toBeUndefined();
    expect(span?.attributes["github.job.head_branch"]).toBeUndefined();
  });

  it("handles annotations with null fields", () => {
    const annotations = [
      {
        annotation_level: null,
        message: null,
      },
    ] as unknown as components["schemas"]["check-annotation"][];

    traceJob(buildJob(), annotations);

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes["github.job.annotations.0.level"]).toBeUndefined();
    expect(span?.attributes["github.job.annotations.0.message"]).toBeUndefined();
  });

  it("does not set task type for unknown job names", () => {
    traceJob(buildJob({ name: "lint" }));

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes[ATTR_CICD_PIPELINE_TASK_TYPE]).toBeUndefined();
  });
});
