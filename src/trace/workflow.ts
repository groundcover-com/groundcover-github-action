import type { components } from "@octokit/openapi-types";
import { type Attributes, type Context, context, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  ATTR_CICD_PIPELINE_ACTION_NAME,
  ATTR_CICD_PIPELINE_NAME,
  ATTR_CICD_PIPELINE_RESULT,
  ATTR_CICD_PIPELINE_RUN_ID,
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
import type { TestResultsSummary } from "../test-results";
import { traceJob } from "./job";

function traceWorkflowRun(
  workflowRun: components["schemas"]["workflow-run"],
  jobs: components["schemas"]["job"][],
  jobAnnotations: Record<number, components["schemas"]["check-annotation"][]>,
  prLabels: Record<number, string[]>,
  parentContext?: Context,
  testResults?: TestResultsSummary,
  jobLogs?: Record<number, string>,
): string {
  const tracer = trace.getTracer("otel-cicd-export-action");

  const startTime = new Date(workflowRun.run_started_at ?? workflowRun.created_at);
  const attributes = {
    ...workflowRunToAttributes(workflowRun, prLabels),
    ...testResultsToAttributes(testResults),
  };
  const activeContext = parentContext ?? ROOT_CONTEXT;

  const spanOptions = {
    attributes,
    startTime,
    ...(activeContext === ROOT_CONTEXT ? { root: true as const } : {}),
  };

  return tracer.startActiveSpan(
    workflowRun.name ?? workflowRun.display_title,
    spanOptions,
    activeContext,
    (rootSpan) => {
      const code = workflowRun.conclusion === "failure" ? SpanStatusCode.ERROR : SpanStatusCode.OK;
      rootSpan.setStatus({ code });

      const firstJob = jobs[0];
      if (firstJob) {
        // "Queued" span represents the time between the workflow started and the first job pickup
        const queuedSpan = tracer.startSpan("Queued", { startTime }, context.active());
        queuedSpan.end(new Date(firstJob.started_at));
      }

      for (const job of jobs) {
        traceJob(job, jobAnnotations[job.id], jobLogs?.[job.id]);
      }

      rootSpan.end(new Date(workflowRun.updated_at));
      return rootSpan.spanContext().traceId;
    },
  );
}

function testResultsToAttributes(testResults: TestResultsSummary | undefined): Attributes {
  if (!testResults) {
    return {};
  }

  return {
    "test.suites": testResults.suites,
    "test.total": testResults.total,
    "test.passed": testResults.passed,
    "test.failed": testResults.failed,
    "test.skipped": testResults.skipped,
    "test.errors": testResults.errors,
    "test.duration": testResults.duration,
  };
}

function workflowRunToAttributes(
  workflowRun: components["schemas"]["workflow-run"],
  prLabels: Record<number, string[]>,
): Attributes {
  return {
    [ATTR_CICD_PIPELINE_ACTION_NAME]: CICD_PIPELINE_ACTION_NAME_VALUE_RUN,
    [ATTR_CICD_PIPELINE_NAME]: workflowRun.name ?? undefined,
    [ATTR_CICD_PIPELINE_RESULT]: toPipelineResult(workflowRun.status, workflowRun.conclusion),
    [ATTR_CICD_PIPELINE_RUN_ID]: workflowRun.id,
    [ATTR_CICD_PIPELINE_RUN_URL_FULL]: workflowRun.html_url,
    [ATTR_CICD_PIPELINE_RUN_STATE]: toPipelineState(workflowRun.status),
    "github.workflow_id": workflowRun.workflow_id,
    "github.run_id": workflowRun.id,
    "github.run_number": workflowRun.run_number,
    "github.run_attempt": workflowRun.run_attempt ?? 1,
    ...referencedWorkflowsToAttributes(workflowRun.referenced_workflows),
    "github.url": workflowRun.url,
    "github.html_url": workflowRun.html_url,
    "github.workflow_url": workflowRun.workflow_url,
    "github.event": workflowRun.event,
    "github.workflow": workflowRun.name ?? undefined,
    "github.node_id": workflowRun.node_id,
    "github.check_suite_id": workflowRun.check_suite_id,
    "github.check_suite_node_id": workflowRun.check_suite_node_id,
    "github.status": workflowRun.status ?? undefined,
    "github.conclusion": workflowRun.conclusion ?? undefined,
    "github.created_at": workflowRun.created_at,
    "github.updated_at": workflowRun.updated_at,
    "github.run_started_at": workflowRun.run_started_at,
    "github.jobs_url": workflowRun.jobs_url,
    "github.logs_url": workflowRun.logs_url,
    "github.check_suite_url": workflowRun.check_suite_url,
    "github.artifacts_url": workflowRun.artifacts_url,
    "github.cancel_url": workflowRun.cancel_url,
    "github.rerun_url": workflowRun.rerun_url,
    "github.previous_attempt_url": workflowRun.previous_attempt_url ?? undefined,
    "github.display_title": workflowRun.display_title,
    ...headCommitToAttributes(workflowRun.head_commit),
    "github.head_branch": workflowRun.head_branch ?? undefined,
    "github.head_sha": workflowRun.head_sha,
    "github.path": workflowRun.path,
    error: workflowRun.conclusion === "failure",
    ...prsToAttributes(workflowRun.pull_requests, prLabels),
  };
}

function toPipelineResult(
  status: components["schemas"]["workflow-run"]["status"],
  conclusion: components["schemas"]["workflow-run"]["conclusion"],
): string | undefined {
  if (status === "failure" || status === "startup_failure") {
    return CICD_PIPELINE_RESULT_VALUE_ERROR;
  }

  switch (conclusion) {
    case "failure":
    case "action_required":
    case "stale":
      return CICD_PIPELINE_RESULT_VALUE_FAILURE;
    case "success":
    case "neutral":
      return CICD_PIPELINE_RESULT_VALUE_SUCCESS;
    case "cancelled":
      return CICD_PIPELINE_RESULT_VALUE_CANCELLATION;
    case "skipped":
      return CICD_PIPELINE_RESULT_VALUE_SKIP;
    case "timed_out":
      return CICD_PIPELINE_RESULT_VALUE_TIMEOUT;
    default:
      return undefined;
  }
}

function toPipelineState(status: components["schemas"]["workflow-run"]["status"]): string | undefined {
  switch (status) {
    case "requested":
    case "queued":
    case "pending":
    case "waiting":
      return CICD_PIPELINE_RUN_STATE_VALUE_PENDING;
    case "in_progress":
    case "expected":
      return CICD_PIPELINE_RUN_STATE_VALUE_EXECUTING;
    case "completed":
    case "failure":
    case "startup_failure":
      return CICD_PIPELINE_RUN_STATE_VALUE_FINALIZING;
    default:
      return undefined;
  }
}

function referencedWorkflowsToAttributes(
  refs: components["schemas"]["referenced-workflow"][] | null | undefined,
): Attributes {
  const attributes: Attributes = {};

  for (let i = 0; refs && i < refs.length; i++) {
    const ref = refs[i];
    if (ref) {
      const prefix = `github.referenced_workflows.${i}`;
      attributes[`${prefix}.path`] = ref.path;
      attributes[`${prefix}.sha`] = ref.sha;
      attributes[`${prefix}.ref`] = ref.ref;
    }
  }

  return attributes;
}

function headCommitToAttributes(head_commit: components["schemas"]["nullable-simple-commit"]): Attributes {
  return {
    "github.head_commit.id": head_commit?.id,
    "github.head_commit.tree_id": head_commit?.tree_id,
    "github.head_commit.author.name": head_commit?.author?.name,
    "github.head_commit.author.email": head_commit?.author?.email,
    "github.head_commit.committer.name": head_commit?.committer?.name,
    "github.head_commit.committer.email": head_commit?.committer?.email,
    "github.head_commit.message": head_commit?.message,
    "github.head_commit.timestamp": head_commit?.timestamp,
  };
}

function prsToAttributes(
  pullRequests: components["schemas"]["pull-request-minimal"][] | null,
  prLabels: Record<number, string[]>,
): Attributes {
  const firstPR = pullRequests?.[0];
  const attributes: Attributes = {
    "github.head_ref": firstPR?.head.ref,
    "github.base_ref": firstPR?.base.ref,
    "github.base_sha": firstPR?.base.sha,
  };

  for (let i = 0; pullRequests && i < pullRequests.length; i++) {
    const pr = pullRequests[i];
    if (pr) {
      const prefix = `github.pull_requests.${i}`;
      attributes[`${prefix}.id`] = pr.id;
      attributes[`${prefix}.url`] = pr.url;
      attributes[`${prefix}.number`] = pr.number;
      attributes[`${prefix}.labels`] = prLabels[pr.number];
      attributes[`${prefix}.head.sha`] = pr.head.sha;
      attributes[`${prefix}.head.ref`] = pr.head.ref;
      attributes[`${prefix}.head.repo.id`] = pr.head.repo.id;
      attributes[`${prefix}.head.repo.url`] = pr.head.repo.url;
      attributes[`${prefix}.head.repo.name`] = pr.head.repo.name;
      attributes[`${prefix}.base.ref`] = pr.base.ref;
      attributes[`${prefix}.base.sha`] = pr.base.sha;
      attributes[`${prefix}.base.repo.id`] = pr.base.repo.id;
      attributes[`${prefix}.base.repo.url`] = pr.base.repo.url;
      attributes[`${prefix}.base.repo.name`] = pr.base.repo.name;
    }
  }

  return attributes;
}

export { traceWorkflowRun };
