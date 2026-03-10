import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  ATTR_CICD_PIPELINE_TASK_RUN_RESULT,
  ATTR_CICD_PIPELINE_TASK_TYPE,
  ATTR_CICD_WORKER_ID,
  ATTR_CICD_WORKER_NAME,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_CANCELLATION,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_FAILURE,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SKIP,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SUCCESS,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_TIMEOUT,
  CICD_PIPELINE_TASK_TYPE_VALUE_BUILD,
  CICD_PIPELINE_TASK_TYPE_VALUE_DEPLOY,
  CICD_PIPELINE_TASK_TYPE_VALUE_TEST,
} from "@opentelemetry/semantic-conventions/incubating";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { components } from "@octokit/openapi-types";

type Job = components["schemas"]["job"];

const info = jest.fn<(message: string | number) => void>();
const emit = jest.fn<(record: Record<string, unknown>) => void>();
const getLogger = jest.fn(() => ({ emit }));
const SeverityNumber = {
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

jest.unstable_mockModule("@actions/core", () => ({ info }));
jest.unstable_mockModule("@opentelemetry/api-logs", () => ({
  logs: { getLogger },
  SeverityNumber,
}));

const { traceJob, parseGitHubLogLines, emitJobLogs, correlateLogsByStep, mergeLogLines } = await import("./job.js");

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
    emit.mockClear();
    getLogger.mockClear();
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

  it("parses GitHub log lines with timestamps and default info severity", () => {
    const parsed = parseGitHubLogLines("2024-01-01T00:00:00.0000000Z Hello world");

    expect(parsed).toEqual([
      {
        timestamp: new Date("2024-01-01T00:00:00.0000000Z").getTime(),
        body: "Hello world",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
      },
    ]);
  });

  it("detects error and warning prefixes and strips them from log bodies", () => {
    const parsed = parseGitHubLogLines(
      ["2024-01-01T00:00:00.0000000Z ##[error]Build failed", "2024-01-01T00:00:01.0000000Z ##[warning]Slow test"].join(
        "\n",
      ),
    );

    expect(parsed).toEqual([
      {
        timestamp: new Date("2024-01-01T00:00:00.0000000Z").getTime(),
        body: "Build failed",
        severityNumber: SeverityNumber.ERROR,
        severityText: "ERROR",
      },
      {
        timestamp: new Date("2024-01-01T00:00:01.0000000Z").getTime(),
        body: "Slow test",
        severityNumber: SeverityNumber.WARN,
        severityText: "WARN",
      },
    ]);
  });

  it("uses Date.now for lines without timestamps, skips empty lines, and handles multiline input", () => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_706_000_000_000);

    const parsed = parseGitHubLogLines(
      ["", "plain line", "", "2024-01-01T00:00:00.0000000Z another line", ""].join("\n"),
    );

    expect(parsed).toEqual([
      {
        timestamp: 1_706_000_000_000,
        body: "plain line",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
      },
      {
        timestamp: new Date("2024-01-01T00:00:00.0000000Z").getTime(),
        body: "another line",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
      },
    ]);

    nowSpy.mockRestore();
  });

  it("strips UTF-8 BOM from the start of the log so the first line timestamp is parsed", () => {
    const parsed = parseGitHubLogLines(
      "\uFEFF2024-01-01T00:00:00.0000000Z first line\n2024-01-01T00:00:01.0000000Z second line",
    );

    expect(parsed).toEqual([
      {
        timestamp: new Date("2024-01-01T00:00:00.0000000Z").getTime(),
        body: "first line",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
      },
      {
        timestamp: new Date("2024-01-01T00:00:01.0000000Z").getTime(),
        body: "second line",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
      },
    ]);
  });

  it("handles Windows-style \\r\\n line endings", () => {
    const parsed = parseGitHubLogLines(
      "2024-01-01T00:00:00.0000000Z   git switch -\r\n2024-01-01T00:00:01.0000000Z done\r\n",
    );

    expect(parsed).toEqual([
      {
        timestamp: new Date("2024-01-01T00:00:00.0000000Z").getTime(),
        body: "  git switch -",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
      },
      {
        timestamp: new Date("2024-01-01T00:00:01.0000000Z").getTime(),
        body: "done",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
      },
    ]);
  });

  it("emits a single merged OTEL log record with highest severity and joined body", () => {
    const tracer = trace.getTracer("otel-cicd-export-action");
    let activeSpanContext = context.active();

    const logLines = parseGitHubLogLines(
      [
        "2024-01-01T00:00:00.0000000Z hello",
        "2024-01-01T00:00:01.0000000Z ##[warning]careful",
        "2024-01-01T00:00:02.0000000Z ##[error]boom",
      ].join("\n"),
    );

    tracer.startActiveSpan("job-log-test", (span) => {
      activeSpanContext = context.active();
      emitJobLogs(logLines, 10, "Build");
      span.end();
    });

    expect(getLogger).toHaveBeenCalledWith("otel-cicd-export-action");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      timestamp: new Date("2024-01-01T00:00:00.0000000Z"),
      body: "hello\ncareful\nboom",
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      context: activeSpanContext,
      attributes: { "github.job.id": 10, "github.job.name": "Build" },
    });
  });

  describe("mergeLogLines", () => {
    it("joins bodies with newlines and uses the highest severity", () => {
      const logLines = parseGitHubLogLines(
        [
          "2024-01-01T00:00:00.0000000Z line one",
          "2024-01-01T00:00:01.0000000Z ##[warning]line two",
          "2024-01-01T00:00:02.0000000Z ##[error]line three",
          "2024-01-01T00:00:03.0000000Z line four",
        ].join("\n"),
      );

      const merged = mergeLogLines(logLines);

      expect(merged.body).toBe("line one\nline two\nline three\nline four");
      expect(merged.timestamp).toBe(new Date("2024-01-01T00:00:00.0000000Z").getTime());
      expect(merged.severityNumber).toBe(SeverityNumber.ERROR);
      expect(merged.severityText).toBe("ERROR");
    });

    it("uses INFO when all lines are INFO", () => {
      const logLines = parseGitHubLogLines("2024-01-01T00:00:00.0000000Z a\n2024-01-01T00:00:01.0000000Z b");

      const merged = mergeLogLines(logLines);

      expect(merged.severityNumber).toBe(SeverityNumber.INFO);
      expect(merged.severityText).toBe("INFO");
    });

    it("throws on empty input", () => {
      expect(() => mergeLogLines([])).toThrow("mergeLogLines requires at least one log line");
    });
  });

  it("maps task run results and worker attributes", () => {
    traceJob(buildJob({ id: 20, conclusion: "success" }));
    traceJob(buildJob({ id: 21, conclusion: "failure" }));
    traceJob(buildJob({ id: 22, conclusion: "cancelled" }));
    traceJob(buildJob({ id: 23, conclusion: "skipped" }));
    traceJob(buildJob({ id: 24, conclusion: "timed_out" }));

    const spans = exporter.getFinishedSpans();
    expect(spans[0]?.attributes[ATTR_CICD_PIPELINE_TASK_RUN_RESULT]).toBe(CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SUCCESS);
    expect(spans[0]?.attributes[ATTR_CICD_WORKER_ID]).toBe(1);
    expect(spans[0]?.attributes[ATTR_CICD_WORKER_NAME]).toBe("runner-1");
    expect(spans[1]?.attributes[ATTR_CICD_PIPELINE_TASK_RUN_RESULT]).toBe(CICD_PIPELINE_TASK_RUN_RESULT_VALUE_FAILURE);
    expect(spans[2]?.attributes[ATTR_CICD_PIPELINE_TASK_RUN_RESULT]).toBe(
      CICD_PIPELINE_TASK_RUN_RESULT_VALUE_CANCELLATION,
    );
    expect(spans[3]?.attributes[ATTR_CICD_PIPELINE_TASK_RUN_RESULT]).toBe(CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SKIP);
    expect(spans[4]?.attributes[ATTR_CICD_PIPELINE_TASK_RUN_RESULT]).toBe(CICD_PIPELINE_TASK_RUN_RESULT_VALUE_TIMEOUT);
  });

  it("maps neutral and action_required task results", () => {
    traceJob(buildJob({ id: 30, conclusion: "neutral" }));
    traceJob(buildJob({ id: 31, conclusion: "action_required" }));

    const spans = exporter.getFinishedSpans();
    expect(spans[0]?.attributes[ATTR_CICD_PIPELINE_TASK_RUN_RESULT]).toBe(CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SUCCESS);
    expect(spans[1]?.attributes[ATTR_CICD_PIPELINE_TASK_RUN_RESULT]).toBe(CICD_PIPELINE_TASK_RUN_RESULT_VALUE_FAILURE);
  });

  it("sets error status on failed jobs", () => {
    traceJob(buildJob({ conclusion: "failure" }));

    const span = exporter.getFinishedSpans()[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("sets error.type on failed jobs", () => {
    traceJob(buildJob({ conclusion: "failure" }));

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes[ATTR_ERROR_TYPE]).toBe("failure");
  });

  it("does not set error.type on successful jobs", () => {
    traceJob(buildJob({ conclusion: "success" }));

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes[ATTR_ERROR_TYPE]).toBeUndefined();
  });

  it("uses INTERNAL span kind for jobs", () => {
    traceJob(buildJob());

    const span = exporter.getFinishedSpans()[0];
    expect(span?.kind).toBe(SpanKind.INTERNAL);
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

  describe("correlateLogsByStep", () => {
    it("assigns log lines to the correct step based on timestamp", () => {
      const logLines = parseGitHubLogLines(
        [
          "2026-01-29T17:16:21.0000000Z setting up",
          "2026-01-29T17:16:30.0000000Z running checkout",
          "2026-01-29T17:16:40.0000000Z running npm ci",
        ].join("\n"),
      );

      const steps = [
        {
          name: "Set up job",
          number: 1,
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-29T17:16:20Z",
          completed_at: "2026-01-29T17:16:25Z",
        },
        {
          name: "Run checkout",
          number: 2,
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-29T17:16:25Z",
          completed_at: "2026-01-29T17:16:35Z",
        },
        {
          name: "Run npm ci",
          number: 3,
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-29T17:16:35Z",
          completed_at: "2026-01-29T17:16:45Z",
        },
      ] as NonNullable<Job["steps"]>;

      const result = correlateLogsByStep(logLines, steps);

      expect(result.byStep.get(1)).toHaveLength(1);
      expect(result.byStep.get(1)?.[0]?.body).toBe("setting up");
      expect(result.byStep.get(2)).toHaveLength(1);
      expect(result.byStep.get(2)?.[0]?.body).toBe("running checkout");
      expect(result.byStep.get(3)).toHaveLength(1);
      expect(result.byStep.get(3)?.[0]?.body).toBe("running npm ci");
      expect(result.unmatched).toHaveLength(0);
    });

    it("puts lines outside any step window into unmatched", () => {
      const logLines = parseGitHubLogLines(
        [
          "2026-01-29T17:16:10.0000000Z before any step",
          "2026-01-29T17:16:21.0000000Z inside step",
          "2026-01-29T17:17:00.0000000Z after all steps",
        ].join("\n"),
      );

      const steps = [
        {
          name: "Step 1",
          number: 1,
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-29T17:16:20Z",
          completed_at: "2026-01-29T17:16:30Z",
        },
      ] as NonNullable<Job["steps"]>;

      const result = correlateLogsByStep(logLines, steps);

      expect(result.byStep.get(1)).toHaveLength(1);
      expect(result.unmatched).toHaveLength(2);
      expect(result.unmatched[0]?.body).toBe("before any step");
      expect(result.unmatched[1]?.body).toBe("after all steps");
    });

    it("includes the 1-second buffer after completed_at", () => {
      const logLines = parseGitHubLogLines(
        "2026-01-29T17:16:30.5000000Z within buffer\n2026-01-29T17:16:31.5000000Z outside buffer",
      );

      const steps = [
        {
          name: "Step 1",
          number: 1,
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-29T17:16:20Z",
          completed_at: "2026-01-29T17:16:30Z",
        },
      ] as NonNullable<Job["steps"]>;

      const result = correlateLogsByStep(logLines, steps);

      expect(result.byStep.get(1)).toHaveLength(1);
      expect(result.byStep.get(1)?.[0]?.body).toBe("within buffer");
      expect(result.unmatched).toHaveLength(1);
    });

    it("skips skipped steps", () => {
      const logLines = parseGitHubLogLines("2026-01-29T17:16:25.0000000Z a log line");

      const steps = [
        {
          name: "Skipped",
          number: 1,
          status: "completed",
          conclusion: "skipped",
          started_at: "2026-01-29T17:16:20Z",
          completed_at: "2026-01-29T17:16:30Z",
        },
      ] as NonNullable<Job["steps"]>;

      const result = correlateLogsByStep(logLines, steps);

      expect(result.byStep.size).toBe(0);
      expect(result.unmatched).toHaveLength(1);
    });

    it("handles empty log lines and empty steps", () => {
      expect(correlateLogsByStep([], []).unmatched).toHaveLength(0);
      expect(correlateLogsByStep([], []).byStep.size).toBe(0);
    });
  });

  it("emits one merged log per step and one for unmatched lines", () => {
    const steps = [
      {
        name: "Set up job",
        number: 1,
        status: "completed",
        conclusion: "success",
        started_at: "2026-01-29T17:16:20Z",
        completed_at: "2026-01-29T17:16:30Z",
      },
      {
        name: "Run npm ci",
        number: 2,
        status: "completed",
        conclusion: "success",
        started_at: "2026-01-29T17:16:30Z",
        completed_at: "2026-01-29T17:16:40Z",
      },
    ] as NonNullable<Job["steps"]>;

    const jobLog = [
      "2026-01-29T17:16:25.0000000Z setup line 1",
      "2026-01-29T17:16:26.0000000Z setup line 2",
      "2026-01-29T17:16:35.0000000Z npm line",
      "2026-01-29T17:16:50.0000000Z orphan line",
    ].join("\n");

    traceJob(buildJob({ steps }), undefined, jobLog);

    // 1 merged log per step + 1 unmatched job-level log
    expect(emit).toHaveBeenCalledTimes(3);

    // Step logs are merged into a single multiline body
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "setup line 1\nsetup line 2",
        attributes: {
          "github.job.id": 10,
          "github.job.name": "Build",
          "github.job.step.name": "Set up job",
          "github.job.step.number": 1,
        },
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "npm line",
        attributes: {
          "github.job.id": 10,
          "github.job.name": "Build",
          "github.job.step.name": "Run npm ci",
          "github.job.step.number": 2,
        },
      }),
    );

    // Unmatched log falls back to job-level attributes
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "orphan line",
        attributes: { "github.job.id": 10, "github.job.name": "Build" },
      }),
    );
  });
});
