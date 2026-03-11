import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { RequestError } from "@octokit/request-error";

const core = {
  getInput: jest.fn<(name: string) => string>(),
  setOutput: jest.fn<(name: string, value: string) => void>(),
  setFailed: jest.fn<(message: string) => void>(),
  setSecret: jest.fn<(value: string) => void>(),
  info: jest.fn<(message: string | number) => void>(),
};

const github = {
  context: { runId: 123, repo: { owner: "o", repo: "r" } },
  getOctokit: jest.fn(() => ({ mocked: true })),
};

const getWorkflowRun = jest.fn<() => Promise<unknown>>();
const listJobsForWorkflowRun = jest.fn<() => Promise<unknown>>();
const getJobsAnnotations = jest.fn<() => Promise<unknown>>();
const getJobsLogs = jest.fn<() => Promise<unknown>>();
const getPRsLabels = jest.fn<() => Promise<unknown>>();
const upsertPrTraceComment = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const createTracerProvider = jest.fn(() => ({
  forceFlush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));
const loggerForceFlush = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const loggerShutdown = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const createLoggerProvider = jest.fn(() => ({
  forceFlush: loggerForceFlush,
  shutdown: loggerShutdown,
}));
const extractParentContext = jest.fn<() => undefined>(() => undefined);
const stringToRecord = jest.fn<() => Record<string, string>>(() => ({}));
const traceWorkflowRun = jest.fn<() => string>(() => "trace-id");
const findTestResultsSummary = jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined);

jest.unstable_mockModule("@actions/core", () => core);
jest.unstable_mockModule("@actions/github", () => github);
jest.unstable_mockModule("./github.js", () => ({
  getWorkflowRun,
  listJobsForWorkflowRun,
  getJobsAnnotations,
  getJobsLogs,
  getPRsLabels,
  upsertPrTraceComment,
}));
jest.unstable_mockModule("./tracer.js", () => ({
  createTracerProvider,
  createLoggerProvider,
  extractParentContext,
  stringToRecord,
}));
jest.unstable_mockModule("./trace/workflow.js", () => ({ traceWorkflowRun }));
jest.unstable_mockModule("./test-results.js", () => ({ findTestResultsSummary }));

const { run, resolveOtlpHeaders, buildTracesUrl, buildPrTracesUrl } = await import("./runner.js");

