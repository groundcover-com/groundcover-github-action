import { describe, expect, it } from "@jest/globals";
import { aNumber, aTestName, unique } from "./__fixtures__/builders";
import { isCtrfReport, parseCtrfTestCases } from "./ctrf";

function aCtrfReport(tests: unknown[], overrides: object = {}): string {
  return JSON.stringify({
    reportFormat: "CTRF",
    specVersion: "1.0.0",
    results: {
      tool: { name: `tool-${unique()}` },
      summary: { tests: tests.length, passed: 0, failed: 0, skipped: 0, pending: 0, other: 0, start: 0, stop: 0 },
      tests,
      ...overrides,
    },
  });
}

describe("isCtrfReport", () => {
  it("accepts spec v1 and legacy reports", () => {
    expect(isCtrfReport(aCtrfReport([]))).toBe(true);
    expect(isCtrfReport(JSON.stringify({ results: { tool: { name: "jest" }, tests: [] } }))).toBe(true);
  });

  it("rejects other JSON and invalid JSON", () => {
    expect(isCtrfReport('{"name":"package"}')).toBe(false);
    expect(isCtrfReport('{"results":{"tests":{}}}')).toBe(false);
    expect(isCtrfReport("null")).toBe(false);
    expect(isCtrfReport("{not json")).toBe(false);
  });
});

describe("parseCtrfTestCases", () => {
  it("maps every CTRF status, and unknown statuses to other", () => {
    const statuses = ["passed", "failed", "skipped", "pending", "other", "timedOut"];
    const tests = statuses.map((status) => ({ name: `${status}-${aTestName()}`, status, duration: 1 }));

    const cases = parseCtrfTestCases(aCtrfReport(tests));

    expect(cases?.map((testCase) => testCase.status)).toEqual([
      "passed",
      "failed",
      "skipped",
      "pending",
      "other",
      "other",
    ]);
  });

  it("converts the duration from milliseconds to seconds and keeps the start time", () => {
    const start = Date.UTC(2025, 0, 1);
    const [testCase] =
      parseCtrfTestCases(aCtrfReport([{ name: aTestName(), status: "passed", duration: 1500, start }])) ?? [];

    expect(testCase?.timeSeconds).toBe(1.5);
    expect(testCase?.startedAt).toBe(start);
  });

  it("leaves the start time unset when the report has none", () => {
    const [testCase] =
      parseCtrfTestCases(aCtrfReport([{ name: aTestName(), status: "passed", duration: 1, start: 0 }])) ?? [];

    expect(testCase?.startedAt).toBeUndefined();
  });

  it("uses the file path as the suite and the suite path as the classname", () => {
    const filePath = `tests/${unique()}.spec.ts`;
    const [testCase] =
      parseCtrfTestCases(
        aCtrfReport([{ name: aTestName(), status: "passed", duration: 1, filePath, suite: ["outer", "inner"] }]),
      ) ?? [];

    expect(testCase).toMatchObject({ suite: filePath, classname: "outer > inner" });
  });

  it("accepts a legacy string suite", () => {
    const suite = `suite-${unique()}`;
    const report = JSON.stringify({
      results: { tests: [{ name: aTestName(), status: "passed", duration: 1, suite }] },
    });

    const [testCase] = parseCtrfTestCases(report) ?? [];

    expect(testCase).toMatchObject({ suite, classname: suite });
  });

  it("falls back to the tool name when a test has no file path or suite", () => {
    const toolName = `tool-${unique()}`;
    const report = aCtrfReport([{ name: aTestName(), status: "passed", duration: 1 }], { tool: { name: toolName } });

    const [testCase] = parseCtrfTestCases(report) ?? [];

    expect(testCase).toMatchObject({ suite: toolName, classname: toolName });
  });

  it("joins the message and stack trace, capped", () => {
    const message = `expected ${unique()}`;
    const trace = "at test.ts:1\n".repeat(100);
    const report = aCtrfReport([{ name: aTestName(), status: "failed", duration: 1, message, trace }]);

    expect(parseCtrfTestCases(report)?.[0]?.message).toBe(`${message}\n${trace}`);
    expect(parseCtrfTestCases(report, { maxMessageLength: 10 })?.[0]?.message).toBe(message.slice(0, 10));
  });

  it("joins stdout and stderr as output", () => {
    const report = aCtrfReport([
      { name: aTestName(), status: "failed", duration: 1, stdout: ["out 1", "out 2"], stderr: ["err"] },
    ]);

    expect(parseCtrfTestCases(report)?.[0]?.output).toBe("out 1\nout 2\nerr");
  });

  it("flags a zero-duration failure without a message as collateral", () => {
    const report = aCtrfReport([
      { name: aTestName(), status: "failed", duration: 0 },
      { name: aTestName(), status: "failed", duration: 0, message: "boom" },
    ]);

    expect(parseCtrfTestCases(report)?.map((testCase) => testCase.collateral)).toEqual([true, false]);
  });

  it("marks subtest ancestors as non-leaf", () => {
    const parent = aTestName();
    const report = aCtrfReport([
      { name: parent, status: "passed", duration: aNumber() },
      { name: `${parent}/${aTestName()}`, status: "passed", duration: aNumber() },
    ]);

    expect(parseCtrfTestCases(report)?.map((testCase) => testCase.leaf)).toEqual([false, true]);
  });

  it("skips tests without a name, and returns undefined when none remain", () => {
    const report = aCtrfReport([{ status: "passed", duration: 1 }, null, { name: "", status: "passed", duration: 1 }]);

    expect(parseCtrfTestCases(report)).toBeUndefined();
  });

  it("returns undefined for JSON that is not CTRF", () => {
    expect(parseCtrfTestCases('{"name":"package"}')).toBeUndefined();
  });
});
