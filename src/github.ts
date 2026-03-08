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
    logs[jobId] = await downloadJobLog(context, octokit, jobId);
  }

  return logs;
}

async function downloadJobLog(context: Context, octokit: Octokit, jobId: number): Promise<string> {
  const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
    ...context.repo,
    job_id: jobId,
  });

  const location = response.headers.location;
  if (!location) {
    throw new Error(`Missing log download URL for job ${jobId}`);
  }

  const downloadResponse = await fetch(location);
  if (!downloadResponse.ok) {
    throw new Error(
      `Failed to download logs for job ${jobId}: ${downloadResponse.status} ${downloadResponse.statusText}`,
    );
  }

  return await downloadResponse.text();
}

export { getWorkflowRun, listJobsForWorkflowRun, getJobsAnnotations, getPRsLabels, getJobsLogs, type Octokit };