describe("run branch coverage", () => {
  beforeEach(() => {
    core.getInput.mockReset();
    core.setOutput.mockReset();
    core.setFailed.mockReset();
    core.setSecret.mockReset();
    core.info.mockReset();
    github.getOctokit.mockClear();
    getWorkflowRun.mockReset();
    listJobsForWorkflowRun.mockReset();
    getJobsAnnotations.mockReset();
    getJobsLogs.mockReset();
    getPRsLabels.mockReset();
    upsertPrTraceComment.mockClear();
    createTracerProvider.mockClear();
    createLoggerProvider.mockClear();
    loggerForceFlush.mockClear();
    loggerShutdown.mockClear();
    extractParentContext.mockClear();
    stringToRecord.mockClear();
    traceWorkflowRun.mockClear();
    findTestResultsSummary.mockReset();
    findTestResultsSummary.mockResolvedValue(undefined);
    getJobsLogs.mockResolvedValue({});
    delete process.env["OTEL_SERVICE_NAME"];
    delete process.env["GITHUB_TOKEN"];
  });

  it("exports job logs when exportLogs is enabled", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "apiKey") return "gc-secret";
      if (name === "exportLogs") return "true";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([{ id: 10 }]);
    getJobsAnnotations.mockResolvedValue({});
    getJobsLogs.mockResolvedValue({ 10: "job logs" });
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(getJobsLogs).toHaveBeenCalledWith(github.context, { mocked: true }, [10]);
    expect(traceWorkflowRun).toHaveBeenCalledWith(expect.any(Object), [{ id: 10 }], {}, {}, undefined, undefined, {
      10: "job logs",
    });
    expect(createLoggerProvider).toHaveBeenCalledWith(
      "https://localhost",
      "Authorization=Bearer gc-secret",
      expect.objectContaining({
        "github.repository": "o/r",
        source: "github-actions",
      }),
    );
    expect(loggerForceFlush).toHaveBeenCalledTimes(1);
    expect(loggerShutdown).toHaveBeenCalledTimes(1);
  });

  it("does not create a logger provider when exportLogs is enabled but no job logs exist", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "apiKey") return "gc-secret";
      if (name === "exportLogs") return "true";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([{ id: 10 }]);
    getJobsAnnotations.mockResolvedValue({});
    getJobsLogs.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(createLoggerProvider).not.toHaveBeenCalled();
    expect(loggerForceFlush).not.toHaveBeenCalled();
    expect(loggerShutdown).not.toHaveBeenCalled();
  });

  it("flushes and shuts down logger provider during provider lifecycle", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "apiKey") return "gc-secret";
      if (name === "exportLogs") return "true";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([{ id: 10 }]);
    getJobsAnnotations.mockResolvedValue({});
    getJobsLogs.mockResolvedValue({ 10: "job logs" });
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(loggerForceFlush).toHaveBeenCalledTimes(1);
    expect(loggerShutdown).toHaveBeenCalledTimes(1);
  });

  it("logs and continues when job log export fails", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "apiKey") return "gc-secret";
      if (name === "exportLogs") return "true";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([{ id: 10 }]);
    getJobsAnnotations.mockResolvedValue({});
    getJobsLogs.mockRejectedValue(new Error("log download failed"));
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(core.info).toHaveBeenCalledWith("Failed to get job logs: log download failed");
    expect(traceWorkflowRun).toHaveBeenCalledWith(expect.any(Object), [{ id: 10 }], {}, {}, undefined, undefined, {});
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("stringifies non-Error job log failures", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "apiKey") return "gc-secret";
      if (name === "exportLogs") return "true";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([{ id: 10 }]);
    getJobsAnnotations.mockResolvedValue({});
    const nonErrorThrower = (function* (): Generator<never, never, unknown> {
      yield undefined as never;
      return undefined as never;
    })();
    getJobsLogs.mockImplementationOnce(() => {
      const result = nonErrorThrower.throw(null);
      return result as never;
    });
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(core.info).toHaveBeenCalledWith("Failed to get job logs: null");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("uses environment and workflow fallbacks for tracer attributes", async () => {
    process.env["OTEL_SERVICE_NAME"] = "svc-from-env";
    process.env["GITHUB_TOKEN"] = "token-from-env";

    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "apiKey") return "gc-secret";
      if (name === "extraAttributes") return "team=platform";
      if (name === "env") return "prod";
      if (name === "traceparent") return "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 11,
      workflow_id: 22,
      run_attempt: undefined,
      name: null,
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: null,
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(github.getOctokit).toHaveBeenCalledWith("token-from-env");
    expect(getPRsLabels).toHaveBeenCalledWith(github.context, { mocked: true }, []);
    expect(findTestResultsSummary).toHaveBeenCalledWith("");
    expect(stringToRecord).toHaveBeenCalledWith("team=platform");
    expect(extractParentContext).toHaveBeenCalledWith("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
    expect(createTracerProvider).toHaveBeenCalledWith(
      "https://localhost",
      "Authorization=Bearer gc-secret",
      expect.objectContaining({
        "service.name": "svc-from-env",
        "service.instance.id": "o/r/22/11/1",
        "github.repository": "o/r",
        "service.version": "abc",
        source: "github-actions",
        workload: "22",
        env: "prod",
      }),
    );
    expect(core.setSecret).toHaveBeenCalledWith("gc-secret");
    expect(core.setSecret).toHaveBeenCalledWith("Authorization=Bearer gc-secret");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("derives Authorization header from apiKey input", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "apiKey") return "gc-secret";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(createTracerProvider).toHaveBeenCalledWith(
      "https://localhost",
      "Authorization=Bearer gc-secret",
      expect.any(Object),
    );
    expect(core.setSecret).toHaveBeenCalledWith("gc-secret");
    expect(core.setSecret).toHaveBeenCalledWith("Authorization=Bearer gc-secret");
  });

  it("prefers explicit inputs for service name, workload, headers, and run id", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      if (name === "apiKey") return "gc-secret";
      if (name === "otelServiceName") return "svc-input";
      if (name === "workload") return "payments";
      if (name === "githubToken") return "token-input";
      if (name === "runId") return "789";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 3,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(github.getOctokit).toHaveBeenCalledWith("token-input");
    expect(getWorkflowRun).toHaveBeenCalledWith(github.context, { mocked: true }, 789);
    expect(createTracerProvider).toHaveBeenCalledWith(
      "https://localhost",
      "auth=token",
      expect.objectContaining({
        "service.name": "svc-input",
        workload: "payments",
        "service.instance.id": "o/r/2/1/3",
      }),
    );
    expect(core.setSecret).toHaveBeenCalledWith("gc-secret");
    expect(core.setSecret).toHaveBeenCalledWith("auth=token");
  });

  it("fails when neither otlpHeaders nor apiKey is provided", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      return "";
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith("Either otlpHeaders or apiKey is required");
  });

  it("falls back to workflow name for service name and stringifies non-Error failures", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "apiKey") return "gc-secret";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "Workflow Name",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});
    const nonErrorThrower = (function* (): Generator<never, never, unknown> {
      yield undefined as never;
      return undefined as never;
    })();
    createTracerProvider.mockImplementationOnce(() => {
      const result = nonErrorThrower.throw({ code: "EFAIL" });
      return result as never;
    });

    await run();

    expect(createTracerProvider).toHaveBeenCalledWith(
      "https://localhost",
      "Authorization=Bearer gc-secret",
      expect.objectContaining({
        "service.name": "Workflow Name",
      }),
    );
    expect(core.setFailed).toHaveBeenCalledWith('{"code":"EFAIL"}');
  });

  it("falls back to workflow id when neither input, env, nor workflow name exist", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "apiKey") return "gc-secret";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 4,
      workflow_id: 99,
      run_attempt: 2,
      name: null,
      head_sha: "def",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(createTracerProvider).toHaveBeenCalledWith(
      "https://localhost",
      "Authorization=Bearer gc-secret",
      expect.objectContaining({
        "service.name": "99",
        workload: "99",
        "service.instance.id": "o/r/99/4/2",
      }),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("logs and continues when job annotations throw an Octokit-style error", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockRejectedValue(
      new RequestError("annotations forbidden", 403, {
        response: { headers: {}, status: 403, url: "", data: {} },
        request: { method: "GET", url: "/test", headers: {} },
      }),
    );
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(core.info).toHaveBeenCalledWith("Failed to get job annotations: annotations forbidden");
    expect(core.setOutput).toHaveBeenCalledWith("traceId", "trace-id");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("logs and continues when PR labels throw an Octokit-style error", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [{ number: 7 }],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockRejectedValue(
      new RequestError("labels unavailable", 404, {
        response: { headers: {}, status: 404, url: "", data: {} },
        request: { method: "GET", url: "/test", headers: {} },
      }),
    );

    await run();

    expect(core.info).toHaveBeenCalledWith("Failed to get PRs labels: labels unavailable");
    expect(core.setOutput).toHaveBeenCalledWith("traceId", "trace-id");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("upserts a PR comment with trace details when workflow run is linked to PRs", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      if (name === "commentOnPr") return "true";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 42,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      html_url: "https://github.com/o/r/actions/runs/42",
      pull_requests: [{ number: 7 }, { number: 8 }],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(upsertPrTraceComment).toHaveBeenCalledTimes(2);
    expect(upsertPrTraceComment).toHaveBeenCalledWith(
      github.context,
      { mocked: true },
      {
        prNumber: 7,
        body: expect.stringContaining("Trace ID: `trace-id`"),
      },
    );
    expect(upsertPrTraceComment).toHaveBeenCalledWith(
      github.context,
      { mocked: true },
      {
        prNumber: 8,
        body: expect.stringContaining(
          "duration=Last+6+hours&filters=%255B%2522github.pull_requests.1.number%253A8%2522%255D",
        ),
      },
    );
  });

  it("uses custom groundcover base URL for the trace link in PR comment", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      if (name === "commentOnPr") return "true";
      if (name === "groundcoverBaseUrl") return "https://gc.example.com/custom/";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 77,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [{ number: 10 }],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(upsertPrTraceComment).toHaveBeenCalledWith(
      github.context,
      { mocked: true },
      {
        prNumber: 10,
        body: expect.stringContaining(
          "https://gc.example.com/custom/traces?duration=Last+6+hours&filters=%255B%2522github.pull_requests.0.number%253A10%2522%255D",
        ),
      },
    );
  });

  it("adds optional backend and tenant params to PR comment trace link", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      if (name === "commentOnPr") return "true";
      if (name === "groundcoverBackendId") return "groundcover";
      if (name === "groundcoverTenantUUID") return "a038dbeb-8971-33fa-aede-b11ad2731d36";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 78,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [{ number: 11 }],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(upsertPrTraceComment).toHaveBeenCalledWith(
      github.context,
      { mocked: true },
      {
        prNumber: 11,
        body: expect.stringContaining("backendId=groundcover&tenantUUID=a038dbeb-8971-33fa-aede-b11ad2731d36"),
      },
    );
  });

  it("logs and continues when upserting PR comment fails", async () => {
    upsertPrTraceComment.mockRejectedValueOnce(new Error("permission denied"));
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      if (name === "commentOnPr") return "true";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 42,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [{ number: 7 }],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(core.info).toHaveBeenCalledWith("Failed to upsert PR trace comment for #7: permission denied");
    expect(core.setOutput).toHaveBeenCalledWith("traceId", "trace-id");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("continues commenting remaining PRs when one PR comment upsert fails", async () => {
    upsertPrTraceComment.mockRejectedValueOnce(new Error("first failed"));
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      if (name === "commentOnPr") return "true";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 52,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [{ number: 7 }, { number: 8 }],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(upsertPrTraceComment).toHaveBeenCalledTimes(2);
    expect(core.info).toHaveBeenCalledWith("Failed to upsert PR trace comment for #7: first failed");
    expect(core.setOutput).toHaveBeenCalledWith("traceId", "trace-id");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("does not attempt PR comments when workflow run has no pull requests", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      if (name === "commentOnPr") return "true";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 44,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
      updated_at: "2024-01-01T00:00:00Z",
    });
    listJobsForWorkflowRun.mockResolvedValue([]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(upsertPrTraceComment).not.toHaveBeenCalled();
  });

  it("fails when job annotations throw a non-Octokit error", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [],
    });
    listJobsForWorkflowRun.mockResolvedValue([{ id: 10 }]);
    getJobsAnnotations.mockRejectedValue(new Error("boom"));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith("boom");
  });

  it("fails when PR labels throw a non-Octokit error", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      return "";
    });
    getWorkflowRun.mockResolvedValue({
      id: 1,
      workflow_id: 2,
      run_attempt: 1,
      name: "CI",
      head_sha: "abc",
      repository: { full_name: "o/r" },
      pull_requests: [{ number: 7 }],
    });
    listJobsForWorkflowRun.mockResolvedValue([{ id: 10 }]);
    getJobsAnnotations.mockResolvedValue({});
    getPRsLabels.mockRejectedValue(new Error("label boom"));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith("label boom");
  });
});

