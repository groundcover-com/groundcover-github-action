import {
  isCollateral,
  markLeaves,
  MAX_MESSAGE_LENGTH,
  MAX_OUTPUT_LENGTH,
  type ParseOptions,
  type TestCase,
  type TestCaseStatus,
} from "./test-case";

interface CtrfTest {
  name?: unknown;
  status?: unknown;
  duration?: unknown;
  start?: unknown;
  /** Spec v1 gives a path from the top-level suite down. Older reporters give one string. */
  suite?: unknown;
  filePath?: unknown;
  message?: unknown;
  trace?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

interface CtrfReport {
  reportFormat?: unknown;
  results?: {
    tool?: { name?: unknown };
    summary?: unknown;
    tests?: unknown;
  };
}

/** A report that passed detection, so its tool name is set and its tests are a list. */
interface ValidCtrfReport {
  toolName: string;
  tests: unknown[];
}

const CTRF_STATUSES = new Set<TestCaseStatus>(["passed", "failed", "skipped", "pending", "other"]);

function toStatus(value: unknown): TestCaseStatus {
  return typeof value === "string" && CTRF_STATUSES.has(value as TestCaseStatus) ? (value as TestCaseStatus) : "other";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function suitePath(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === "string" && part !== "");
  }
  const single = nonEmptyString(value);
  return single === undefined ? [] : [single];
}

function joinCapped(parts: unknown[], maxLength: number): string | undefined {
  const text = parts
    .flat()
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n");
  return text === "" ? undefined : text.slice(0, maxLength);
}

/**
 * All CTRF versions require `results.tool.name` and `results.tests`. Older
 * reporters omit `reportFormat`, so for them the required `results.summary`
 * is the marker.
 */
function parseCtrfReport(content: string): ValidCtrfReport | undefined {
  let parsed: CtrfReport | null;
  try {
    // JSON.parse rejects a byte order mark, and Windows tools often write one.
    parsed = JSON.parse(content.replace(/^\uFEFF/, "")) as CtrfReport | null;
  } catch {
    return undefined;
  }

  const results = parsed?.results;
  const toolName = nonEmptyString(results?.tool?.name);
  const tests = results?.tests;
  const hasMarker =
    parsed?.reportFormat === "CTRF" || (typeof results?.summary === "object" && results.summary !== null);
  return toolName !== undefined && Array.isArray(tests) && hasMarker ? { toolName, tests } : undefined;
}

function toTestCase(test: CtrfTest, toolName: string, maxMessageLength: number): Omit<TestCase, "leaf"> | undefined {
  const name = nonEmptyString(test.name);
  if (name === undefined) {
    return undefined;
  }

  const path = suitePath(test.suite);
  const suite = nonEmptyString(test.filePath) ?? path[0] ?? toolName;
  const status = toStatus(test.status);
  const timeSeconds = typeof test.duration === "number" && test.duration > 0 ? test.duration / 1000 : 0;
  const message = joinCapped([test.message, test.trace], maxMessageLength);
  const output = joinCapped([test.stdout, test.stderr], MAX_OUTPUT_LENGTH);
  const startedAt = typeof test.start === "number" && test.start > 0 ? test.start : undefined;

  return {
    name,
    classname: path.length > 0 ? path.join(" > ") : suite,
    suite,
    timeSeconds,
    status,
    ...(message !== undefined ? { message } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    collateral: isCollateral(status, timeSeconds, message !== undefined),
  };
}

function isCtrfReport(content: string): boolean {
  return parseCtrfReport(content) !== undefined;
}

/** Returns undefined when the content is not CTRF. A CTRF report without tests gives an empty list. */
function parseCtrfTestCases(content: string, options: ParseOptions = {}): TestCase[] | undefined {
  const report = parseCtrfReport(content);
  if (!report) {
    return undefined;
  }

  const maxMessageLength = options.maxMessageLength ?? MAX_MESSAGE_LENGTH;
  const cases = report.tests
    .filter((test): test is CtrfTest => typeof test === "object" && test !== null)
    .map((test) => toTestCase(test, report.toolName, maxMessageLength))
    .filter((testCase) => testCase !== undefined);

  return markLeaves(cases);
}

export { isCtrfReport, parseCtrfTestCases };
