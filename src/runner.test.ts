import { jest, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "@jest/globals";
import { RequestError } from "@octokit/request-error";
import { trace } from "@opentelemetry/api";
import * as core from "./__fixtures__/core.js";
import * as github from "./__fixtures__/github.js";
import { replayOctokit } from "./replay.js";

jest.unstable_mockModule("@actions/core", () => core);
jest.unstable_mockModule("@actions/github", () => github);
jest.unstable_mockModule("../package.json", () => ({ version: "0.0.0-test" }));

process.env["OTEL_CONSOLE_ONLY"] = "true";
process.env["OTEL_ID_SEED"] = "123";
process.env["GITHUB_REPOSITORY"] = "biomejs/biome";

const { run, isOctokitError } = await import("./runner.js");

describe("isOctokitError", () => {
  it("returns true for objects with a status property", () => {
    const err = new RequestError("Not Found", 404, {
      response: { headers: {}, status: 404, url: "", data: {} },
      request: { method: "GET", url: "/test", headers: {} },
    });
    expect(isOctokitError(err)).toBe(true);
  });

  it("returns false for plain Error objects", () => {
    expect(isOctokitError(new Error("oops"))).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isOctokitError(null)).toBe(false);
    expect(isOctokitError(undefined)).toBe(false);
  });
});

describe("run", () => {
  let octokit: Awaited<ReturnType<typeof replayOctokit>>;
  const originalConsoleDir = console.dir;

  beforeAll(async () => {
    octokit = await replayOctokit("run", "");
    console.dir = jest.fn() as typeof console.dir;
  });

  beforeEach(() => {
    core.getInput.mockReset();
    core.setOutput.mockReset();
    core.setFailed.mockReset();
    core.setSecret.mockReset();
    core.info.mockReset();
    github.getOctokit.mockReturnValue(octokit);
  });

  afterEach(() => {
    trace.disable();
  });

  afterAll(() => {
    console.dir = originalConsoleDir;
    delete process.env["OTEL_CONSOLE_ONLY"];
    delete process.env["OTEL_ID_SEED"];
    delete process.env["GITHUB_REPOSITORY"];
  });

  it("exports a successful workflow run and outputs trace ID", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "runId") return "21487811823";
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      return "";
    });

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("traceId", "329e58aa53cec7a2beadd2fd0a85c388");
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setSecret).toHaveBeenCalledWith("auth=token");
  });

  it("exports a failed workflow run without calling setFailed", async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === "runId") return "21458831126";
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      return "";
    });

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("traceId", "329e58aa53cec7a2beadd2fd0a85c388");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("exports a cancelled workflow run", async () => {
    process.env["GITHUB_REPOSITORY"] = "step-security/skip-duplicate-actions";

    core.getInput.mockImplementation((name: string) => {
      if (name === "runId") return "16620109074";
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      return "";
    });

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("traceId", "329e58aa53cec7a2beadd2fd0a85c388");
    expect(core.setFailed).not.toHaveBeenCalled();

    process.env["GITHUB_REPOSITORY"] = "biomejs/biome";
  });

  it("calls setFailed for non-existent run ID", async () => {
    process.env["GITHUB_REPOSITORY"] = "corentinmusard/otel-cicd-action";

    core.getInput.mockImplementation((name: string) => {
      if (name === "runId") return "111";
      if (name === "groundcoverEndpoint") return "https://localhost";
      if (name === "otlpHeaders") return "auth=token";
      return "";
    });

    await run();

    expect(core.setFailed).toHaveBeenCalled();

    process.env["GITHUB_REPOSITORY"] = "biomejs/biome";
  });
});
