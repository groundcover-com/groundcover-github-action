import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aPackageName, aTestName, unique } from "./__fixtures__/builders";

const info = jest.fn<(message: string | number) => void>();
const warning = jest.fn<(message: string | Error) => void>();
jest.unstable_mockModule("@actions/core", () => ({ info, warning }));

const { findTestResultsSummary, parseJUnitXml, parseJUnitTestCases } = await import("./test-results.js");
type TestCase = NonNullable<ReturnType<typeof parseJUnitTestCases>>[number];

describe("parseJUnitXml", () => {
  afterEach(() => {
    info.mockClear();
    warning.mockClear();
  });

  it("parses a single testsuite summary", () => {
    const summary = parseJUnitXml('<testsuite tests="10" failures="2" skipped="3" errors="1" time="12.5"></testsuite>');

    expect(summary).toEqual({
      suites: 1,
      total: 10,
      passed: 4,
      failed: 2,
      skipped: 3,
      errors: 1,
      duration: 12.5,
    });
  });

  it("parses aggregated testsuites summaries", () => {
    const summary = parseJUnitXml(
      '<testsuites tests="5" failures="1" skipped="1" errors="0" time="4.25"><testsuite tests="2" failures="1" skipped="0" errors="0" time="1.0" /></testsuites>',
    );

    expect(summary).toEqual({
      suites: 1,
      total: 5,
      passed: 3,
      failed: 1,
      skipped: 1,
      errors: 0,
      duration: 4.25,
    });
  });

  it("sums child suites when the root has no aggregate counts", () => {
    const summary = parseJUnitXml(
      '<testsuites><testsuite tests="2" failures="1" skipped="0" errors="0" time="1.0" /><testsuite tests="3" failures="0" skipped="1" errors="1" time="2.5" /></testsuites>',
    );

    expect(summary).toEqual({
      suites: 2,
      total: 5,
      passed: 2,
      failed: 1,
      skipped: 1,
      errors: 1,
      duration: 3.5,
    });
  });

  it("parses a single nested testsuite node", () => {
    const summary = parseJUnitXml(
      '<testsuites><testsuite tests="4" failures="1" skipped="1" errors="0" time="2.0" /></testsuites>',
    );

    expect(summary).toEqual({
      suites: 1,
      total: 4,
      passed: 2,
      failed: 1,
      skipped: 1,
      errors: 0,
      duration: 2,
    });
  });

  it("returns undefined when nested suites have no usable summary", () => {
    expect(parseJUnitXml("<testsuites><testsuite /></testsuites>")).toBeUndefined();
  });

  it("returns undefined for unsupported XML", () => {
    expect(parseJUnitXml("<root><value>1</value></root>")).toBeUndefined();
  });
});

