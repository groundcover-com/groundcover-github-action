import * as core from "@actions/core";
import type { components } from "@octokit/openapi-types";
import { type Attributes, context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { type ParsedLogLine, mergeLogLines } from "./job";
import {
  ATTR_CICD_PIPELINE_TASK_NAME,
  ATTR_CICD_PIPELINE_TASK_RUN_ID,
  ATTR_CICD_PIPELINE_TASK_RUN_RESULT,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_CANCELLATION,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_FAILURE,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SKIP,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_SUCCESS,
  CICD_PIPELINE_TASK_RUN_RESULT_VALUE_TIMEOUT,
} from "@opentelemetry/semantic-conventions/incubating";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";

type Step = NonNullable<components["schemas"]["job"]["steps"]>[number];
type CompletedStep = Step & { started_at: string; completed_at: string };

function traceStep(step: Step, logLines?: ParsedLogLine[], jobId?: number, jobName?: string): void {
  const tracer = trace.getTracer("otel-cicd-export-action");

  if (!(step.completed_at && step.started_at)) {
    core.info(`Step ${step.name} is not completed yet.`);
    return;
  }

  if (step.conclusion === "skipped") {
    core.info(`Step ${step.name} did not run.`);
    return;
  }

  const completedStep: CompletedStep = { ...step, started_at: step.started_at, completed_at: step.completed_at };
  const startTime = new Date(completedStep.started_at);
  const completedTime = new Date(completedStep.completed_at);
  const attributes = stepToAttributes(completedStep, jobId);

  tracer.startActiveSpan(step.name, { attributes, startTime, kind: SpanKind.INTERNAL }, (span) => {
    const taskResult = toStepResult(step.conclusion);
    const isFailure = taskResult === CICD_PIPELINE_TASK_RUN_RESULT_VALUE_FAILURE;
    if (isFailure) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute(ATTR_ERROR_TYPE, step.conclusion ?? "unknown");
    }

    if (logLines && logLines.length > 0) {
      const logger = logs.getLogger("otel-cicd-export-action");
      const activeContext = context.active();
      const merged = mergeLogLines(logLines);

      logger.emit({
        timestamp: new Date(merged.timestamp),
        body: merged.body,
        severityNumber: merged.severityNumber,
        severityText: merged.severityText,
        context: activeContext,
        attributes: {
          "github.job.id": jobId,
          "github.job.name": jobName,
          "github.job.step.name": step.name,
          "github.job.step.number": step.number,
        },
      });
    }

    // Some skipped and post jobs return completed_at dates that are older than started_at
    span.end(new Date(Math.max(startTime.getTime(), completedTime.getTime())));
  });
}

function stepToAttributes(step: CompletedStep, jobId?: number): Attributes {
  return {
    [ATTR_CICD_PIPELINE_TASK_NAME]: step.name,
    [ATTR_CICD_PIPELINE_TASK_RUN_ID]: jobId != null ? `${jobId}:${step.number}` : String(step.number),
    [ATTR_CICD_PIPELINE_TASK_RUN_RESULT]: toStepResult(step.conclusion),
    "github.job.step.status": step.status,
    "github.job.step.conclusion": step.conclusion ?? undefined,
    "github.job.step.name": step.name,
    "github.job.step.number": step.number,
    "github.job.step.started_at": step.started_at,
    "github.job.step.completed_at": step.completed_at,
    error: step.conclusion === "failure",
  };
}

function toStepResult(conclusion: Step["conclusion"]): string | undefined {
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

export { traceStep };
