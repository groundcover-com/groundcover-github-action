import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { RequestError } from "@octokit/request-error";
import type { Attributes } from "@opentelemetry/api";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { ATTR_SERVICE_INSTANCE_ID } from "@opentelemetry/semantic-conventions/incubating";
import { findTestResultsSummary } from "./test-results";
import { traceWorkflowRun } from "./trace/workflow";
import { createLoggerProvider, createTracerProvider, extractParentContext, stringToRecord } from "./tracer";
import {
  getJobsAnnotations,
  getJobsLogs,
  getPRsLabels,
  getWorkflowRun,
  listJobsForWorkflowRun,
  upsertPrTraceComment,
} from "./github";
import { version as ACTION_VERSION } from "../package.json";

function isOctokitError(err: unknown): err is RequestError {
  return err instanceof RequestError;
}

interface GithubData {
  workflowRun: Awaited<ReturnType<typeof getWorkflowRun>>;
  jobs: Awaited<ReturnType<typeof listJobsForWorkflowRun>>;
  jobAnnotations: Record<number, Awaited<ReturnType<typeof getJobsAnnotations>>[number]>;
  jobLogs: Record<number, string>;
  prLabels: Record<number, string[]>;
}

interface TraceLinkOptions {
  duration: string;
  backendId?: string;
  tenantUUID?: string;
}

function resolveOtlpHeaders(otlpHeaders: string, apiKey: string): string {
  if (otlpHeaders) {
    return otlpHeaders;
  }

  if (apiKey) {
    return `Authorization=Bearer ${apiKey}`;
  }

  throw new Error("Either otlpHeaders or apiKey is required");
}

async function fetchWorkflowRun(token: string, runId: number): Promise<GithubData["workflowRun"]> {
  const octokit = getOctokit(token);
  core.info(`Get workflow run for ${runId}`);
  return getWorkflowRun(context, octokit, runId);
}

