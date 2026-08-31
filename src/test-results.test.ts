import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const info = jest.fn<(message: string | number) => void>();
const warning = jest.fn<(message: string | Error) => void>();
jest.unstable_mockModule("@actions/core", () => ({ info, warning }));

const { findTestResultsSummary, parseJUnitXml, parseJUnitTestCases } = await import("./test-results.js");

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
  const goJUnit = `<testsuites>
    <testsuite name="groundcover.com/internal/services/router/api/metrics/v2" tests="6" failures="4" errors="0" time="12.5">
      <testcase classname="metrics/v2" name="TestMetricsV2TestSuite" time="10.1"><failure message="Failed">=== FAIL output</failure></testcase>
      <testcase classname="metrics/v2" name="TestMetricsV2TestSuite/TestAll" time="10.0"><failure message="Failed"></failure></testcase>
      <testcase classname="metrics/v2" name="TestMetricsV2TestSuite/TestAll/wildcard_-_all_metrics" time="3.2"><failure message="Not equal: expected 5 got 4">diff body</failure></testcase>
      <testcase classname="metrics/v2" name="TestMetricsV2TestSuite/TestAll/wildcard_-_with_limit" time="0"><failure message="aborted"></failure></testcase>
      <testcase classname="metrics/v2" name="TestOther" time="0.5"></testcase>
      <testcase classname="metrics/v2" name="TestSkipped" time="0"><skipped/></testcase>
    </testsuite>
  </testsuites>`;

  it("extracts every testcase with status and duration", () => {
    const cases = parseJUnitTestCases(goJUnit);

    expect(cases).toHaveLength(6);
    const byName = new Map(cases?.map((c) => [c.name, c]));
    expect(byName.get("TestOther")).toMatchObject({
      classname: "metrics/v2",
      suite: "groundcover.com/internal/services/router/api/metrics/v2",
      status: "passed",
      timeSeconds: 0.5,
    });
    expect(byName.get("TestSkipped")?.status).toBe("skipped");
    expect(byName.get("TestMetricsV2TestSuite/TestAll/wildcard_-_all_metrics")?.status).toBe("failed");
  });

  it("marks Go subtest ancestors as non-leaf and leaves as leaf", () => {
    const cases = parseJUnitTestCases(goJUnit);
    const byName = new Map(cases?.map((c) => [c.name, c]));

    expect(byName.get("TestMetricsV2TestSuite")?.leaf).toBe(false);
    expect(byName.get("TestMetricsV2TestSuite/TestAll")?.leaf).toBe(false);
    expect(byName.get("TestMetricsV2TestSuite/TestAll/wildcard_-_all_metrics")?.leaf).toBe(true);
    expect(byName.get("TestOther")?.leaf).toBe(true);
  });

  it("flags zero-duration failures as collateral, but not zero-duration skips or passes", () => {
    const cases = parseJUnitTestCases(goJUnit);
    const byName = new Map(cases?.map((c) => [c.name, c]));

    expect(byName.get("TestMetricsV2TestSuite/TestAll/wildcard_-_with_limit")?.collateral).toBe(true);
    expect(byName.get("TestMetricsV2TestSuite/TestAll/wildcard_-_all_metrics")?.collateral).toBe(false);
    expect(byName.get("TestSkipped")?.collateral).toBe(false);
  });

  it("combines the failure message attribute and body, capped", () => {
    const longBody = "x".repeat(10_000);
    const xml = `<testsuite name="s"><testcase classname="c" name="TestX" time="1"><failure message="boom">${longBody}</failure></testcase></testsuite>`;

    const cases = parseJUnitTestCases(xml);

    expect(cases?.[0]?.message).toContain("boom");
    expect(cases?.[0]?.message?.length).toBeLessThanOrEqual(4096);
  });

  it("captures per-test system-out as output, capped", () => {
    const longOut = "y".repeat(40_000);
    const xml = `<testsuite name="s"><testcase classname="c" name="TestX" time="1"><failure message="boom">body</failure><system-out>${longOut}</system-out></testcase></testsuite>`;

    const cases = parseJUnitTestCases(xml);

    expect(cases?.[0]?.output).toContain("yyy");
    expect(cases?.[0]?.output?.length).toBeLessThanOrEqual(16_384);
  });

  it("leaves output unset when there is no system-out", () => {
    const xml = `<testsuite name="s"><testcase classname="c" name="TestX" time="1"/></testsuite>`;

    expect(parseJUnitTestCases(xml)?.[0]?.output).toBeUndefined();
  });

  it("classifies error elements as errors", () => {
    const xml = `<testsuite name="s"><testcase classname="c" name="TestX" time="1"><error message="panic"/></testcase></testsuite>`;

    expect(parseJUnitTestCases(xml)?.[0]?.status).toBe("error");
  });

  it("handles a single testcase object and nested testsuites", () => {
    const xml = `<testsuites><testsuite name="outer"><testsuite name="inner"><testcase classname="c" name="TestOnly" time="0.1"/></testsuite></testsuite></testsuites>`;

    const cases = parseJUnitTestCases(xml);

    expect(cases).toHaveLength(1);
    expect(cases?.[0]).toMatchObject({ name: "TestOnly", suite: "inner", leaf: true });
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
