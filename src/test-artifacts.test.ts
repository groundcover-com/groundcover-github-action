import { describe, expect, it, jest } from "@jest/globals";
import { strToU8, zipSync } from "fflate";
import { aJobName, aNumber, aPackageName, aTestName, unique } from "./__fixtures__/builders";

const info = jest.fn<(message: string | number) => void>();
const warning = jest.fn<(message: string | Error) => void>();
jest.unstable_mockModule("@actions/core", () => ({ info, warning }));

const { collectTestCasesFromArtifacts, extractXmlFilesFromZip, matchArtifactToJob, sanitizeArtifactNamePart } =
  await import("./test-artifacts.js");

const PREFIX = "test-reports-";

interface NamedJob {
  id: number;
  name: string;
}

function aJob(overrides: Partial<NamedJob> = {}): NamedJob {
  return { id: aNumber(), name: aJobName(), ...overrides };
}

function artifactNameFor(job: NamedJob): string {
  return `${PREFIX}${sanitizeArtifactNamePart(job.name.split(" / ").pop() ?? job.name)}`;
}

describe("sanitizeArtifactNamePart", () => {
  it("replaces characters GitHub forbids in artifact names with dashes", () => {
    expect(sanitizeArtifactNamePart("unit:tests")).toBe("unit-tests");
    expect(sanitizeArtifactNamePart("E2E Tests (Shard 1/9)")).toBe("E2E-Tests-Shard-1-9");
  });

  it("keeps already-safe names intact", () => {
    expect(sanitizeArtifactNamePart("unit_tests-fast.suite")).toBe("unit_tests-fast.suite");
  });
});

describe("matchArtifactToJob", () => {
  it("matches an artifact to the job whose display-name tail sanitizes to the artifact suffix", () => {
    const reusableWorkflowJob = aJob({ name: `parent / ${aJobName()}:suite` });
    const jobs = [reusableWorkflowJob, aJob()];

    expect(matchArtifactToJob(artifactNameFor(reusableWorkflowJob), PREFIX, jobs)).toBe(reusableWorkflowJob);
  });

  it("matches jobs without a reusable-workflow prefix", () => {
    const plainJob = aJob();
    const jobs = [aJob({ name: `parent / ${aJobName()}` }), plainJob];

    expect(matchArtifactToJob(artifactNameFor(plainJob), PREFIX, jobs)).toBe(plainJob);
  });

  it("returns undefined when no job matches", () => {
    expect(matchArtifactToJob(`${PREFIX}${aJobName()}`, PREFIX, [aJob()])).toBeUndefined();
  });

  it("returns undefined for artifacts that do not carry the prefix", () => {
    const job = aJob();

    expect(matchArtifactToJob(`coverage-${unique()}`, PREFIX, [job])).toBeUndefined();
  });
});

describe("extractXmlFilesFromZip", () => {
  it("returns the contents of xml files, including nested ones, and skips other files", () => {
    const suiteName = aPackageName();
    const zip = zipSync({
      "a-junit.xml": strToU8(`<testsuite name='${suiteName}'/>`),
      "nested/b-junit.xml": strToU8(`<testsuite name='${aPackageName()}'/>`),
      "notes.txt": strToU8("not xml"),
    });

    const files = extractXmlFilesFromZip(Buffer.from(zip));

    expect(files).toHaveLength(2);
    expect(files.map((file) => file.name).sort()).toEqual(["a-junit.xml", "nested/b-junit.xml"]);
    expect(files[0]?.content).toContain(suiteName);
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

  it("downloads matching artifacts and returns parsed cases keyed by job id", async () => {
    const job = aJob();
    const otherJob = aJob();
    const orphanArtifactName = `${PREFIX}${aJobName()}`;
    const passingTest = aTestName();
    const failingTest = aTestName();
    const failureMessage = `assertion mismatch ${unique()}`;
    const junit = `<testsuite name="${aPackageName()}" tests="2" failures="1" time="4.0">
      <testcase classname="${aPackageName()}" name="${passingTest}" time="1.0"/>
      <testcase classname="${aPackageName()}" name="${failingTest}" time="3.0"><failure message="${failureMessage}"/></testcase>
    </testsuite>`;
    const artifacts = [
      { id: 1, name: artifactNameFor(job), expired: false },
      { id: 2, name: `coverage-${unique()}`, expired: false },
      { id: 3, name: orphanArtifactName, expired: false },
      { id: 4, name: artifactNameFor(otherJob), expired: true },
    ];
    const octokit = stubOctokit(artifacts, {
      1: zipSync({ "reports-junit.xml": strToU8(junit), "notes.txt": strToU8("skip") }),
    });

    const byJobId = await collectTestCasesFromArtifacts(context as never, octokit as never, aNumber(), PREFIX, [
      job,
      otherJob,
    ] as never);

    expect(Object.keys(byJobId)).toEqual([String(job.id)]);
    expect(byJobId[job.id]).toHaveLength(1);
    const cases = byJobId[job.id]?.[0]?.cases;
    expect(cases?.map((testCase) => testCase.name)).toEqual([passingTest, failingTest]);
    expect(cases?.[1]).toMatchObject({ status: "failed", message: failureMessage });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(orphanArtifactName));
    expect(octokit.rest.actions.downloadArtifact).toHaveBeenCalledTimes(1);
  });

  it("warns and skips xml files without test cases", async () => {
    const job = aJob();
    const artifacts = [{ id: 1, name: artifactNameFor(job), expired: false }];
    const octokit = stubOctokit(artifacts, { 1: zipSync({ "empty.xml": strToU8("<root/>") }) });

    const byJobId = await collectTestCasesFromArtifacts(context as never, octokit as never, aNumber(), PREFIX, [
      job,
    ] as never);

    expect(byJobId).toEqual({});
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("empty.xml"));
  });
});
