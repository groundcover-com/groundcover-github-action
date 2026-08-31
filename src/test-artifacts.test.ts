import { describe, expect, it, jest } from "@jest/globals";
import { strToU8, zipSync } from "fflate";

const info = jest.fn<(message: string | number) => void>();
const warning = jest.fn<(message: string | Error) => void>();
jest.unstable_mockModule("@actions/core", () => ({ info, warning }));

const { collectTestCasesFromArtifacts, extractXmlFilesFromZip, matchArtifactToJob, sanitizeArtifactNamePart } =
  await import("./test-artifacts.js");

interface NamedJob {
  name: string;
}

function job(name: string): NamedJob {
  return { name };
}

describe("sanitizeArtifactNamePart", () => {
  it("replaces characters GitHub forbids in artifact names with dashes", () => {
    expect(sanitizeArtifactNamePart("router:test")).toBe("router-test");
    expect(sanitizeArtifactNamePart("E2E Tests (Shard 1/9)")).toBe("E2E-Tests-Shard-1-9");
  });

  it("keeps already-safe names intact", () => {
    expect(sanitizeArtifactNamePart("test_backend-non.api")).toBe("test_backend-non.api");
  });
});

describe("matchArtifactToJob", () => {
  const jobs = [job("test / router:test"), job("test / test:backend-non-api"), job("format-check")];

  it("matches an artifact to the job whose display-name tail sanitizes to the artifact suffix", () => {
    const matched = matchArtifactToJob("test-reports-router-test", "test-reports-", jobs);

    expect(matched).toBe(jobs[0]);
  });

  it("matches jobs without a reusable-workflow prefix", () => {
    const matched = matchArtifactToJob("test-reports-format-check", "test-reports-", jobs);

    expect(matched).toBe(jobs[2]);
  });

  it("returns undefined when no job matches", () => {
    expect(matchArtifactToJob("test-reports-unknown-job", "test-reports-", jobs)).toBeUndefined();
  });

  it("returns undefined for artifacts that do not carry the prefix", () => {
    expect(matchArtifactToJob("coverage-report", "test-reports-", jobs)).toBeUndefined();
  });
});

describe("extractXmlFilesFromZip", () => {
  it("returns the contents of xml files, including nested ones, and skips other files", () => {
    const zip = zipSync({
      "a-junit.xml": strToU8("<testsuite name='a'/>"),
      "nested/b-junit.xml": strToU8("<testsuite name='b'/>"),
      "notes.txt": strToU8("not xml"),
    });

    const files = extractXmlFilesFromZip(Buffer.from(zip));

    expect(files).toHaveLength(2);
    expect(files.map((f) => f.name).sort()).toEqual(["a-junit.xml", "nested/b-junit.xml"]);
    expect(files[0]?.content).toContain("<testsuite");
  });

  it("returns an empty list for a zip without xml files", () => {
    const zip = zipSync({ "notes.txt": strToU8("not xml") });

    expect(extractXmlFilesFromZip(Buffer.from(zip))).toHaveLength(0);
  });
});

describe("collectTestCasesFromArtifacts", () => {
  const context = { repo: { owner: "acme", repo: "repo" } };

  interface StubOctokit {
    paginate: jest.Mock;
    rest: { actions: { listWorkflowRunArtifacts: jest.Mock; downloadArtifact: jest.Mock } };
  }

  function stubOctokit(artifacts: object[], zipsById: Record<number, Uint8Array>): StubOctokit {
    return {
      paginate: jest.fn(() => Promise.resolve(artifacts)),
      rest: {
        actions: {
          listWorkflowRunArtifacts: jest.fn(),
          downloadArtifact: jest.fn((params: unknown) => {
            const { artifact_id } = params as { artifact_id: number };
            const zip = zipsById[artifact_id];
            if (!zip) return Promise.reject(new Error(`no zip for artifact ${artifact_id}`));
            return Promise.resolve({ data: zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) });
          }),
        },
      },
    };
  }

  const routerJUnit = `<testsuite name="router" tests="2" failures="1" time="4.0">
    <testcase classname="metrics/v2" name="TestA" time="1.0"/>
    <testcase classname="metrics/v2" name="TestB" time="3.0"><failure message="boom"/></testcase>
  </testsuite>`;

  it("downloads matching artifacts and returns parsed cases keyed by job id", async () => {
    const jobs = [
      { id: 10, name: "test / router:test" },
      { id: 11, name: "test / test:backend-non-api" },
    ];
    const artifacts = [
      { id: 1, name: "test-reports-router-test", expired: false },
      { id: 2, name: "coverage", expired: false },
      { id: 3, name: "test-reports-orphan-job", expired: false },
      { id: 4, name: "test-reports-test-backend-non-api", expired: true },
    ];
    const zips = { 1: zipSync({ "router-junit.xml": strToU8(routerJUnit), "notes.txt": strToU8("skip") }) };
    const octokit = stubOctokit(artifacts, zips);

    const byJobId = await collectTestCasesFromArtifacts(
      context as never,
      octokit as never,
      20,
      "test-reports-",
      jobs as never,
    );

    expect(Object.keys(byJobId)).toEqual(["10"]);
    expect(byJobId[10]).toHaveLength(2);
    expect(byJobId[10]?.[1]).toMatchObject({ name: "TestB", status: "failed", message: "boom" });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("test-reports-orphan-job"));
    expect(octokit.rest.actions.downloadArtifact).toHaveBeenCalledTimes(1);
  });

  it("warns and skips xml files without test cases", async () => {
    const jobs = [{ id: 10, name: "router:test" }];
    const artifacts = [{ id: 1, name: "test-reports-router-test", expired: false }];
    const zips = { 1: zipSync({ "empty.xml": strToU8("<root/>") }) };
    const octokit = stubOctokit(artifacts, zips);

    const byJobId = await collectTestCasesFromArtifacts(
      context as never,
      octokit as never,
      20,
      "test-reports-",
      jobs as never,
    );

    expect(byJobId).toEqual({});
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("empty.xml"));
  });
});
