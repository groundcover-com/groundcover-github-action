/** JUnit gives passed, failed, error, and skipped. CTRF adds pending and other. */
type TestCaseStatus = "passed" | "failed" | "error" | "skipped" | "pending" | "other";

interface TestCase {
  /** For Go this includes the subtest path. */
  name: string;
  /** The suite when the report leaves it empty, as gotestsum does for package-level failures. */
  classname: string;
  suite: string;
  timeSeconds: number;
  status: TestCaseStatus;
  message?: string;
  output?: string;
  /** Start of the test in epoch milliseconds. Only CTRF reports give it. */
  startedAt?: number;
  /** False when another case in the same classname extends this name (a Go subtest ancestor). */
  leaf: boolean;
  /** Set when the framework aborted before the test ran (e.g. Go -failfast), so it never really failed. */
  collateral: boolean;
}

// Go failure bodies put the assertion last, after the test's own log output, so a
// cap that fits most of them keeps the part a reader needs.
const MAX_MESSAGE_LENGTH = 65_536;
const MAX_OUTPUT_LENGTH = 16_384;

/**
 * A zero-duration failure that produced no output means the framework aborted
 * before the test ran (e.g. Go -failfast / suite abort). A zero-duration
 * failure WITH a body demonstrably ran — an instant assertion failure.
 */
function isCollateral(status: TestCaseStatus, timeSeconds: number, hasFailureBody: boolean): boolean {
  return (status === "failed" || status === "error") && timeSeconds === 0 && !hasFailureBody;
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

interface ParseOptions {
  /** Cap on a failure's message, in decoded characters. */
  maxMessageLength?: number | undefined;
}

export { isCollateral, markLeaves, MAX_MESSAGE_LENGTH, MAX_OUTPUT_LENGTH };
export type { ParseOptions, TestCase, TestCaseStatus };
