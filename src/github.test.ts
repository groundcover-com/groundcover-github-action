import { jest, describe, it, expect, afterEach } from "@jest/globals";
import type { context as ghContext } from "@actions/github";
import {
  getWorkflowRun,
  listJobsForWorkflowRun,
  getJobsAnnotations,
  getPRsLabels,
  getJobsLogs,
  type Octokit,
} from "./github.js";

type Context = typeof ghContext;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createMocks() {
  const getWorkflowRunFn = jest.fn<() => Promise<unknown>>();
  const listJobsForWorkflowRunFn = jest.fn<() => Promise<unknown>>();
  const downloadJobLogsForWorkflowRunFn = jest.fn<() => Promise<unknown>>();
  const listAnnotationsFn = jest.fn<() => Promise<unknown>>();
  const listLabelsOnIssueFn = jest.fn<() => Promise<unknown>>();
  const paginate = jest.fn<() => Promise<unknown>>();

  const mockContext = {
    repo: { owner: "test-owner", repo: "test-repo" },
  } as unknown as Context;

  const mockOctokit = {
    rest: {
      actions: {
        getWorkflowRun: getWorkflowRunFn,
        listJobsForWorkflowRun: listJobsForWorkflowRunFn,
        downloadJobLogsForWorkflowRun: downloadJobLogsForWorkflowRunFn,
      },
      checks: {
        listAnnotations: listAnnotationsFn,
      },
      issues: {
        listLabelsOnIssue: listLabelsOnIssueFn,
      },
    },
    paginate,
  } as unknown as Octokit;

  return {
    mockContext,
    mockOctokit,
    getWorkflowRunFn,
    paginate,
    listJobsForWorkflowRunFn,
    downloadJobLogsForWorkflowRunFn,
    listAnnotationsFn,
    listLabelsOnIssueFn,
  };
}

