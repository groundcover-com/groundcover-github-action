import * as core from "@actions/core";
import type { context } from "@actions/github";
import type { components } from "@octokit/openapi-types";
import { strFromU8, unzipSync } from "fflate";
import { downloadArtifactZip, listWorkflowRunArtifacts, type Octokit } from "./github";
import { parseJUnitTestCases, type TestCase } from "./test-results";

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

/**
 * Download the run's test-report artifacts (named `<prefix><sanitized job name>` by
 * the uploading workflow) and parse their JUnit XML into test cases per job id.
 */
async function collectTestCasesFromArtifacts(
  context: Context,
  octokit: Octokit,
  runId: number,
  prefix: string,
  jobs: components["schemas"]["job"][],
): Promise<Record<number, TestCase[]>> {
  const artifacts = await listWorkflowRunArtifacts(context, octokit, runId);
  const testCasesByJobId: Record<number, TestCase[]> = {};

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
      testCasesByJobId[job.id] = [...(testCasesByJobId[job.id] ?? []), ...cases];
    }
  }

  const total = Object.values(testCasesByJobId).reduce((sum, cases) => sum + cases.length, 0);
  core.info(`Collected ${total} test case(s) from run artifacts for ${Object.keys(testCasesByJobId).length} job(s)`);
  return testCasesByJobId;
}

export { collectTestCasesFromArtifacts, extractXmlFilesFromZip, matchArtifactToJob, sanitizeArtifactNamePart };
