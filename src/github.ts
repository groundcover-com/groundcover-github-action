import * as core from "@actions/core";
import type { context } from "@actions/github";
import type { GitHub } from "@actions/github/lib/utils";
import type { components } from "@octokit/openapi-types";

type Context = typeof context;
type Octokit = InstanceType<typeof GitHub>;

async function getWorkflowRun(
  context: Context,
  octokit: Octokit,
  runId: number,
): Promise<components["schemas"]["workflow-run"]> {
  const res = await octokit.rest.actions.getWorkflowRun({
    ...context.repo,
    run_id: runId,
  });
  return res.data;
}

async function listJobsForWorkflowRun(
  context: Context,
  octokit: Octokit,
  runId: number,
): Promise<components["schemas"]["job"][]> {
  return await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
    ...context.repo,
    run_id: runId,
    filter: "latest",
    per_page: 100,
  });
}

async function getJobsAnnotations(
  context: Context,
  octokit: Octokit,
  jobIds: number[],
): Promise<Record<number, components["schemas"]["check-annotation"][]>> {
  const annotations: Record<number, components["schemas"]["check-annotation"][]> = {};

  for (const jobId of jobIds) {
    annotations[jobId] = await listAnnotations(context, octokit, jobId);
  }
  return annotations;
}

async function listAnnotations(
  context: Context,
  octokit: Octokit,
  checkRunId: number,
): Promise<components["schemas"]["check-annotation"][]> {
  return await octokit.paginate(octokit.rest.checks.listAnnotations, {
    ...context.repo,
    check_run_id: checkRunId,
  });
}

async function getPRsLabels(
  context: Context,
  octokit: Octokit,
  prNumbers: number[],
): Promise<Record<number, string[]>> {
  const labels: Record<number, string[]> = {};

  for (const prNumber of prNumbers) {
    labels[prNumber] = await listLabelsOnIssue(context, octokit, prNumber);
  }
  return labels;
}

async function listLabelsOnIssue(context: Context, octokit: Octokit, prNumber: number): Promise<string[]> {
  return await octokit.paginate(
    octokit.rest.issues.listLabelsOnIssue,
    {
      ...context.repo,
      issue_number: prNumber,
    },
    (response) => response.data.map((issue) => issue.name),
  );
}

async function getJobsLogs(context: Context, octokit: Octokit, jobIds: number[]): Promise<Record<number, string>> {
  const logs: Record<number, string> = {};

  for (const jobId of jobIds) {
    try {
      logs[jobId] = await downloadJobLog(context, octokit, jobId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Skipping logs for job ${jobId}: ${message}`);
    }
  }

  return logs;
}

async function downloadJobLog(context: Context, octokit: Octokit, jobId: number): Promise<string> {
  const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
    ...context.repo,
    job_id: jobId,
  });

  // Octokit auto-follows the 302 redirect, so response.data contains the log
  // content directly. The OpenAPI spec types the 302 as content: never, but at
  // runtime data is the plain-text log body from the redirect target.
  const { data } = response;
  if (typeof data !== "string" || data.length === 0) {
    throw new Error(`Empty log content for job ${jobId}`);
  }

  return data;
}

const TRACE_COMMENT_MARKER = "<!-- groundcover-trace-comment -->";

interface UpsertPrTraceCommentInput {
  prNumber: number;
  body: string;
}

async function upsertPrTraceComment(
  context: Context,
  octokit: Octokit,
  input: UpsertPrTraceCommentInput,
): Promise<void> {
  const commentBody = `${TRACE_COMMENT_MARKER}\n${input.body}`;
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...context.repo,
    issue_number: input.prNumber,
    per_page: 100,
  });

  const existingComment = [...comments]
    .reverse()
    .find((comment) => typeof comment.body === "string" && comment.body.startsWith(`${TRACE_COMMENT_MARKER}\n`));

  if (!existingComment) {
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: input.prNumber,
      body: commentBody,
    });
    return;
  }

  if (existingComment.body === commentBody) {
    return;
  }

  await octokit.rest.issues.updateComment({
    ...context.repo,
    comment_id: existingComment.id,
    body: commentBody,
  });
}

export {
  getWorkflowRun,
  listJobsForWorkflowRun,
  getJobsAnnotations,
  getPRsLabels,
  getJobsLogs,
  upsertPrTraceComment,
  type Octokit,
};
