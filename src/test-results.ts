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

type TestCaseStatus = "passed" | "failed" | "error" | "skipped";

interface TestCase {
  /** Full test name as reported by the framework (for Go this includes the subtest path). */
  name: string;
  /** JUnit classname attribute — the package/module/file the test belongs to. */
  classname: string;
  /** Name of the enclosing testsuite. */
  suite: string;
  timeSeconds: number;
  status: TestCaseStatus;
  /** Failure/error message and body, capped at MAX_MESSAGE_LENGTH. */
  message?: string;
  /** The testcase's captured system-out, capped at MAX_OUTPUT_LENGTH. */
  output?: string;
  /** False when another case in the same classname extends this name (a Go subtest ancestor). */
  leaf: boolean;
  /** A zero-duration failure: the framework aborted before the test ran (e.g. Go -failfast). */
  collateral: boolean;
}

interface XmlFailureNode {
  message?: string | number;
  "#text"?: string | number;
}

interface XmlTestCaseNode {
  name?: string | number;
  classname?: string | number;
  time?: number | string;
  failure?: XmlFailureNode | XmlFailureNode[] | string | number;
  error?: XmlFailureNode | XmlFailureNode[] | string | number;
  skipped?: unknown;
  "system-out"?: XmlFailureNode | XmlFailureNode[] | string | number;
}

interface XmlNode {
  name?: string | number;
  tests?: number;
  failures?: number;
  skipped?: number;
  errors?: number;
  time?: number;
  testsuite?: XmlNode | XmlNode[];
  testcase?: XmlTestCaseNode | XmlTestCaseNode[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: true,
});

function parseTestResultsGlobs(input: string): string[] {
  return input
    .split(",")
    .map((pattern) => pattern.trim().replace(/\\/g, "/"))
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

const MAX_MESSAGE_LENGTH = 4096;
const MAX_OUTPUT_LENGTH = 16_384;

/**
 * A zero-duration failure that produced no output means the framework aborted
 * before the test ran (e.g. Go -failfast / suite abort). A zero-duration
 * failure WITH a body demonstrably ran — an instant assertion failure.
 */
function isCollateral(status: TestCaseStatus, timeSeconds: number, hasFailureBody: boolean): boolean {
  return (status === "failed" || status === "error") && timeSeconds === 0 && !hasFailureBody;
}

function hasBody(node: XmlFailureNode | XmlFailureNode[] | string | number | undefined): boolean {
  const first = Array.isArray(node) ? node[0] : node;
  if (first === undefined) {
    return false;
  }
  if (typeof first === "string" || typeof first === "number") {
    return String(first) !== "";
  }
  return first["#text"] !== undefined && first["#text"] !== "";
}

function extractMessage(
  node: XmlFailureNode | XmlFailureNode[] | string | number | undefined,
  maxLength = MAX_MESSAGE_LENGTH,
): string | undefined {
  const first = Array.isArray(node) ? node[0] : node;
  if (first === undefined) {
    return undefined;
  }
  if (typeof first === "string" || typeof first === "number") {
    return String(first).slice(0, maxLength) || undefined;
  }

  const parts = [first.message, first["#text"]].filter((part) => part !== undefined && part !== "").map(String);
  return parts.length > 0 ? parts.join("\n").slice(0, maxLength) : undefined;
}

function toCaseStatus(node: XmlTestCaseNode): TestCaseStatus {
  if (node.error !== undefined) {
    return "error";
  }
  if (node.failure !== undefined) {
    return "failed";
  }
  if (node.skipped !== undefined) {
    return "skipped";
  }
  return "passed";
}

function collectTestCases(node: XmlNode | undefined, cases: Omit<TestCase, "leaf">[]): void {
  if (!node) {
    return;
  }

  const suiteName = node.name === undefined ? "" : String(node.name);
  for (const testCase of toArray(node.testcase)) {
    if (testCase.name === undefined) {
      continue;
    }
    const status = toCaseStatus(testCase);
    const timeSeconds = Number(testCase.time ?? 0) || 0;
    const message = extractMessage(testCase.failure ?? testCase.error);
    const output = extractMessage(testCase["system-out"], MAX_OUTPUT_LENGTH);
    cases.push({
      name: String(testCase.name),
      classname: testCase.classname === undefined ? "" : String(testCase.classname),
      suite: suiteName,
      timeSeconds,
      status,
      ...(message !== undefined ? { message } : {}),
      ...(output !== undefined ? { output } : {}),
      collateral: isCollateral(status, timeSeconds, hasBody(testCase.failure ?? testCase.error)),
    });
  }

  for (const child of toArray(node.testsuite)) {
    collectTestCases(child, cases);
  }
}

/** A case is a leaf unless another case in the same classname extends its name (Go subtest ancestry). */
function markLeaves(cases: Omit<TestCase, "leaf">[]): TestCase[] {
  const namesByClassname = new Map<string, string[]>();
  for (const testCase of cases) {
    const names = namesByClassname.get(testCase.classname) ?? [];
    names.push(testCase.name);
    namesByClassname.set(testCase.classname, names);
  }

  return cases.map((testCase) => {
    const siblings = namesByClassname.get(testCase.classname) ?? [];
    const prefix = `${testCase.name}/`;
    const leaf = !siblings.some((name) => name.startsWith(prefix));
    return { ...testCase, leaf };
  });
}

/** Roll parsed test cases up into the same summary shape testResultsGlob produces. */
function summarizeTestCases(cases: TestCase[]): TestResultsSummary {
  const suites = new Set(cases.map((testCase) => testCase.suite)).size;
  const failed = cases.filter((testCase) => testCase.status === "failed").length;
  const errors = cases.filter((testCase) => testCase.status === "error").length;
  const skipped = cases.filter((testCase) => testCase.status === "skipped").length;
  const duration = cases.reduce((sum, testCase) => sum + testCase.timeSeconds, 0);

  return {
    suites,
    total: cases.length,
    passed: cases.length - failed - errors - skipped,
    failed,
    skipped,
    errors,
    duration,
  };
}

function parseJUnitTestCases(content: string): TestCase[] | undefined {
  const parsed = parser.parse(content) as { testsuites?: XmlNode; testsuite?: XmlNode };
  const cases: Omit<TestCase, "leaf">[] = [];
  collectTestCases(parsed.testsuites, cases);
  collectTestCases(parsed.testsuite, cases);

  return cases.length > 0 ? markLeaves(cases) : undefined;
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

export { findTestResultsSummary, parseJUnitXml, parseJUnitTestCases, summarizeTestCases };
export type { TestResultsSummary, TestCase, TestCaseStatus };
