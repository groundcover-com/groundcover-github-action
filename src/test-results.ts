import * as core from "@actions/core";
import fg from "fast-glob";
import { XMLParser } from "fast-xml-parser";
import { readFile } from "node:fs/promises";

interface TestResultsSummary {
  suites: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  duration: number;
}

interface XmlNode {
  tests?: number;
  failures?: number;
  skipped?: number;
  errors?: number;
  time?: number;
  testsuite?: XmlNode | XmlNode[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: true,
});

function parseTestResultsGlobs(input: string): string[] {
  return input
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function emptySummary(): TestResultsSummary {
  return {
    suites: 0,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
    duration: 0,
  };
}

function addSummary(a: TestResultsSummary, b: TestResultsSummary): TestResultsSummary {
  return {
    suites: a.suites + b.suites,
    total: a.total + b.total,
    passed: a.passed + b.passed,
    failed: a.failed + b.failed,
    skipped: a.skipped + b.skipped,
    errors: a.errors + b.errors,
    duration: a.duration + b.duration,
  };
}

function extractNodeSummary(node: XmlNode | undefined): TestResultsSummary | undefined {
  if (!node) {
    return undefined;
  }

  const ownTests = typeof node.tests === "number" ? node.tests : undefined;
  const ownFailures = typeof node.failures === "number" ? node.failures : 0;
  const ownSkipped = typeof node.skipped === "number" ? node.skipped : 0;
  const ownErrors = typeof node.errors === "number" ? node.errors : 0;
  const ownDuration = typeof node.time === "number" ? node.time : 0;

  if (ownTests !== undefined) {
    return {
      suites: 1,
      total: ownTests,
      passed: Math.max(0, ownTests - ownFailures - ownSkipped - ownErrors),
      failed: ownFailures,
      skipped: ownSkipped,
      errors: ownErrors,
      duration: ownDuration,
    };
  }

  const children = toArray(node.testsuite);
  if (children.length === 0) {
    return undefined;
  }

  let summary = emptySummary();
  for (const child of children) {
    const childSummary = extractNodeSummary(child);
    if (childSummary) {
      summary = addSummary(summary, childSummary);
    }
  }

  return summary.total > 0 || summary.suites > 0 ? summary : undefined;
}

function parseJUnitXml(content: string): TestResultsSummary | undefined {
  const parsed = parser.parse(content) as { testsuites?: XmlNode; testsuite?: XmlNode };
  return extractNodeSummary(parsed.testsuites) ?? extractNodeSummary(parsed.testsuite);
}

async function findTestResultsSummary(input: string): Promise<TestResultsSummary | undefined> {
  const patterns = parseTestResultsGlobs(input);
  if (patterns.length === 0) {
    return undefined;
  }

  const files = await fg(patterns, { absolute: true, onlyFiles: true, unique: true });
  if (files.length === 0) {
    core.info(`No test result files matched patterns: ${patterns.join(", ")}`);
    return undefined;
  }

  let summary = emptySummary();
  let parsedFiles = 0;

  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      const fileSummary = parseJUnitXml(content);
      if (fileSummary) {
        summary = addSummary(summary, fileSummary);
        parsedFiles += 1;
      } else {
        core.warning(`Skipping unsupported test result file: ${file}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Failed to parse test result file ${file}: ${message}`);
    }
  }

  if (parsedFiles === 0) {
    return undefined;
  }

  core.info(`Parsed ${parsedFiles} test result file(s)`);
  return summary;
}

export { findTestResultsSummary, parseJUnitXml };
export type { TestResultsSummary };