describe("parseJUnitTestCases", () => {
  const suite = aPackageName();
  const pkg = aPackageName();
  const parentTest = aTestName();
  const midTest = `${parentTest}/TestAll`;
  const leafTest = `${midTest}/${aTestName()}`;
  const abortedTest = `${midTest}/${aTestName()}`;
  const passingTest = aTestName();
  const skippedTest = aTestName();
  const leafFailureMessage = `not equal ${unique()}`;

  const junitWithSubtests = `<testsuites>
    <testsuite name="${suite}" tests="6" failures="4" errors="0" time="12.5">
      <testcase classname="${pkg}" name="${parentTest}" time="10.1"><failure message="Failed">parent output</failure></testcase>
      <testcase classname="${pkg}" name="${midTest}" time="10.0"><failure message="Failed"></failure></testcase>
      <testcase classname="${pkg}" name="${leafTest}" time="3.2"><failure message="${leafFailureMessage}">diff body</failure></testcase>
      <testcase classname="${pkg}" name="${abortedTest}" time="0"><failure message="aborted"></failure></testcase>
      <testcase classname="${pkg}" name="${passingTest}" time="0.5"></testcase>
      <testcase classname="${pkg}" name="${skippedTest}" time="0"><skipped/></testcase>
    </testsuite>
  </testsuites>`;

  function casesByName(xml: string): Map<string, TestCase> {
    return new Map((parseJUnitTestCases(xml) ?? []).map((testCase) => [testCase.name, testCase]));
  }

  it("extracts every testcase with status and duration", () => {
    const cases = parseJUnitTestCases(junitWithSubtests);

    expect(cases).toHaveLength(6);
    const byName = casesByName(junitWithSubtests);
    expect(byName.get(passingTest)).toMatchObject({
      classname: pkg,
      suite,
      status: "passed",
      timeSeconds: 0.5,
    });
    expect(byName.get(skippedTest)?.status).toBe("skipped");
    expect(byName.get(leafTest)?.status).toBe("failed");
  });

  it("marks subtest ancestors as non-leaf and leaves as leaf", () => {
    const byName = casesByName(junitWithSubtests);

    expect(byName.get(parentTest)?.leaf).toBe(false);
    expect(byName.get(midTest)?.leaf).toBe(false);
    expect(byName.get(leafTest)?.leaf).toBe(true);
    expect(byName.get(passingTest)?.leaf).toBe(true);
  });

  it("flags zero-duration bodyless failures as collateral, but not zero-duration skips or passes", () => {
    const byName = casesByName(junitWithSubtests);

    expect(byName.get(abortedTest)?.collateral).toBe(true);
    expect(byName.get(leafTest)?.collateral).toBe(false);
    expect(byName.get(skippedTest)?.collateral).toBe(false);
  });

  it("does not flag a zero-duration failure that produced output — it demonstrably ran", () => {
    const name = aTestName();
    const xml = `<testsuite name="${aPackageName()}"><testcase classname="${aPackageName()}" name="${name}" time="0"><failure message="Failed">an assertion diff</failure></testcase></testsuite>`;

    const testCase = casesByName(xml).get(name);

    expect(testCase?.status).toBe("failed");
    expect(testCase?.collateral).toBe(false);
  });

  it("combines the failure message attribute and body, capped", () => {
    const name = aTestName();
    const message = `boom ${unique()}`;
    const longBody = "x".repeat(10_000);
    const xml = `<testsuite name="${aPackageName()}"><testcase classname="${aPackageName()}" name="${name}" time="1"><failure message="${message}">${longBody}</failure></testcase></testsuite>`;

    const testCase = casesByName(xml).get(name);

    expect(testCase?.message).toContain(message);
    expect(testCase?.message?.length).toBeLessThanOrEqual(4096);
  });

  it("captures per-test system-out as output, capped", () => {
    const name = aTestName();
    const longOut = "y".repeat(40_000);
    const xml = `<testsuite name="${aPackageName()}"><testcase classname="${aPackageName()}" name="${name}" time="1"><failure message="boom">body</failure><system-out>${longOut}</system-out></testcase></testsuite>`;

    const testCase = casesByName(xml).get(name);

    expect(testCase?.output).toContain("yyy");
    expect(testCase?.output?.length).toBeLessThanOrEqual(16_384);
  });

  it("leaves output unset when there is no system-out", () => {
    const name = aTestName();
    const xml = `<testsuite name="${aPackageName()}"><testcase classname="${aPackageName()}" name="${name}" time="1"/></testsuite>`;

    expect(casesByName(xml).get(name)?.output).toBeUndefined();
  });

  it("classifies error elements as errors", () => {
    const name = aTestName();
    const xml = `<testsuite name="${aPackageName()}"><testcase classname="${aPackageName()}" name="${name}" time="1"><error message="panic"/></testcase></testsuite>`;

    expect(casesByName(xml).get(name)?.status).toBe("error");
  });

  it("handles a single testcase object and nested testsuites", () => {
    const name = aTestName();
    const innerSuite = aPackageName();
    const xml = `<testsuites><testsuite name="${aPackageName()}"><testsuite name="${innerSuite}"><testcase classname="${aPackageName()}" name="${name}" time="0.1"/></testsuite></testsuite></testsuites>`;

    const cases = parseJUnitTestCases(xml);

    expect(cases).toHaveLength(1);
    expect(cases?.[0]).toMatchObject({ name, suite: innerSuite, leaf: true });
  });

  it("returns undefined for XML without testcases", () => {
    expect(parseJUnitTestCases("<root><value>1</value></root>")).toBeUndefined();
    expect(parseJUnitTestCases('<testsuite tests="2" failures="0" time="1.0"></testsuite>')).toBeUndefined();
  });
});

describe("findTestResultsSummary", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    info.mockClear();
    warning.mockClear();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("aggregates multiple junit files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gc-test-results-"));
    await writeFile(
      join(tempDir, "junit-1.xml"),
      '<testsuite tests="3" failures="1" skipped="0" errors="0" time="1.5"></testsuite>',
    );
    await writeFile(
      join(tempDir, "junit-2.xml"),
      '<testsuite tests="2" failures="0" skipped="1" errors="0" time="2.5"></testsuite>',
    );

    const summary = await findTestResultsSummary(join(tempDir, "*.xml"));

    expect(summary).toEqual({
      suites: 2,
      total: 5,
      passed: 3,
      failed: 1,
      skipped: 1,
      errors: 0,
      duration: 4,
    });
    expect(info).toHaveBeenCalledWith("Parsed 2 test result file(s)");
  });

  it("logs when no files match", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gc-test-results-"));

    const summary = await findTestResultsSummary(join(tempDir, "*.xml"));

    expect(summary).toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("No test result files matched patterns"));
  });

  it("returns undefined when input is empty", async () => {
    const summary = await findTestResultsSummary("");

    expect(summary).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("warns and skips malformed files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gc-test-results-"));
    await writeFile(join(tempDir, "bad.xml"), '<testsuite tests="nope"></testsuite>');

    const summary = await findTestResultsSummary(join(tempDir, "*.xml"));

    expect(summary).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Skipping unsupported test result file"));
  });
});
