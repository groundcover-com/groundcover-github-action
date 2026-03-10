import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import type { RequestError } from "@octokit/request-error";
import type { Attributes } from "@opentelemetry/api";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { ATTR_SERVICE_INSTANCE_ID } from "@opentelemetry/semantic-conventions/incubating";
import { findTestResultsSummary } from "./test-results";
import { traceWorkflowRun } from "./trace/workflow";
import { createLoggerProvider, createTracerProvider, extractParentContext, stringToRecord } from "./tracer";
import { getJobsAnnotations, getJobsLogs, getPRsLabels, getWorkflowRun, listJobsForWorkflowRun } from "./github";

function isOctokitError(err: unknown): err is RequestError {
  return !!err && typeof err === "object" && "status" in err;
}

interface GithubData {
  workflowRun: Awaited<ReturnType<typeof getWorkflowRun>>;
  jobs: Awaited<ReturnType<typeof listJobsForWorkflowRun>>;
  jobAnnotations: Record<number, Awaited<ReturnType<typeof getJobsAnnotations>>[number]>;
  jobLogs: Record<number, string>;
  prLabels: Record<number, string[]>;
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

async function fetchGithub(token: string, runId: number, exportLogs: boolean): Promise<GithubData> {
  const octokit = getOctokit(token);

  core.info(`Get workflow run for ${runId}`);
  const workflowRun = await getWorkflowRun(context, octokit, runId);

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

  return { workflowRun, jobs, jobAnnotations, jobLogs, prLabels };
}

async function run(): Promise<void> {
  try {
    const otlpEndpoint = core.getInput("otlpEndpoint");
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

    if (apiKey) core.setSecret(apiKey);
    core.setSecret(resolvedOtlpHeaders);

    core.info("Use Github API to fetch workflow data");
    const { workflowRun, jobs, jobAnnotations, jobLogs, prLabels } = await fetchGithub(ghToken, runId, exportLogs);

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
      ...(env ? { env } : {}),
      ...extraAttributes,
    };
    const provider = createTracerProvider(otlpEndpoint, resolvedOtlpHeaders, attributes);

    const hasLogs = exportLogs && Object.keys(jobLogs).length > 0;
    core.info(`Export logs: ${exportLogs}, job logs fetched: ${Object.keys(jobLogs).length}, hasLogs: ${hasLogs}`);
    const loggerProvider = hasLogs ? createLoggerProvider(otlpEndpoint, resolvedOtlpHeaders, attributes) : undefined;
    if (loggerProvider) {
      core.info("Logger provider created");
    }

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

export { run, isOctokitError, resolveOtlpHeaders };
