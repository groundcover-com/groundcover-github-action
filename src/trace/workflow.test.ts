import { jest, describe, it, expect, beforeAll, afterEach, afterAll } from "@jest/globals";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  ATTR_CICD_PIPELINE_ACTION_NAME,
  ATTR_CICD_PIPELINE_RESULT,
  ATTR_CICD_PIPELINE_RUN_STATE,
  ATTR_CICD_PIPELINE_RUN_URL_FULL,
  CICD_PIPELINE_ACTION_NAME_VALUE_RUN,
  CICD_PIPELINE_RESULT_VALUE_CANCELLATION,
  CICD_PIPELINE_RESULT_VALUE_ERROR,
  CICD_PIPELINE_RESULT_VALUE_FAILURE,
  CICD_PIPELINE_RESULT_VALUE_SKIP,
  CICD_PIPELINE_RESULT_VALUE_SUCCESS,
  CICD_PIPELINE_RESULT_VALUE_TIMEOUT,
  CICD_PIPELINE_RUN_STATE_VALUE_EXECUTING,
  CICD_PIPELINE_RUN_STATE_VALUE_FINALIZING,
  CICD_PIPELINE_RUN_STATE_VALUE_PENDING,
} from "@opentelemetry/semantic-conventions/incubating";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { components } from "@octokit/openapi-types";

const info = jest.fn<(message: string | number) => void>();
const warning = jest.fn<(message: string | Error) => void>();
jest.unstable_mockModule("@actions/core", () => ({ info, warning }));

const { traceWorkflowRun } = await import("./workflow.js");
const { extractParentContext } = await import("../tracer.js");

type WorkflowRun = components["schemas"]["workflow-run"];
type Job = components["schemas"]["job"];

function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1000,
    name: "CI",
    display_title: "CI #100",
    workflow_id: 50,
    run_number: 100,
    run_attempt: 1,
    event: "push",
    status: "completed",
    conclusion: "success",
    url: "https://api.github.com/repos/o/r/actions/runs/1000",
    html_url: "https://github.com/o/r/actions/runs/1000",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:02:00Z",
    run_started_at: "2024-01-01T00:00:00Z",
    head_branch: "main",
    head_sha: "abc123def456",
    path: ".github/workflows/ci.yml",
    pull_requests: [],
    referenced_workflows: [],
    head_commit: {
      id: "abc123",
      tree_id: "tree123",
      message: "fix things",
      timestamp: "2024-01-01T00:00:00Z",
      author: { name: "Test", email: "test@test.com" },
      committer: { name: "Test", email: "test@test.com" },
    },
    actor: { login: "octocat", id: 1 },
    triggering_actor: { login: "octocat", id: 1 },
    repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
    head_repository: { full_name: "o/r" },
    ...overrides,
  } as WorkflowRun;
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    run_id: 1000,
    run_url: "https://api.github.com/repos/o/r/actions/runs/1000",
    run_attempt: 1,
    node_id: "MDg6Q2hlY2tSdW4x",
    head_sha: "abc123def456",
    url: "https://api.github.com/repos/o/r/actions/jobs/1",
    html_url: "https://github.com/o/r/actions/runs/1000/jobs/1",
    status: "completed" as const,
    conclusion: "success",
    created_at: "2024-01-01T00:00:00Z",
    started_at: "2024-01-01T00:00:05Z",
    completed_at: "2024-01-01T00:01:00Z",
    name: "build",
    steps: [],
    check_run_url: "https://api.github.com/repos/o/r/check-runs/1",
    labels: ["ubuntu-latest"],
    runner_id: 1,
    runner_name: "runner-1",
    runner_group_id: 1,
    runner_group_name: "Default",
    workflow_name: "CI",
    head_branch: "main",
    ...overrides,
  } as Job;
}

