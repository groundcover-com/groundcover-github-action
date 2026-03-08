import { beforeEach, describe, expect, it, jest } from "@jest/globals";

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
const getPRsLabels = jest.fn<() => Promise<unknown>>();
const createTracerProvider = jest.fn(() => ({
  forceFlush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
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
  getPRsLabels,
}));
jest.unstable_mockModule("./tracer.js", () => ({
  createTracerProvider,
  extractParentContext,
  stringToRecord,
}));
jest.unstable_mockModule("./trace/workflow.js", () => ({ traceWorkflowRun }));
jest.unstable_mockModule("./test-results.js", () => ({ findTestResultsSummary }));

const { run } = await import("./runner.js");

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
    getPRsLabels.mockReset();
    createTracerProvider.mockClear();
    extractParentContext.mockClear();
    stringToRecord.mockClear();
    traceWorkflowRun.mockClear();
    findTestResultsSummary.mockReset();
    findTestResultsSummary.mockResolvedValue(undefined);
    delete process.env["OTEL_SERVICE_NAME"];
    delete process.env["GITHUB_TOKEN"];
  });

  it("uses environment and workflow fallbacks for tracer attributes", async () => {
    process.env["OTEL_SERVICE_NAME"] = "svc-from-env";
    process.env["GITHUB_TOKEN"] = "token-from-env";

    core.getInput.mockImplementation((name: string) => {
      if (name === "otlpEndpoint") return "https://localhost/v1/traces";
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
      "https://localhost/v1/traces",
      "",
      expect.objectContaining({
        "service.name": "svc-from-env",
        "service.instance.id": "o/r/22/11/1",
        "service.namespace": "o/r",
        "service.version": "abc",
        source: "github-actions",
        workload: "22",
        env: "prod",
      }),
    );
    expect(core.setSecret).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("prefers explicit inputs for service name, workload, headers, and run id", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "otlpEndpoint") return "https://localhost/v1/traces";
      if (name === "otlpHeaders") return "auth=token";
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
      "https://localhost/v1/traces",
      "auth=token",
      expect.objectContaining({
        "service.name": "svc-input",
        workload: "payments",
        "service.instance.id": "o/r/2/1/3",
      }),
    );
    expect(core.setSecret).toHaveBeenCalledWith("auth=token");
  });

  it("falls back to workflow name for service name and stringifies non-Error failures", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "otlpEndpoint") return "https://localhost/v1/traces";
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
      "https://localhost/v1/traces",
      "",
      expect.objectContaining({
        "service.name": "Workflow Name",
      }),
    );
    expect(core.setFailed).toHaveBeenCalledWith('{"code":"EFAIL"}');
  });

  it("falls back to workflow id when neither input, env, nor workflow name exist", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "otlpEndpoint") return "https://localhost/v1/traces";
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
      "https://localhost/v1/traces",
      "",
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
      if (name === "otlpEndpoint") return "https://localhost/v1/traces";
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
    getJobsAnnotations.mockRejectedValue({ status: 403, message: "annotations forbidden" });
    getPRsLabels.mockResolvedValue({});

    await run();

    expect(core.info).toHaveBeenCalledWith("Failed to get job annotations: annotations forbidden");
    expect(core.setOutput).toHaveBeenCalledWith("traceId", "trace-id");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("logs and continues when PR labels throw an Octokit-style error", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "otlpEndpoint") return "https://localhost/v1/traces";
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
    getPRsLabels.mockRejectedValue({ status: 404, message: "labels unavailable" });

    await run();

    expect(core.info).toHaveBeenCalledWith("Failed to get PRs labels: labels unavailable");
    expect(core.setOutput).toHaveBeenCalledWith("traceId", "trace-id");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("fails when job annotations throw a non-Octokit error", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "otlpEndpoint") return "https://localhost/v1/traces";
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
      if (name === "otlpEndpoint") return "https://localhost/v1/traces";
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
