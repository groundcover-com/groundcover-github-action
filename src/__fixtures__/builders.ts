import type { components } from "@octokit/openapi-types";
import type { TestCase } from "../test-results";

type Job = components["schemas"]["job"];
type CompletedJob = Job & { completed_at: string };

let sequence = 0;

/** Values are randomized so a test that depends on one has to state it. */
function unique(): string {
  sequence += 1;
  return `${sequence}${Math.random().toString(36).slice(2, 8)}`;
}

function aNumber(max = 100_000): number {
  return Math.floor(Math.random() * max) + 1;
}

function aSha(): string {
  return Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
}

function aTestName(): string {
  return `Test${unique()}`;
}

function aPackageName(): string {
  return `example.test/pkg/${unique()}`;
}

function aJobName(): string {
  return `job-${unique()}`;
}

function aTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    name: aTestName(),
    classname: aPackageName(),
    suite: aPackageName(),
    timeSeconds: aNumber(30),
    status: "passed",
    leaf: true,
    collateral: false,
    ...overrides,
  };
}

function aJobContext(overrides: Partial<Job> = {}): CompletedJob {
  const startedAt = new Date(Date.UTC(2020 + aNumber(5), aNumber(11), aNumber(27), aNumber(22), aNumber(58)));
  return {
    id: aNumber(),
    run_id: aNumber(),
    run_attempt: aNumber(5),
    name: aJobName(),
    head_sha: aSha(),
    head_branch: `branch-${unique()}`,
    workflow_name: `workflow-${unique()}`,
    run_url: `https://api.github.com/repos/acme/repo/actions/runs/${aNumber()}`,
    node_id: `CR_${unique()}`,
    url: `https://api.github.com/repos/acme/repo/actions/jobs/${aNumber()}`,
    html_url: `https://github.com/acme/repo/actions/runs/${aNumber()}`,
    status: "completed",
    conclusion: "success",
    created_at: startedAt.toISOString(),
    started_at: startedAt.toISOString(),
    completed_at: new Date(startedAt.getTime() + aNumber(600) * 1000).toISOString(),
    steps: [],
    check_run_url: `https://api.github.com/repos/acme/repo/check-runs/${aNumber()}`,
    labels: ["ubuntu-latest"],
    runner_id: aNumber(),
    runner_name: `runner-${unique()}`,
    runner_group_id: aNumber(),
    runner_group_name: "default",
    ...overrides,
  } as CompletedJob;
}

export { aTestCase, aJobContext, aTestName, aPackageName, aJobName, aSha, aNumber, unique, type CompletedJob };
