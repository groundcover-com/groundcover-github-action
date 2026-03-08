import { describe, expect, it, jest } from "@jest/globals";

const info = jest.fn<(message: string | number) => void>();
const warning = jest.fn<(message: string | Error) => void>();

const fg = jest.fn(() => Promise.resolve(["/tmp/results.xml"]));
const readFile = jest.fn(() => Promise.reject(new Error("read failed")));

jest.unstable_mockModule("@actions/core", () => ({ info, warning }));
jest.unstable_mockModule("fast-glob", () => ({ default: fg }));
jest.unstable_mockModule("node:fs/promises", () => ({ readFile }));

const { findTestResultsSummary } = await import("./test-results.js");

describe("findTestResultsSummary branch coverage", () => {
  it("warns when reading a matched file fails", async () => {
    const summary = await findTestResultsSummary("reports/*.xml");

    expect(summary).toBeUndefined();
    expect(warning).toHaveBeenCalledWith("Failed to parse test result file /tmp/results.xml: read failed");
  });

  it("stringifies non-Error parse failures", async () => {
    readFile.mockRejectedValueOnce(null);

    const summary = await findTestResultsSummary("reports/*.xml");

    expect(summary).toBeUndefined();
    expect(warning).toHaveBeenCalledWith("Failed to parse test result file /tmp/results.xml: null");
  });
});
