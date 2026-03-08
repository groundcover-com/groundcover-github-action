import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const info = jest.fn<(message: string | number) => void>();
const warning = jest.fn<(message: string | Error) => void>();
jest.unstable_mockModule("@actions/core", () => ({ info, warning }));

const { findTestResultsSummary, parseJUnitXml } = await import("./test-results.js");

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
