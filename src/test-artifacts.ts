import * as core from "@actions/core";
import type { context } from "@actions/github";
import type { components } from "@octokit/openapi-types";
import { strFromU8, unzipSync } from "fflate";
import { downloadArtifactZip, listWorkflowRunArtifacts, type Octokit } from "./github";
import { parseJUnitTestCases, type TestCase } from "./test-results";
import type { TestReport } from "./trace/test-trace";

type Context = typeof context;

interface NamedJob {
  name: string;
}

interface XmlFile {
  name: string;
  content: string;
}

/**
 * Mirror of the sanitization the uploading workflow applies to a job name:
 * every run of characters GitHub forbids in artifact names collapses to "-".
 */
function sanitizeArtifactNamePart(part: string): string {
  return part.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Reusable workflows prefix job display names ("test / router:test"); the tail is the job's own name. */
function jobNameTail(name: string): string {
  const segments = name.split(" / ");
  return segments[segments.length - 1] ?? name;
}

function matchArtifactToJob<T extends NamedJob>(artifactName: string, prefix: string, jobs: T[]): T | undefined {
  if (!artifactName.startsWith(prefix)) {
    return undefined;
  }

  const suffix = artifactName.slice(prefix.length);
  return jobs.find((job) => sanitizeArtifactNamePart(jobNameTail(job.name)) === suffix);
}

function extractXmlFilesFromZip(zip: Buffer): XmlFile[] {
  const entries = unzipSync(new Uint8Array(zip));
  const files: XmlFile[] = [];

  for (const [name, content] of Object.entries(entries)) {
    if (name.toLowerCase().endsWith(".xml")) {
      files.push({ name, content: strFromU8(content) });
    }
  }

  return files;
}

async function collectTestCasesFromArtifacts(
  context: Context,
  octokit: Octokit,
  runId: number,
  prefix: string,
  jobs: components["schemas"]["job"][],
): Promise<Record<number, TestReport[]>> {
  const artifacts = await listWorkflowRunArtifacts(context, octokit, runId);
  const testReportsByJobId: Record<number, TestReport[]> = {};

  for (const artifact of artifacts) {
    if (!artifact.name.startsWith(prefix) || artifact.expired) {
      continue;
    }

    const job = matchArtifactToJob(artifact.name, prefix, jobs);
    if (!job) {
      core.warning(`No job matches test-report artifact "${artifact.name}"; skipping it`);
      continue;
    }

    const zip = await downloadArtifactZip(context, octokit, artifact.id);
    for (const file of extractXmlFilesFromZip(zip)) {
      const cases = parseJUnitTestCases(file.content);
      if (!cases) {
        core.warning(`No test cases found in ${artifact.name}/${file.name}; skipping it`);
        continue;
      }
      const report: TestReport = { name: reportName(cases, file.name), cases };
      testReportsByJobId[job.id] = [...(testReportsByJobId[job.id] ?? []), report];
    }
  }

  const reports = Object.values(testReportsByJobId).flat();
  const total = reports.reduce((sum, report) => sum + report.cases.length, 0);
  core.info(
    `Collected ${total} test case(s) in ${reports.length} report(s) from run artifacts for ` +
      `${Object.keys(testReportsByJobId).length} job(s)`,
  );
  return testReportsByJobId;
}

/** The suite name when a file reports just one, else the file name — so sibling reports stay distinguishable. */
function reportName(cases: TestCase[], fileName: string): string {
  const suites = new Set(cases.map((testCase) => testCase.suite).filter(Boolean));
  const onlySuite = suites.size === 1 ? [...suites][0] : undefined;
  return onlySuite ?? fileName.replace(/^.*\//, "").replace(/\.xml$/i, "");
}

export {
  collectTestCasesFromArtifacts,
  extractXmlFilesFromZip,
  matchArtifactToJob,
  reportName,
  sanitizeArtifactNamePart,
};
