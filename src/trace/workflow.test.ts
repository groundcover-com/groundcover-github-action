import { jest, describe, it, expect, beforeAll, afterEach, afterAll } from "@jest/globals";
import { SpanStatusCode, trace } from "@opentelemetry/api";
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
    repository: { full_name: "o/r" },
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

  it("creates root span with workflow name", () => {
    traceWorkflowRun(makeWorkflowRun({ name: "My CI" }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "My CI");
    expect(rootSpan).toBeDefined();
  });

  it("falls back to display_title when name is null", () => {
    traceWorkflowRun(makeWorkflowRun({ name: null, display_title: "Fallback Title" }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "Fallback Title");
    expect(rootSpan).toBeDefined();
  });

  it("sets ERROR status for failed workflows", () => {
    traceWorkflowRun(makeWorkflowRun({ conclusion: "failure" }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "CI");
    expect(rootSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan?.attributes["error"]).toBe(true);
  });

  it("sets OK status for successful workflows", () => {
    traceWorkflowRun(makeWorkflowRun({ conclusion: "success" }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "CI");
    expect(rootSpan?.status.code).toBe(SpanStatusCode.OK);
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

  it("returns a 32-char hex trace ID", () => {
    const traceId = traceWorkflowRun(makeWorkflowRun(), [makeJob()], {}, {});

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("creates root span with no parent when no parentContext", () => {
    traceWorkflowRun(makeWorkflowRun(), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "CI");
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

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "CI");
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.parentSpanId).toBe("b7ad6b7169203331");
  });

  it("sets workflow attributes correctly", () => {
    traceWorkflowRun(makeWorkflowRun(), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "CI");
    expect(rootSpan?.attributes["cicd.pipeline.name"]).toBe("CI");
    expect(rootSpan?.attributes["cicd.pipeline.run.id"]).toBe(1000);
    expect(rootSpan?.attributes["github.run_id"]).toBe(1000);
    expect(rootSpan?.attributes["github.event"]).toBe("push");
    expect(rootSpan?.attributes["github.head_sha"]).toBe("abc123def456");
    expect(rootSpan?.attributes["github.head_branch"]).toBe("main");
  });

  it("includes referenced workflow attributes", () => {
    const referencedWorkflows = [
      { path: ".github/workflows/reusable.yml", sha: "abc123", ref: "refs/heads/main" },
      { path: ".github/workflows/other.yml", sha: "def456", ref: "refs/tags/v1" },
    ];

    traceWorkflowRun(makeWorkflowRun({ referenced_workflows: referencedWorkflows }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "CI");
    expect(rootSpan?.attributes["github.referenced_workflows.0.path"]).toBe(".github/workflows/reusable.yml");
    expect(rootSpan?.attributes["github.referenced_workflows.0.sha"]).toBe("abc123");
    expect(rootSpan?.attributes["github.referenced_workflows.0.ref"]).toBe("refs/heads/main");
    expect(rootSpan?.attributes["github.referenced_workflows.1.path"]).toBe(".github/workflows/other.yml");
  });

  it("handles null and empty referenced workflows", () => {
    traceWorkflowRun(makeWorkflowRun({ referenced_workflows: null }), [makeJob()], {}, {});

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "CI");
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

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "CI #100");
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.attributes["cicd.pipeline.name"]).toBeUndefined();
    expect(rootSpan?.attributes["github.status"]).toBeUndefined();
    expect(rootSpan?.attributes["github.conclusion"]).toBeUndefined();
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

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "CI");
    expect(rootSpan?.attributes["github.head_ref"]).toBe("feature");
    expect(rootSpan?.attributes["github.base_ref"]).toBe("main");
    expect(rootSpan?.attributes["github.pull_requests.0.number"]).toBe(7);
    expect(rootSpan?.attributes["github.pull_requests.0.labels"]).toEqual(["bug", "priority"]);
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

    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === "CI");
    expect(rootSpan?.attributes["test.suites"]).toBe(2);
    expect(rootSpan?.attributes["test.total"]).toBe(10);
    expect(rootSpan?.attributes["test.passed"]).toBe(8);
    expect(rootSpan?.attributes["test.failed"]).toBe(1);
    expect(rootSpan?.attributes["test.skipped"]).toBe(1);
    expect(rootSpan?.attributes["test.errors"]).toBe(0);
    expect(rootSpan?.attributes["test.duration"]).toBe(12.5);
  });
});