describe("traceWorkflowRun", () => {
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
    warning.mockClear();
  });

  afterAll(() => {
    trace.disable();
  });

  it("creates root span with semconv span name format", () => {
    traceWorkflowRun(makeWorkflowRun({ name: "My CI" }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN My CI");
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.kind).toBe(SpanKind.SERVER);
  });

  it("falls back to action name only when pipeline name is null", () => {
    traceWorkflowRun(makeWorkflowRun({ name: null, display_title: "Fallback Title" }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN");
    expect(rootSpan).toBeDefined();
  });

  it("sets ERROR status for failed workflows", () => {
    traceWorkflowRun(makeWorkflowRun({ conclusion: "failure" }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan?.attributes["error"]).toBe(true);
    expect(rootSpan?.attributes[ATTR_ERROR_TYPE]).toBe("failure");
  });

  it("sets OK status for successful workflows", () => {
    traceWorkflowRun(makeWorkflowRun({ conclusion: "success" }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.status.code).toBe(SpanStatusCode.OK);
  });

  it("does not set error.type for successful workflows", () => {
    traceWorkflowRun(makeWorkflowRun({ conclusion: "success" }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.attributes[ATTR_ERROR_TYPE]).toBeUndefined();
  });

  it("sets error.type for error pipeline result (status failure)", () => {
    traceWorkflowRun(makeWorkflowRun({ status: "failure", conclusion: null }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan?.attributes[ATTR_ERROR_TYPE]).toBe("failure");
  });

  it("creates a Queued span before the first job", () => {
    const job = makeJob({ started_at: "2024-01-01T00:00:30Z" });

    traceWorkflowRun(makeWorkflowRun({ run_started_at: "2024-01-01T00:00:00Z" }), [job], {}, {});

    const queuedSpan = exporter.getFinishedSpans().find((s) => s.name === "Queued");
    expect(queuedSpan).toBeDefined();
  });

  it("processes all jobs as child spans", () => {
    const jobs = [makeJob({ id: 1, name: "build" }), makeJob({ id: 2, name: "test" })];

    traceWorkflowRun(makeWorkflowRun(), jobs, {}, {});

    const spans = exporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);
    expect(spanNames).toContain("build");
    expect(spanNames).toContain("test");
  });

  it("creates child job spans when job logs are provided", () => {
    traceWorkflowRun(makeWorkflowRun(), [makeJob()], {}, {}, undefined, undefined, { 1: "job logs" });

    const jobSpan = exporter.getFinishedSpans().find((s) => s.name === "build");
    expect(jobSpan).toBeDefined();
    expect(jobSpan?.attributes["github.job.id"]).toBe(1);
    expect(jobSpan?.attributes["github.job.logs"]).toBeUndefined();
  });

  it("returns a 32-char hex trace ID", () => {
    const traceId = traceWorkflowRun(makeWorkflowRun(), [makeJob()], {}, {});

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("creates root span with no parent when no parentContext", () => {
    traceWorkflowRun(makeWorkflowRun(), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.parentSpanId).toBeFalsy();
  });

  it("uses trace ID from traceparent when parentContext is provided", () => {
    const parentCtx = extractParentContext("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");

    const traceId = traceWorkflowRun(makeWorkflowRun(), [makeJob()], {}, {}, parentCtx);

    expect(traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  });

  it("sets parent span ID from traceparent when parentContext is provided", () => {
    const parentCtx = extractParentContext("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");

    traceWorkflowRun(makeWorkflowRun(), [makeJob()], {}, {}, parentCtx);

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.parentSpanId).toBe("b7ad6b7169203331");
  });

  it("sets workflow attributes correctly", () => {
    traceWorkflowRun(makeWorkflowRun(), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.attributes["cicd.pipeline.name"]).toBe("CI");
    expect(rootSpan?.attributes["cicd.pipeline.run.id"]).toBe(1000);
    expect(rootSpan?.attributes[ATTR_CICD_PIPELINE_ACTION_NAME]).toBe(CICD_PIPELINE_ACTION_NAME_VALUE_RUN);
    expect(rootSpan?.attributes[ATTR_CICD_PIPELINE_RUN_URL_FULL]).toBe("https://github.com/o/r/actions/runs/1000");
    expect(rootSpan?.attributes["github.run_id"]).toBe(1000);
    expect(rootSpan?.attributes["github.event"]).toBe("push");
    expect(rootSpan?.attributes["github.head_sha"]).toBe("abc123def456");
    expect(rootSpan?.attributes["github.head_branch"]).toBe("main");
  });

  it("maps pipeline results and states", () => {
    traceWorkflowRun(makeWorkflowRun({ id: 2000, status: "completed", conclusion: "success" }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2001, status: "completed", conclusion: "failure" }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2002, status: "completed", conclusion: "cancelled" }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2003, status: "completed", conclusion: "skipped" }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2004, status: "completed", conclusion: "timed_out" }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2005, status: "failure", conclusion: null }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2006, status: "queued", conclusion: null }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2007, status: "in_progress", conclusion: null }), [makeJob()], {}, {});
    traceWorkflowRun(
      makeWorkflowRun({ id: 2008, status: "completed", conclusion: "action_required" }),
      [makeJob()],
      {},
      {},
    );
    traceWorkflowRun(makeWorkflowRun({ id: 2009, status: "completed", conclusion: "neutral" }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2010, status: "completed", conclusion: "stale" }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2011, status: "requested", conclusion: null }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2012, status: "waiting", conclusion: null }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2013, status: "expected", conclusion: null }), [makeJob()], {}, {});
    traceWorkflowRun(makeWorkflowRun({ id: 2014, status: "startup_failure", conclusion: null }), [makeJob()], {}, {});

    const spans = exporter.getFinishedSpans().filter((span) => span.name === "RUN CI");
    expect(spans[0]?.attributes[ATTR_CICD_PIPELINE_RESULT]).toBe(CICD_PIPELINE_RESULT_VALUE_SUCCESS);
    expect(spans[0]?.attributes[ATTR_CICD_PIPELINE_RUN_STATE]).toBe(CICD_PIPELINE_RUN_STATE_VALUE_FINALIZING);
    expect(spans[1]?.attributes[ATTR_CICD_PIPELINE_RESULT]).toBe(CICD_PIPELINE_RESULT_VALUE_FAILURE);
    expect(spans[2]?.attributes[ATTR_CICD_PIPELINE_RESULT]).toBe(CICD_PIPELINE_RESULT_VALUE_CANCELLATION);
    expect(spans[3]?.attributes[ATTR_CICD_PIPELINE_RESULT]).toBe(CICD_PIPELINE_RESULT_VALUE_SKIP);
    expect(spans[4]?.attributes[ATTR_CICD_PIPELINE_RESULT]).toBe(CICD_PIPELINE_RESULT_VALUE_TIMEOUT);
    expect(spans[5]?.attributes[ATTR_CICD_PIPELINE_RESULT]).toBe(CICD_PIPELINE_RESULT_VALUE_ERROR);
    expect(spans[6]?.attributes[ATTR_CICD_PIPELINE_RUN_STATE]).toBe(CICD_PIPELINE_RUN_STATE_VALUE_PENDING);
    expect(spans[7]?.attributes[ATTR_CICD_PIPELINE_RUN_STATE]).toBe(CICD_PIPELINE_RUN_STATE_VALUE_EXECUTING);
    expect(spans[8]?.attributes[ATTR_CICD_PIPELINE_RESULT]).toBe(CICD_PIPELINE_RESULT_VALUE_FAILURE);
    expect(spans[9]?.attributes[ATTR_CICD_PIPELINE_RESULT]).toBe(CICD_PIPELINE_RESULT_VALUE_SUCCESS);
    expect(spans[10]?.attributes[ATTR_CICD_PIPELINE_RESULT]).toBe(CICD_PIPELINE_RESULT_VALUE_FAILURE);
    expect(spans[11]?.attributes[ATTR_CICD_PIPELINE_RUN_STATE]).toBe(CICD_PIPELINE_RUN_STATE_VALUE_PENDING);
    expect(spans[12]?.attributes[ATTR_CICD_PIPELINE_RUN_STATE]).toBe(CICD_PIPELINE_RUN_STATE_VALUE_PENDING);
    expect(spans[13]?.attributes[ATTR_CICD_PIPELINE_RUN_STATE]).toBe(CICD_PIPELINE_RUN_STATE_VALUE_EXECUTING);
    expect(spans[14]?.attributes[ATTR_CICD_PIPELINE_RUN_STATE]).toBe(CICD_PIPELINE_RUN_STATE_VALUE_FINALIZING);
  });

  it("maps extra workflow metadata from GitHub", () => {
    traceWorkflowRun(
      makeWorkflowRun({
        workflow_url: "https://api.github.com/repos/o/r/actions/workflows/ci.yml",
        node_id: "WFR_123",
        check_suite_id: 456,
        check_suite_node_id: "CS_456",
        jobs_url: "https://api.github.com/repos/o/r/actions/runs/1000/jobs",
        logs_url: "https://api.github.com/repos/o/r/actions/runs/1000/logs",
        check_suite_url: "https://api.github.com/repos/o/r/check-suites/456",
        artifacts_url: "https://api.github.com/repos/o/r/actions/runs/1000/artifacts",
        cancel_url: "https://api.github.com/repos/o/r/actions/runs/1000/cancel",
        rerun_url: "https://api.github.com/repos/o/r/actions/runs/1000/rerun",
        previous_attempt_url: "https://api.github.com/repos/o/r/actions/runs/999",
      }),
      [makeJob()],
      {},
      {},
    );

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.attributes["github.workflow_url"]).toBe(
      "https://api.github.com/repos/o/r/actions/workflows/ci.yml",
    );
    expect(rootSpan?.attributes["github.workflow"]).toBe("CI");
    expect(rootSpan?.attributes["github.node_id"]).toBe("WFR_123");
    expect(rootSpan?.attributes["github.check_suite_id"]).toBe(456);
    expect(rootSpan?.attributes["github.check_suite_node_id"]).toBe("CS_456");
    expect(rootSpan?.attributes["github.jobs_url"]).toBe("https://api.github.com/repos/o/r/actions/runs/1000/jobs");
    expect(rootSpan?.attributes["github.logs_url"]).toBe("https://api.github.com/repos/o/r/actions/runs/1000/logs");
    expect(rootSpan?.attributes["github.check_suite_url"]).toBe("https://api.github.com/repos/o/r/check-suites/456");
    expect(rootSpan?.attributes["github.artifacts_url"]).toBe(
      "https://api.github.com/repos/o/r/actions/runs/1000/artifacts",
    );
    expect(rootSpan?.attributes["github.cancel_url"]).toBe("https://api.github.com/repos/o/r/actions/runs/1000/cancel");
    expect(rootSpan?.attributes["github.rerun_url"]).toBe("https://api.github.com/repos/o/r/actions/runs/1000/rerun");
    expect(rootSpan?.attributes["github.previous_attempt_url"]).toBe(
      "https://api.github.com/repos/o/r/actions/runs/999",
    );
  });

  it("includes referenced workflow attributes", () => {
    const referencedWorkflows = [
      { path: ".github/workflows/reusable.yml", sha: "abc123", ref: "refs/heads/main" },
      { path: ".github/workflows/other.yml", sha: "def456", ref: "refs/tags/v1" },
    ];

    traceWorkflowRun(makeWorkflowRun({ referenced_workflows: referencedWorkflows }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.attributes["github.referenced_workflows.0.path"]).toBe(".github/workflows/reusable.yml");
    expect(rootSpan?.attributes["github.referenced_workflows.0.sha"]).toBe("abc123");
    expect(rootSpan?.attributes["github.referenced_workflows.0.ref"]).toBe("refs/heads/main");
    expect(rootSpan?.attributes["github.referenced_workflows.1.path"]).toBe(".github/workflows/other.yml");
  });

  it("handles null and empty referenced workflows", () => {
    traceWorkflowRun(makeWorkflowRun({ referenced_workflows: null }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan).toBeDefined();
  });

  it("handles workflow with no jobs (empty Queued span)", () => {
    traceWorkflowRun(makeWorkflowRun(), [], {}, {});

    const spans = exporter.getFinishedSpans();
    const queuedSpan = spans.find((s) => s.name === "Queued");
    expect(queuedSpan).toBeUndefined();
  });

  it("handles null optional workflow fields", () => {
    traceWorkflowRun(
      makeWorkflowRun({
        name: null,
        status: null,
        conclusion: null,
        run_started_at: undefined,
        head_branch: null,
        pull_requests: null,
        referenced_workflows: undefined,
      } as unknown as Partial<components["schemas"]["workflow-run"]>),
      [makeJob()],
      {},
      {},
    );

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN");
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.attributes["cicd.pipeline.name"]).toBeUndefined();
    expect(rootSpan?.attributes["github.status"]).toBeUndefined();
    expect(rootSpan?.attributes["github.conclusion"]).toBeUndefined();
  });

  it("defaults github.run_attempt to 1 when absent", () => {
    traceWorkflowRun(
      makeWorkflowRun({ run_attempt: undefined } as unknown as Partial<WorkflowRun>),
      [makeJob()],
      {},
      {},
    );

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.attributes["github.run_attempt"]).toBe(1);
  });

  it("includes PR attributes and labels when pull requests are present", () => {
    const pullRequests = [
      {
        id: 42,
        number: 7,
        url: "https://api.github.com/repos/o/r/pulls/7",
        head: { ref: "feature", sha: "head-sha", repo: { id: 1, url: "https://api.github.com/repos/o/r", name: "r" } },
        base: { ref: "main", sha: "base-sha", repo: { id: 1, url: "https://api.github.com/repos/o/r", name: "r" } },
      },
    ] as unknown as components["schemas"]["pull-request-minimal"][];

    const prLabels: Record<number, string[]> = { 7: ["bug", "priority"] };

    traceWorkflowRun(makeWorkflowRun({ pull_requests: pullRequests }), [makeJob()], {}, prLabels);

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.attributes["github.head_ref"]).toBe("feature");
    expect(rootSpan?.attributes["github.base_ref"]).toBe("main");
    expect(rootSpan?.attributes["github.pull_requests.0.number"]).toBe(7);
    expect(rootSpan?.attributes["github.pull_requests.0.html_url"]).toBe("https://github.com/o/r/pull/7");
    expect(rootSpan?.attributes["github.pull_requests.0.labels"]).toEqual(["bug", "priority"]);
  });

  it("includes actor and repository attributes", () => {
    traceWorkflowRun(
      makeWorkflowRun({
        actor: { login: "alice", id: 42 },
        triggering_actor: { login: "bob", id: 43 },
      } as unknown as Partial<WorkflowRun>),
      [makeJob()],
      {},
      {},
    );

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.attributes["github.actor"]).toBe("alice");
    expect(rootSpan?.attributes["github.triggering_actor"]).toBe("bob");
    expect(rootSpan?.attributes["github.repository"]).toBe("o/r");
  });

  it("includes parsed test result summary attributes", () => {
    traceWorkflowRun(makeWorkflowRun(), [makeJob()], {}, {}, undefined, {
      suites: 2,
      total: 10,
      passed: 8,
      failed: 1,
      skipped: 1,
      errors: 0,
      duration: 12.5,
    });

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "RUN CI");
    expect(rootSpan?.attributes["test.suites"]).toBe(2);
    expect(rootSpan?.attributes["test.total"]).toBe(10);
    expect(rootSpan?.attributes["test.passed"]).toBe(8);
    expect(rootSpan?.attributes["test.failed"]).toBe(1);
    expect(rootSpan?.attributes["test.skipped"]).toBe(1);
    expect(rootSpan?.attributes["test.errors"]).toBe(0);
    expect(rootSpan?.attributes["test.duration"]).toBe(12.5);
  });
});
