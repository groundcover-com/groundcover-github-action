import * as core from "@actions/core";
import type { components } from "@octokit/openapi-types";
import { type Attributes, context, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  ATTR_CICD_PIPELINE_TASK_NAME,
  ATTR_CICD_PIPELINE_TASK_RUN_ID,
  ATTR_CICD_PIPELINE_TASK_RUN_RESULT,
  ATTR_CICD_PIPELINE_TASK_RUN_URL_FULL,
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
import { traceStep } from "./step";

type CompletedJob = components["schemas"]["job"] & { completed_at: string };

const GITHUB_LOG_LINE_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)$/;

interface ParsedLogLine {
  timestamp: number;
  body: string;
  severityNumber: SeverityNumber;
  severityText: string;
}

function parseGitHubLogLines(rawLog: string): ParsedLogLine[] {
  const lines = rawLog.split("\n");
  const result: ParsedLogLine[] = [];

  for (const line of lines) {
    if (!line) continue;

    const match = GITHUB_LOG_LINE_REGEX.exec(line);
    const timestamp = match?.[1] ? new Date(match[1]).getTime() : Date.now();
    let body = match?.[2] ?? line;
    let severityNumber = SeverityNumber.INFO;
    let severityText = "INFO";

    if (body.startsWith("##[error]")) {
      severityNumber = SeverityNumber.ERROR;
      severityText = "ERROR";
      body = body.slice(9);
    } else if (body.startsWith("##[warning]")) {
      severityNumber = SeverityNumber.WARN;
      severityText = "WARN";
      body = body.slice(11);
    }

    result.push({ timestamp, body, severityNumber, severityText });
  }

  return result;
}

function emitJobLogs(rawLog: string, jobId: number, jobName: string): void {
  const logger = logs.getLogger("otel-cicd-export-action");
  const logLines = parseGitHubLogLines(rawLog);
  const activeContext = context.active();

  for (const line of logLines) {
    logger.emit({
      timestamp: line.timestamp,
      body: line.body,
      severityNumber: line.severityNumber,
      severityText: line.severityText,
      context: activeContext,
      attributes: {
        "github.job.id": jobId,
        "github.job.name": jobName,
      },
    });
  }
}

function traceJob(
  job: components["schemas"]["job"],
  annotations?: components["schemas"]["check-annotation"][],
  jobLog?: string,
): void {
  const tracer = trace.getTracer("otel-cicd-export-action");

  if (!job.completed_at) {
    core.info(`Job ${job.id} is not completed yet`);
    return;
  }

  const completedJob: CompletedJob = { ...job, completed_at: job.completed_at };
  const startTime = new Date(completedJob.started_at);
  const completedTime = new Date(completedJob.completed_at);
  const attributes = {
    ...jobToAttributes(completedJob),
    ...annotationsToAttributes(annotations),
  };

  tracer.startActiveSpan(job.name, { attributes, startTime }, (span) => {
    const code = job.conclusion === "failure" ? SpanStatusCode.ERROR : SpanStatusCode.OK;
    span.setStatus({ code });

    for (const step of job.steps ?? []) {
      traceStep(step);
    }

    if (jobLog) {
      emitJobLogs(jobLog, job.id, job.name);
    }

    // Some skipped and post jobs return completed_at dates that are older than started_at
    span.end(new Date(Math.max(startTime.getTime(), completedTime.getTime())));
  });
}

function jobToAttributes(job: CompletedJob): Attributes {
  let taskType: string | undefined;
  if (job.name.toLowerCase().includes("build")) {
    taskType = CICD_PIPELINE_TASK_TYPE_VALUE_BUILD;
  } else if (job.name.toLowerCase().includes("test")) {
    taskType = CICD_PIPELINE_TASK_TYPE_VALUE_TEST;
  } else if (job.name.toLowerCase().includes("deploy")) {
    taskType = CICD_PIPELINE_TASK_TYPE_VALUE_DEPLOY;
  }

  return {
    [ATTR_CICD_PIPELINE_TASK_NAME]: job.name,
    [ATTR_CICD_PIPELINE_TASK_RUN_ID]: job.id,
    [ATTR_CICD_PIPELINE_TASK_RUN_RESULT]: toTaskResult(job.conclusion),
    [ATTR_CICD_PIPELINE_TASK_RUN_URL_FULL]: job.html_url ?? undefined,
    [ATTR_CICD_PIPELINE_TASK_TYPE]: taskType,
    [ATTR_CICD_WORKER_ID]: job.runner_id ?? undefined,
    [ATTR_CICD_WORKER_NAME]: job.runner_name ?? undefined,
    "github.job.id": job.id,
    "github.job.name": job.name,
    "github.job.run_id": job.run_id,
    "github.job.run_url": job.run_url,
    "github.job.run_attempt": job.run_attempt ?? 1,
    "github.job.node_id": job.node_id,
    "github.job.head_sha": job.head_sha,
    "github.job.url": job.url,
    "github.job.html_url": job.html_url ?? undefined,
    "github.job.status": job.status,
    "github.job.runner_id": job.runner_id ?? undefined,
    "github.job.runner_group_id": job.runner_group_id ?? undefined,
    "github.job.runner_group_name": job.runner_group_name ?? undefined,
    "github.job.runner_name": job.runner_name ?? undefined,
    "github.job.conclusion": job.conclusion ?? undefined,
    "github.job.labels": job.labels.join(", "),
    "github.job.created_at": job.created_at,
    "github.job.started_at": job.started_at,
    "github.job.completed_at": job.completed_at,
    "github.conclusion": job.conclusion ?? undefined,
    "github.job.check_run_url": job.check_run_url,
    "github.job.workflow_name": job.workflow_name ?? undefined,
    "github.job.head_branch": job.head_branch ?? undefined,
    error: job.conclusion === "failure",
  };
}

function toTaskResult(conclusion: components["schemas"]["job"]["conclusion"]): string | undefined {
  switch (conclusion) {
    case "failure":
    case "action_required":
      return CICD_PIPELINE_TASK_RUN_RESULT_VALUE_FAILURE;
    case "success":
    case "neutral":
      return CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SUCCESS;
    case "cancelled":
      return CICD_PIPELINE_TASK_RUN_RESULT_VALUE_CANCELLATION;
    case "skipped":
      return CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SKIP;
    case "timed_out":
      return CICD_PIPELINE_TASK_RUN_RESULT_VALUE_TIMEOUT;
    default:
      return undefined;
  }
}

function annotationsToAttributes(annotations: components["schemas"]["check-annotation"][] | undefined): Attributes {
  const attributes: Attributes = {};

  for (let i = 0; annotations && i < annotations.length; i++) {
    const annotation = annotations[i];
    if (annotation) {
      const prefix = `github.job.annotations.${i}`;
      attributes[`${prefix}.level`] = annotation.annotation_level ?? undefined;
      attributes[`${prefix}.message`] = annotation.message ?? undefined;
    }
  }

  return attributes;
}

export { traceJob, emitJobLogs, parseGitHubLogLines };