describe("resolveOtlpHeaders", () => {
  it("prefers explicit otlpHeaders over apiKey", () => {
    expect(resolveOtlpHeaders("authorization=custom", "gc-secret")).toBe("authorization=custom");
  });

  it("builds Authorization bearer header from apiKey", () => {
    expect(resolveOtlpHeaders("", "gc-secret")).toBe("Authorization=Bearer gc-secret");
  });
});

describe("buildTracesUrl", () => {
  it("normalizes trailing slash and appends traces path", () => {
    expect(buildTracesUrl("https://app.groundcover.com/")).toBe("https://app.groundcover.com/traces");
    expect(buildTracesUrl("https://gc.example.com/custom")).toBe("https://gc.example.com/custom/traces");
  });
});

describe("buildPrTracesUrl", () => {
  it("adds PR filter query to traces URL", () => {
    expect(buildPrTracesUrl("https://app.groundcover.com", 0, 123, { duration: "Last 6 hours" })).toBe(
      "https://app.groundcover.com/traces?duration=Last+6+hours&filters=%255B%2522github.pull_requests.0.number%253A123%2522%255D",
    );
    expect(buildPrTracesUrl("https://gc.example.com/custom/", 2, 7, { duration: "Last 6 hours" })).toBe(
      "https://gc.example.com/custom/traces?duration=Last+6+hours&filters=%255B%2522github.pull_requests.2.number%253A7%2522%255D",
    );
  });

  it("adds optional backend and tenant parameters", () => {
    expect(
      buildPrTracesUrl("https://app.groundcover.com", 0, 20700, {
        duration: "Last 6 hours",
        backendId: "groundcover",
        tenantUUID: "a038dbeb-8971-33fa-aede-b11ad2731d36",
      }),
    ).toBe(
      "https://app.groundcover.com/traces?duration=Last+6+hours&filters=%255B%2522github.pull_requests.0.number%253A20700%2522%255D&backendId=groundcover&tenantUUID=a038dbeb-8971-33fa-aede-b11ad2731d36",
    );
  });
});