describe("github", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("getJobsLogs", () => {
    it("downloads plain text logs for each job", async () => {
      const { mockContext, mockOctokit, downloadJobLogsForWorkflowRunFn } = createMocks();
      const originalFetch = global.fetch;
      const fetchMock = jest.fn<typeof fetch>();
      global.fetch = fetchMock;

      downloadJobLogsForWorkflowRunFn
        .mockResolvedValueOnce({ headers: { location: "https://logs.example/1" } })
        .mockResolvedValueOnce({ headers: { location: "https://logs.example/2" } });
      fetchMock
        .mockResolvedValueOnce({ ok: true, text: jest.fn(() => Promise.resolve("job-1 logs")) } as unknown as Response)
        .mockResolvedValueOnce({ ok: true, text: jest.fn(() => Promise.resolve("job-2 logs")) } as unknown as Response);

      const result = await getJobsLogs(mockContext, mockOctokit, [100, 200]);

      expect(result).toEqual({ 100: "job-1 logs", 200: "job-2 logs" });
      expect(downloadJobLogsForWorkflowRunFn).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        job_id: 100,
      });
      expect(downloadJobLogsForWorkflowRunFn).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        job_id: 200,
      });
      expect(fetchMock).toHaveBeenCalledWith("https://logs.example/1");
      expect(fetchMock).toHaveBeenCalledWith("https://logs.example/2");

      global.fetch = originalFetch;
    });

    it("fails when GitHub does not return a download URL", async () => {
      const { mockContext, mockOctokit, downloadJobLogsForWorkflowRunFn } = createMocks();

      downloadJobLogsForWorkflowRunFn.mockResolvedValue({ headers: {} });

      await expect(getJobsLogs(mockContext, mockOctokit, [100])).rejects.toThrow(
        "Missing log download URL for job 100",
      );
    });

    it("fails when the redirected log download is not successful", async () => {
      const { mockContext, mockOctokit, downloadJobLogsForWorkflowRunFn } = createMocks();
      const originalFetch = global.fetch;
      const fetchMock = jest.fn<typeof fetch>();
      global.fetch = fetchMock;

      downloadJobLogsForWorkflowRunFn.mockResolvedValue({ headers: { location: "https://logs.example/1" } });
      fetchMock.mockResolvedValueOnce({ ok: false, status: 502, statusText: "Bad Gateway" } as Response);

      await expect(getJobsLogs(mockContext, mockOctokit, [100])).rejects.toThrow(
        "Failed to download logs for job 100: 502 Bad Gateway",
      );

      global.fetch = originalFetch;
    });
  });

  describe("getWorkflowRun", () => {
    it("calls the correct API endpoint and returns data", async () => {
      const { mockContext, mockOctokit, getWorkflowRunFn } = createMocks();
      const workflowData = { id: 123, name: "CI" };
      getWorkflowRunFn.mockResolvedValue({ data: workflowData });

      const result = await getWorkflowRun(mockContext, mockOctokit, 123);

      expect(result).toEqual(workflowData);
      expect(getWorkflowRunFn).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        run_id: 123,
      });
    });
  });

  describe("listJobsForWorkflowRun", () => {
    it("paginates jobs with correct parameters", async () => {
      const { mockContext, mockOctokit, paginate, listJobsForWorkflowRunFn } = createMocks();
      const jobs = [
        { id: 1, name: "build" },
        { id: 2, name: "test" },
      ];
      paginate.mockResolvedValue(jobs);

      const result = await listJobsForWorkflowRun(mockContext, mockOctokit, 456);

      expect(result).toEqual(jobs);
      expect(paginate).toHaveBeenCalledWith(listJobsForWorkflowRunFn, {
        owner: "test-owner",
        repo: "test-repo",
        run_id: 456,
        filter: "latest",
        per_page: 100,
      });
    });
  });

  describe("getJobsAnnotations", () => {
    it("fetches annotations for each job ID", async () => {
      const { mockContext, mockOctokit, paginate, listAnnotationsFn } = createMocks();
      const annotations1 = [{ annotation_level: "warning", message: "warn1" }];
      const annotations2 = [{ annotation_level: "failure", message: "err1" }];
      paginate.mockResolvedValueOnce(annotations1).mockResolvedValueOnce(annotations2);

      const result = await getJobsAnnotations(mockContext, mockOctokit, [100, 200]);

      expect(result).toEqual({
        100: annotations1,
        200: annotations2,
      });
      expect(paginate).toHaveBeenCalledTimes(2);
      expect(paginate).toHaveBeenCalledWith(listAnnotationsFn, {
        owner: "test-owner",
        repo: "test-repo",
        check_run_id: 100,
      });
      expect(paginate).toHaveBeenCalledWith(listAnnotationsFn, {
        owner: "test-owner",
        repo: "test-repo",
        check_run_id: 200,
      });
    });

    it("returns empty record for empty job IDs", async () => {
      const { mockContext, mockOctokit } = createMocks();

      const result = await getJobsAnnotations(mockContext, mockOctokit, []);

      expect(result).toEqual({});
    });
  });

  describe("getPRsLabels", () => {
    it("fetches labels for each PR number", async () => {
      const { mockContext, mockOctokit, paginate, listLabelsOnIssueFn } = createMocks();
      paginate.mockResolvedValueOnce(["bug", "enhancement"]).mockResolvedValueOnce(["docs"]);

      const result = await getPRsLabels(mockContext, mockOctokit, [10, 20]);

      expect(result).toEqual({
        10: ["bug", "enhancement"],
        20: ["docs"],
      });
      expect(paginate).toHaveBeenCalledTimes(2);
      expect(paginate).toHaveBeenCalledWith(
        listLabelsOnIssueFn,
        { owner: "test-owner", repo: "test-repo", issue_number: 10 },
        expect.any(Function),
      );
    });

    it("returns empty record for empty PR numbers", async () => {
      const { mockContext, mockOctokit } = createMocks();

      const result = await getPRsLabels(mockContext, mockOctokit, []);

      expect(result).toEqual({});
    });
  });
});
