import { describe, expect, it, jest } from "@jest/globals";

const info = jest.fn<(message: string | number) => void>();
const warning = jest.fn<(message: string | Error) => void>();
const parse = jest.fn(() => ({ testsuites: { testsuite: [{}] } }));

jest.unstable_mockModule("@actions/core", () => ({ info, warning }));
jest.unstable_mockModule("fast-xml-parser", () => ({
  XMLParser: jest.fn(() => ({ parse })),
}));

const { parseJUnitXml } = await import("./test-results.js");

describe("parseJUnitXml branch coverage", () => {
  it("returns undefined when nested suites produce an empty aggregate", () => {
    expect(parseJUnitXml("<testsuites><testsuite /></testsuites>")).toBeUndefined();
    expect(parse).toHaveBeenCalledWith("<testsuites><testsuite /></testsuites>");
  });
});
