# groundcover OTEL CI/CD Export Action

Export GitHub Actions workflow runs as OpenTelemetry traces and logs to groundcover.

## Prerequisites

- GitHub Actions workflow with `actions: read` and `issues: write` permissions
- Node 24 runtime (requires GitHub Actions runner v2.327.1+; self-hosted runners must be updated separately)
- groundcover OTLP endpoint and ingestion key

## Quick Start

```yaml
name: Export CI Traces

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

jobs:
  export-traces:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      issues: write
    steps:
      - uses: groundcover-com/groundcover-github-action@v4
        with:
          groundcoverEndpoint: ${{ secrets.GC_ENDPOINT }}
          apiKey: ${{ secrets.GC_API_KEY }}
```

For groundcover setup details, see:

- [Sending from an OpenTelemetry Collector](https://docs.groundcover.com/integrations/data-sources/opentelemetry/sending-from-an-opentelemetry-collector)
- [Create an ingestion key](https://docs.groundcover.com/use-groundcover/remote-access-and-apis/ingestion-keys)
- [More docs](https://docs.groundcover.com)

## Instructions

### For Humans

Use the Quick Start example above, then configure these two secrets in your repository or organization:

- `GC_ENDPOINT`
- `GC_API_KEY`

Minimal groundcover setup:

```yaml
- uses: groundcover-com/groundcover-github-action@v4
  with:
    groundcoverEndpoint: ${{ secrets.GC_ENDPOINT }}
    apiKey: ${{ secrets.GC_API_KEY }}
```

Required permissions:

```yaml
permissions:
  actions: read
  issues: write
```

### For LLM Agents

If you are using Claude, Cursor, GitHub Copilot, or another coding agent, start with the repo-local instructions in [`llms.txt`](./llms.txt).

Use these rules when generating workflows or modifying this repository:

- Treat `action.yml` as the canonical input/output contract.
- Use `apiKey` with your groundcover ingestion key and a workspace-specific `groundcoverEndpoint`.
- Preserve `traceparent` when linking CI/CD and application traces.
- Keep `source=github-actions`, configurable `workload`, and optional `env` resource attributes.
- If you change this repository, run `npm run all` and rebuild `dist/` before committing.

## Features

- Exports workflow runs, jobs, and steps as a nested OTEL span hierarchy
- Links CI/CD traces to application traces via W3C `traceparent`
- Supports OTLP/HTTP and OTLP/gRPC transports
- Follows the [OTEL CI/CD semantic conventions](https://opentelemetry.io/docs/specs/semconv/cicd/)
- Adds resource attributes for `source`, `workload`, and optional `env`
- Exports GitHub Actions job logs as OpenTelemetry log records correlated with job and step spans (enabled by default)
- Can parse JUnit XML test results and attach a summary to the workflow root span
- Can download JUnit XML report artifacts and export every test case as a span under its job span
- Supports additional custom resource attributes for team/region/metadata
- Upserts a single PR comment with trace details and a link to groundcover traces

## Usage

Opening or updating a pull request triggers CI, and the `Self Test` workflow exports the completed CI run.

### Basic - Separate Workflow (Recommended)

Using `workflow_run` is the recommended approach. It runs after your CI completes, so it doesn't add latency to your pipeline and always captures the full run including the final job status.

```yaml
name: Export CI Traces

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

jobs:
  export-traces:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      issues: write
    steps:
      - uses: groundcover-com/groundcover-github-action@v4
        with:
          groundcoverEndpoint: ${{ secrets.GC_ENDPOINT }}
          apiKey: ${{ secrets.GC_API_KEY }}
          runId: ${{ github.event.workflow_run.id }}
```

### Basic - Same Workflow

You can also add the export step directly to your existing workflow. Use `if: always()` so it runs even when earlier jobs fail.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test

  export-traces:
    runs-on: ubuntu-latest
    needs: [build]
    if: always()
    permissions:
      actions: read
      issues: write
    steps:
      - uses: groundcover-com/groundcover-github-action@v4
        with:
          groundcoverEndpoint: ${{ secrets.GC_ENDPOINT }}
          apiKey: ${{ secrets.GC_API_KEY }}
```

### Link CI/CD + Application Traces

This pattern connects your CI/CD traces to the application traces produced by your deployment. The action uses a `traceparent` created during the build or deploy flow, passes it into your application, and forwards it to the export action. This creates a single trace spanning both CI and production.

This works best in the same workflow, but it can also work with a separate export workflow if the original workflow persists the `traceparent` somewhere the export workflow can read it back from, such as an artifact or deployment metadata.

```yaml
name: CI + Deploy

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      traceparent: ${{ steps.traceparent.outputs.traceparent }}
    steps:
      - uses: actions/checkout@v4

      # Generate a traceparent to link CI and app traces
      - name: Generate traceparent
        id: traceparent
        run: |
          TRACE_ID=$(openssl rand -hex 16)
          SPAN_ID=$(openssl rand -hex 8)
          echo "traceparent=00-${TRACE_ID}-${SPAN_ID}-01" >> "$GITHUB_OUTPUT"

      - run: npm ci
      - run: npm test

      - name: Deploy
        env:
          TRACEPARENT: ${{ steps.traceparent.outputs.traceparent }}
        run: ./deploy.sh # your app picks up TRACEPARENT from the environment

  export-traces:
    runs-on: ubuntu-latest
    needs: [build]
    if: always()
    permissions:
      actions: read
      issues: write
    steps:
      - uses: groundcover-com/groundcover-github-action@v4
        with:
          groundcoverEndpoint: ${{ secrets.GC_ENDPOINT }}
          apiKey: ${{ secrets.GC_API_KEY }}
          traceparent: ${{ needs.build.outputs.traceparent }}
```

### groundcover

```yaml
- uses: groundcover-com/groundcover-github-action@v4
  with:
    groundcoverEndpoint: ${{ secrets.GC_ENDPOINT }}
    apiKey: ${{ secrets.GC_API_KEY }}
    otelServiceName: my-service
    env: production
    workload: payments-api
    testResultsGlob: "reports/junit/**/*.xml"
    extraAttributes: "team=platform"
```

The action always adds `source=github-actions` as a resource attribute.

Use your workspace-specific managed OTLP endpoint rather than a hardcoded shared URL. groundcover documents the endpoint format and OpenTelemetry setup here:

- [Sending from an OpenTelemetry Collector](https://docs.groundcover.com/integrations/data-sources/opentelemetry/sending-from-an-opentelemetry-collector)
- [Ingestion keys](https://docs.groundcover.com/use-groundcover/remote-access-and-apis/ingestion-keys)

## Inputs

| Input                   | Required | Default                       | Description                                                                                                                                                                                                 |
| ----------------------- | -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groundcoverEndpoint`   | Yes      |                               | OTLP endpoint base URL. Supports `https://`, `http://`, and `grpc://` schemes. Do not include `/v1/traces` — the exporter appends it automatically.                                                         |
| `apiKey`                | Yes      |                               | groundcover ingestion key.                                                                                                                                                                                  |
| `otlpHeaders`           | No       |                               | Comma-separated `key=value` pairs sent as OTLP exporter headers. Advanced — takes precedence over `apiKey` when both are set.                                                                               |
| `githubToken`           | No       | `${{ github.token }}`         | GitHub token with `actions:read` permission. Required for private repos. Use `secrets.GITHUB_TOKEN` or a PAT.                                                                                               |
| `runId`                 | No       | Current run                   | Workflow Run ID to export. Defaults to the current workflow run. When using `workflow_run`, set this to `${{ github.event.workflow_run.id }}` to export the triggering run.                                 |
| `otelServiceName`       | No       | Workflow name                 | Overrides the `service.name` OTEL resource attribute. Defaults to the workflow name.                                                                                                                        |
| `traceparent`           | No       |                               | W3C Trace Context `traceparent` value (e.g., `00-<trace_id>-<span_id>-01`). When provided, the workflow root span becomes a child of this trace, enabling correlation between CI/CD and application traces. |
| `env`                   | No       |                               | Environment name added to resource attributes (e.g., `production`, `staging`).                                                                                                                              |
| `workload`              | No       | Workflow name                 | Workload name added to resource attributes. Use this to group traces by service/workload.                                                                                                                   |
| `testResultsGlob`       | No       |                               | Comma-separated glob patterns for JUnit XML test result files. Matching files are parsed and summarized onto the workflow root span.                                                                        |
| `testResultsArtifactPrefix` | No   |                               | Prefix of workflow-run artifacts holding JUnit XML reports (e.g. `test-reports-`). Matching artifacts are downloaded and every test case becomes a span under its job span. See [Per-test spans](#per-test-spans-from-report-artifacts). |
| `exportLogs`            | No       | `true`                        | Export GitHub Actions job logs as OpenTelemetry log records correlated with job and step spans. Set to `false` to disable.                                                                                  |
| `extraAttributes`       | No       |                               | Extra resource attributes as comma-separated `key=value` pairs. Example: `"team=platform,region=us-east-1"`. Prefer using dedicated `env` and `workload` inputs when applicable.                            |
| `groundcoverBaseUrl`    | No       | `https://app.groundcover.com` | Base URL used for the PR comment link to the groundcover Traces page. Use your workspace URL for self-hosted or custom domains.                                                                             |
| `commentOnPr`           | No       | `true`                        | Upserts a single PR comment with trace details and a Traces link pre-filtered by PR number. Requires `issues: write` permission. Set to `false` to disable.                                                 |
| `groundcoverDuration`   | No       | `Last 6 hours`                | Duration query parameter used in the PR comment traces link.                                                                                                                                                |
| `groundcoverBackendId`  | No       |                               | Optional `backendId` query parameter for the PR comment traces link.                                                                                                                                        |
| `groundcoverTenantUUID` | No       |                               | Optional `tenantUUID` query parameter for the PR comment traces link.                                                                                                                                       |

## Outputs

| Output    | Description                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| `traceId` | The OpenTelemetry Trace ID of the exported trace. Use this to link to the trace in your observability backend. |

## Permissions

**Required:**

```yaml
permissions:
  actions: read
  issues: write # required for PR trace comments (enabled by default)
  pull-requests: write # required for PR trace comments via workflow_run triggers
```

**Optional:**

```yaml
permissions:
  actions: read
  issues: write
  pull-requests: write
  contents: read # required for private repositories
  checks: read # enables exporting check annotations
```

## Private Repositories

For private repositories, the default `GITHUB_TOKEN` may not have sufficient permissions to read workflow run data. You have two options:

**Option 1:** Grant `contents: read` in your workflow permissions block (recommended):

```yaml
permissions:
  actions: read
  contents: read
```

**Option 2:** Use a Personal Access Token with `repo` scope:

```yaml
- uses: groundcover-com/groundcover-github-action@v4
  with:
    groundcoverEndpoint: ${{ secrets.GC_ENDPOINT }}
    apiKey: ${{ secrets.GC_API_KEY }}
    githubToken: ${{ secrets.MY_PAT }}
```

## Trace Structure

Each workflow run is exported as a tree of spans:

```
workflow_run (root span)
  job: build
    step: Checkout
    step: npm ci
    step: npm test
  job: lint
    step: Checkout
    step: Run linter
  job: export-traces
    step: groundcover OTEL CI/CD Export
```

Span attributes follow the [OTEL CI/CD semantic conventions](https://opentelemetry.io/docs/specs/semconv/cicd/), including `cicd.pipeline.name`, `cicd.pipeline.run.id`, `cicd.pipeline.task.name`, `cicd.pipeline.task.run.id`, and `cicd.pipeline.task.run.url.full`.

## Resource Attributes

By default, the action sets:

- `service.name` (workflow name unless overridden via `otelServiceName`)
- `service.namespace` (GitHub `owner/repo`)
- `service.version` (workflow head SHA)
- `service.instance.id` (`owner/repo/workflow_id/run_id/run_attempt`)
- `source=github-actions`
- `workload` (from input, defaults to workflow name)
- `env` (only when input is provided)

For groundcover users, `source`, `workload`, and `env` make it easier to filter and group CI/CD traces consistently with the rest of your telemetry.

## Test Results

If your workflow produces JUnit XML reports, set `testResultsGlob` to one or more comma-separated glob patterns. The action parses matching files and adds these workflow root span attributes:

- `test.suites`
- `test.total`
- `test.passed`
- `test.failed`
- `test.skipped`
- `test.errors`
- `test.duration`

The matching XML files must exist on disk in the job running this action. In a separate `workflow_run` export workflow, download the test result artifacts first if you want them included.

### Per-test spans from report artifacts

To get one span per test case, parented under the job that ran it, upload each test job's JUnit XML as a workflow artifact and set `testResultsArtifactPrefix`. This works with the recommended `workflow_run` setup, where the export job cannot see the test jobs' files on disk.

Upload the reports from every test job:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-reports-${{ github.job }}
          path: reports/*-junit.xml
          overwrite: true
```

Then point the export at them:

```yaml
- uses: groundcover-com/groundcover-github-action@v4
  with:
    groundcoverEndpoint: ${{ secrets.GC_ENDPOINT }}
    apiKey: ${{ secrets.GC_API_KEY }}
    runId: ${{ github.event.workflow_run.id }}
    testResultsArtifactPrefix: "test-reports-"
```

Artifacts are matched to jobs by name, `<prefix><sanitized job name>`, where the sanitized job name is the job's display name — the part after the last `" / "` for reusable workflows — with every run of characters outside `[A-Za-z0-9_.-]` replaced by `-`. Use `overwrite: true` so a rerun replaces the previous attempt's reports. When a job name contains such characters, or the job is a matrix job, build the artifact name from the same sanitization:

```yaml
- id: report-name
  if: always()
  run: echo "name=test-reports-$(echo '${{ matrix.suite }}' | tr -c 'A-Za-z0-9_.-' '-' | sed 's/-*$//')" >> "$GITHUB_OUTPUT"

- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: ${{ steps.report-name.outputs.name }}
    path: reports/*-junit.xml
    overwrite: true
```

Each JUnit file becomes a wrapper span under its job, and each test case in that file becomes a span under the wrapper, so a job that produces several reports keeps them apart:

```
workflow run
  job
    Tests / <suite or file name>     ← rollup for THIS report
      test case
      test case
    Tests / <other suite or file>    ← rollup for THAT report
      test case
```

The wrapper is named after the report's suite, or its file name when a file holds several suites, and carries that file's counts — `test.report`, `test.suites`, `test.total`, `test.passed`, `test.failed`, `test.skipped`, `test.errors`, `test.duration` — the same rollup the workflow root carries for the whole run. It spans the job's own window.

Each test case span carries these attributes:

- `test.name`, `test.classname`, `test.suite`
- `test.status` (`passed` / `failed` / `error` / `skipped`), `test.duration_ms`
- `test.leaf` — false for Go subtest ancestors (another case in the same classname extends this name)
- `test.collateral` — true for zero-duration failures with no output, which the framework aborted before the test ran (e.g. Go `-failfast`)
- `test.failure.message` — the failure message and body, capped at 4 KB
- `github.job.name`, `github.job.id`, `github.run_id`, `github.run_attempt`, `github.head_sha`, `github.head_branch`

Failed and errored cases are marked as error spans. JUnit reports carry durations but no per-test timestamps, so **test spans are anchored at the job start time**; durations are exact and overlaps are expected. When `testResultsGlob` is not set, the root-span summary attributes above are computed from the artifact-parsed cases instead.

Each failed case also ships its failure message and captured `<system-out>` as a log record correlated with the test's span, so opening a red test span shows what the test printed. Passing-test output is not exported. These log records are sent even when `exportLogs` is `false`.

## Log Export

By default, the action downloads GitHub Actions job logs and exports them as OpenTelemetry log records to your OTLP endpoint (`/v1/logs`). Each log record is correlated with the matching job or step span via trace context, so logs appear alongside spans in your observability backend.

The action parses GitHub's log format to extract timestamps and severity levels, then merges all lines within each step into a single log record. The record's timestamp is taken from the first line, and its severity is the highest found across all lines in that step (e.g., if any line is `##[error]`, the merged record is ERROR). Lines that fall outside any step's time window are merged and attached to the parent job span instead.

To disable log export, set `exportLogs: false`:

```yaml
- uses: groundcover-com/groundcover-github-action@v4
  with:
    groundcoverEndpoint: ${{ secrets.GC_ENDPOINT }}
    apiKey: ${{ secrets.GC_API_KEY }}
    exportLogs: false
```

## How Trace Linking Works

When you provide a `traceparent` input, the workflow root span is created as a child of that trace context. This means:

1. Your build job (or deploy logic) generates a `traceparent` (a trace ID + span ID pair).
2. You pass that `traceparent` to your application at deploy time (e.g., as an environment variable).
3. Your application starts its own spans as children of that context.
4. You pass the same `traceparent` to this action.
5. The action creates the CI/CD trace as a child of the same root.

The result is a single trace in your observability backend that spans from the first CI step through to production request handling.

## Troubleshooting

**The action exports the wrong workflow run.**

When using `workflow_run`, the action defaults to the current run (the export workflow itself). Set `runId: ${{ github.event.workflow_run.id }}` to export the triggering workflow instead.

**I'm getting 401 or 403 errors from the OTLP endpoint.**

Check that your `apiKey` secret contains the correct groundcover ingestion key. If using `otlpHeaders` for a custom setup, verify the header name and value match what your backend expects.

**Jobs or steps are missing from the trace.**

The action reads job and step data from the GitHub API. For private repositories, ensure `contents: read` is included in your permissions. If steps are still missing, the GitHub API may not have finished indexing the run data; adding a short `sleep` before the export step can help.

**The action fails with "Resource not accessible by integration".**

Your token doesn't have `actions: read`. Add it to your workflow's `permissions` block.

**gRPC connections are timing out.**

Ensure your `groundcoverEndpoint` uses the `grpc://` scheme and that port 443 is reachable from GitHub Actions runners. Some backends require TLS; use `grpcs://` if plain `grpc://` doesn't work.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
