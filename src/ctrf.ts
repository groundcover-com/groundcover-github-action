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
  results?: {
    tool?: { name?: unknown };
    tests?: unknown;
  };
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

/** Detection uses `results.tests`, because older reporters omit `reportFormat`. */
function parseCtrfReport(content: string): CtrfReport | undefined {
  try {
    // JSON.parse rejects a byte order mark, and Windows tools often write one.
    const parsed = JSON.parse(content.replace(/^\uFEFF/, "")) as CtrfReport | null;
    return Array.isArray(parsed?.results?.tests) ? parsed : undefined;
  } catch {
    return undefined;
  }
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

function parseCtrfTestCases(content: string, options: ParseOptions = {}): TestCase[] | undefined {
  const report = parseCtrfReport(content);
  if (!report) {
    return undefined;
  }

  const toolName = nonEmptyString(report.results?.tool?.name) ?? "";
  const maxMessageLength = options.maxMessageLength ?? MAX_MESSAGE_LENGTH;
  const cases = (report.results?.tests as unknown[])
    .filter((test): test is CtrfTest => typeof test === "object" && test !== null)
    .map((test) => toTestCase(test, toolName, maxMessageLength))
    .filter((testCase) => testCase !== undefined);

  return cases.length > 0 ? markLeaves(cases) : undefined;
}

export { isCtrfReport, parseCtrfTestCases };