async function fetchGithubDetails(
  token: string,
  runId: number,
  workflowRun: GithubData["workflowRun"],
  exportLogs: boolean,
): Promise<Omit<GithubData, "workflowRun">> {
  const octokit = getOctokit(token);

  core.info("Get jobs");
  const jobs = await listJobsForWorkflowRun(context, octokit, runId);

  core.info("Get job annotations");
  const jobsId = jobs.map((job) => job.id);
  let jobAnnotations: Record<number, Awaited<ReturnType<typeof getJobsAnnotations>>[number]> = {};
  let jobLogs: Record<number, string> = {};
  try {
    jobAnnotations = await getJobsAnnotations(context, octokit, jobsId);
  } catch (error: unknown) {
    if (isOctokitError(error)) {
      core.info(`Failed to get job annotations: ${error.message}`);
    } else {
      throw error;
    }
  }

  if (exportLogs) {
    core.info("Get job logs");
    try {
      jobLogs = await getJobsLogs(context, octokit, jobsId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      core.info(`Failed to get job logs: ${message}`);
    }
  }

  core.info("Get PRs labels");
  const prNumbers = (workflowRun.pull_requests ?? []).map((pr) => pr.number);
  let prLabels: Record<number, string[]> = {};
  try {
    prLabels = await getPRsLabels(context, octokit, prNumbers);
  } catch (error: unknown) {
    if (isOctokitError(error)) {
      core.info(`Failed to get PRs labels: ${error.message}`);
    } else {
      throw error;
    }
  }

  return { jobs, jobAnnotations, jobLogs, prLabels };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function buildTracesUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/traces`;
}

function buildPrTracesUrl(baseUrl: string, prIndex: number, prNumber: number, options: TraceLinkOptions): string {
  const tracesUrl = buildTracesUrl(baseUrl);
  const filterQuery = `github.pull_requests.${prIndex}.number:${prNumber}`;
  const filters = JSON.stringify([filterQuery]);
  const encodedFilters = encodeURIComponent(filters);
  const params = new URLSearchParams({ duration: options.duration, filters: encodedFilters });
  if (options.backendId) {
    params.set("backendId", options.backendId);
  }
  if (options.tenantUUID) {
    params.set("tenantUUID", options.tenantUUID);
  }
  return `${tracesUrl}?${params.toString()}`;
}

async function upsertPrTraceComments(
  token: string,
  workflowRun: GithubData["workflowRun"],
  groundcoverBaseUrl: string,
  traceLinkOptions: TraceLinkOptions,
  traceId?: string,
): Promise<void> {
  const pullRequests = workflowRun.pull_requests ?? [];
  if (pullRequests.length === 0) {
    return;
  }

  const octokit = getOctokit(token);
  const runUrl =
    workflowRun.html_url || `https://github.com/${workflowRun.repository.full_name}/actions/runs/${workflowRun.id}`;
  for (const [prIndex, pullRequest] of pullRequests.entries()) {
    const tracesUrl = buildPrTracesUrl(groundcoverBaseUrl, prIndex, pullRequest.number, traceLinkOptions);
    const lines = [
      "<details>",
      `<summary><a href="${tracesUrl}">Open in groundcover</a></summary>`,
      "<p>",
      "",
      `- PR: #${pullRequest.number}`,
    ];
    if (traceId) {
      lines.push(`- Trace ID: \`${traceId}\``);
    }
    lines.push(`- Workflow run: [View run](${runUrl})`, "", "</p>", "</details>");
    const commentBody = lines.join("\n");

    try {
      await upsertPrTraceComment(context, octokit, { prNumber: pullRequest.number, body: commentBody });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      core.info(`Failed to upsert PR trace comment for #${pullRequest.number}: ${message}`);
    }
  }
}

async function run(): Promise<void> {
  try {
    const otlpEndpoint = core.getInput("groundcoverEndpoint");
    const otlpHeaders = core.getInput("otlpHeaders");
    const apiKey = core.getInput("apiKey");
    const resolvedOtlpHeaders = resolveOtlpHeaders(otlpHeaders, apiKey);
    const otelServiceName = core.getInput("otelServiceName") || process.env["OTEL_SERVICE_NAME"] || "";
    const runId = Number.parseInt(core.getInput("runId") || `${context.runId}`, 10);
    const extraAttributes = stringToRecord(core.getInput("extraAttributes"));
    const testResultsGlob = core.getInput("testResultsGlob");
    const exportLogs = core.getInput("exportLogs") === "true";
    const env = core.getInput("env") || undefined;
    const workload = core.getInput("workload") || undefined;
    const ghToken = core.getInput("githubToken") || process.env["GITHUB_TOKEN"] || "";
    const traceparent = core.getInput("traceparent") || undefined;
    const groundcoverBaseUrl = core.getInput("groundcoverBaseUrl") || "https://app.groundcover.com";
    const commentOnPr = core.getInput("commentOnPr") === "true";
    const groundcoverDuration = core.getInput("groundcoverDuration") || "Last 6 hours";
    const groundcoverBackendId = core.getInput("groundcoverBackendId") || undefined;
    const groundcoverTenantUUID = core.getInput("groundcoverTenantUUID") || undefined;

    if (apiKey) core.setSecret(apiKey);
    core.setSecret(resolvedOtlpHeaders);

    const traceLinkOptions: TraceLinkOptions = {
      duration: groundcoverDuration,
      ...(groundcoverBackendId ? { backendId: groundcoverBackendId } : {}),
      ...(groundcoverTenantUUID ? { tenantUUID: groundcoverTenantUUID } : {}),
    };

    core.info("Use Github API to fetch workflow run");
    const workflowRun = await fetchWorkflowRun(ghToken, runId);

    if (commentOnPr) {
      core.info("Post early PR comment with groundcover link");
      await upsertPrTraceComments(ghToken, workflowRun, groundcoverBaseUrl, traceLinkOptions);
    }

    core.info("Use Github API to fetch workflow details");
    const { jobs, jobAnnotations, jobLogs, prLabels } = await fetchGithubDetails(
      ghToken,
      runId,
      workflowRun,
      exportLogs,
    );

    const testResults = await findTestResultsSummary(testResultsGlob);

    core.info(`Create tracer provider for ${otlpEndpoint}`);
    const attributes: Attributes = {
      [ATTR_SERVICE_NAME]: otelServiceName || workflowRun.name || `${workflowRun.workflow_id}`,
      [ATTR_SERVICE_INSTANCE_ID]: [
        workflowRun.repository.full_name,
        `${workflowRun.workflow_id}`,
        `${workflowRun.id}`,
        `${workflowRun.run_attempt ?? 1}`,
      ].join("/"),
      [ATTR_SERVICE_VERSION]: workflowRun.head_sha,
      "github.repository": workflowRun.repository.full_name,
      source: "github-actions",
      workload: workload || workflowRun.name || `${workflowRun.workflow_id}`,
      "groundcover.github_action.name": "groundcover-github-action",
      "groundcover.github_action.version": ACTION_VERSION,
      ...(env ? { env } : {}),
      ...extraAttributes,
    };
    const provider = createTracerProvider(otlpEndpoint, resolvedOtlpHeaders, attributes);

    const hasLogs = exportLogs && Object.keys(jobLogs).length > 0;
    const loggerProvider = hasLogs ? createLoggerProvider(otlpEndpoint, resolvedOtlpHeaders, attributes) : undefined;

    const parentContext = extractParentContext(traceparent);

    core.info(`Trace workflow run for ${runId} and export to ${otlpEndpoint}`);
    const traceId = traceWorkflowRun(workflowRun, jobs, jobAnnotations, prLabels, parentContext, testResults, jobLogs);

    core.setOutput("traceId", traceId);
    core.info(`traceId: ${traceId}`);

    core.info("Flush and shutdown providers");
    await provider.forceFlush();
    if (loggerProvider) {
      await loggerProvider.forceFlush();
    }

    if (commentOnPr) {
      core.info("Update PR comment with trace ID");
      await upsertPrTraceComments(ghToken, workflowRun, groundcoverBaseUrl, traceLinkOptions, traceId);
    }

    await provider.shutdown();
    if (loggerProvider) {
      await loggerProvider.shutdown();
    }
    core.info("Providers shutdown");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    core.setFailed(message);
  }
}

export { run, isOctokitError, resolveOtlpHeaders, buildTracesUrl, buildPrTracesUrl };
