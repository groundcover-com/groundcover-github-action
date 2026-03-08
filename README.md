# groundcover OTEL CI/CD Export Action

Export GitHub Actions workflow runs as OpenTelemetry traces to any OTLP-compatible backend.

## Prerequisites

- GitHub Actions workflow with `actions: read` permission
- Node 20 runtime (handled automatically by GitHub Actions)
- OTLP endpoint and credentials (`otlpEndpoint`, `otlpHeaders`)
- For groundcover, use your managed OTLP endpoint and a `Third Party` ingestion key

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
    steps:
      - uses: groundcover-com/groundcover-github-action@v1
        with:
          otlpEndpoint: ${{ secrets.GROUNDCOVER_OTLP_ENDPOINT }}
          otlpHeaders: "apikey=${{ secrets.GROUNDCOVER_INGESTION_KEY }}"
```

For groundcover setup details, see:

- [Sending from an OpenTelemetry Collector](https://docs.groundcover.com/integrations/data-sources/opentelemetry/sending-from-an-opentelemetry-collector)
- [Create a Third Party ingestion key](https://docs.groundcover.com/use-groundcover/remote-access-and-apis/ingestion-keys)
- [More docs](https://docs.groundcover.com)

## For AI Assistants

If you're using Claude, Cursor, GitHub Copilot, or another coding assistant to add this action to a workflow, start with this minimal setup:

```yaml
- uses: groundcover-com/groundcover-github-action@v1
  with:
    otlpEndpoint: ${{ secrets.GROUNDCOVER_OTLP_ENDPOINT }}
    otlpHeaders: "apikey=${{ secrets.GROUNDCOVER_INGESTION_KEY }}"
```

Required permissions:

```yaml
permissions:
  actions: read
```

Important rules for AI-generated integrations:

- Treat `action.yml` as the canonical input/output contract.
- For groundcover OTLP ingest, use a workspace-specific endpoint and a `Third Party` ingestion key.
- Do not use `Authorization: Bearer ...` for OTLP ingestion. That is for groundcover REST API usage, not this action.
- Preserve `traceparent` when linking CI/CD and application traces.
- Keep `source=github-actions`, configurable `workload`, and optional `env` resource attributes.
- If you change this repository, run `npm run all` and rebuild `dist/` before committing.

## Features

- Exports workflow runs, jobs, and steps as a nested OTEL span hierarchy
- Links CI/CD traces to application traces via W3C `traceparent`
- Supports OTLP/HTTP and OTLP/gRPC transports
- Follows the [OTEL CI/CD semantic conventions](https://opentelemetry.io/docs/specs/semconv/cicd/)
- Adds resource attributes for `source`, `workload`, and optional `env`
- Supports additional custom resource attributes for team/region/metadata

## Usage

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
    steps:
      - uses: groundcover-com/groundcover-github-action@v1
        with:
          otlpEndpoint: ${{ secrets.OTLP_ENDPOINT }}
          otlpHeaders: ${{ secrets.OTLP_HEADERS }}
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
    steps:
      - uses: groundcover-com/groundcover-github-action@v1
        with:
          otlpEndpoint: ${{ secrets.OTLP_ENDPOINT }}
          otlpHeaders: ${{ secrets.OTLP_HEADERS }}
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
    steps:
      - uses: groundcover-com/groundcover-github-action@v1
        with:
          otlpEndpoint: ${{ secrets.OTLP_ENDPOINT }}
          otlpHeaders: ${{ secrets.OTLP_HEADERS }}
          traceparent: ${{ needs.build.outputs.traceparent }}
```

### groundcover

```yaml
- uses: groundcover-com/groundcover-github-action@v1
  with:
    otlpEndpoint: ${{ secrets.GROUNDCOVER_OTLP_ENDPOINT }}
    otlpHeaders: "apikey=${{ secrets.GROUNDCOVER_INGESTION_KEY }}"
    otelServiceName: my-service
    env: production
    workload: payments-api
    extraAttributes: "team=platform"
```

The action always adds `source=github-actions` as a resource attribute.

Use your workspace-specific managed OTLP endpoint rather than a hardcoded shared URL. groundcover documents the endpoint format and OpenTelemetry setup here:

- [Sending from an OpenTelemetry Collector](https://docs.groundcover.com/integrations/data-sources/opentelemetry/sending-from-an-opentelemetry-collector)
- [Ingestion keys](https://docs.groundcover.com/use-groundcover/remote-access-and-apis/ingestion-keys)

## Inputs

| Input             | Required | Default               | Description                                                                                                                                                                                                 |
| ----------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `otlpEndpoint`    | Yes      |                       | OTLP endpoint URL. Supports `https://`, `http://`, and `grpc://` schemes. For HTTP endpoints, include the full path (e.g., `/v1/traces`).                                                                   |
| `otlpHeaders`     | Yes      |                       | Comma-separated `key=value` pairs sent as OTLP exporter headers. For groundcover, use `"apikey=${{ secrets.GROUNDCOVER_INGESTION_KEY }}"`.                                                                  |
| `githubToken`     | No       | `${{ github.token }}` | GitHub token with `actions:read` permission. Required for private repos. Use `secrets.GITHUB_TOKEN` or a PAT.                                                                                               |
| `runId`           | No       | Current run           | Workflow Run ID to export. Defaults to the current workflow run. When using `workflow_run`, set this to `${{ github.event.workflow_run.id }}` to export the triggering run.                                 |
| `otelServiceName` | No       | Workflow name         | Overrides the `service.name` OTEL resource attribute. Defaults to the workflow name.                                                                                                                        |
| `traceparent`     | No       |                       | W3C Trace Context `traceparent` value (e.g., `00-<trace_id>-<span_id>-01`). When provided, the workflow root span becomes a child of this trace, enabling correlation between CI/CD and application traces. |
| `env`             | No       |                       | Environment name added to resource attributes (e.g., `production`, `staging`).                                                                                                                              |
| `workload`        | No       | Workflow name         | Workload name added to resource attributes. Use this to group traces by service/workload.                                                                                                                   |
| `extraAttributes` | No       |                       | Extra resource attributes as comma-separated `key=value` pairs. Example: `"team=platform,region=us-east-1"`. Prefer using dedicated `env` and `workload` inputs when applicable.                            |

## Outputs

| Output    | Description                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| `traceId` | The OpenTelemetry Trace ID of the exported trace. Use this to link to the trace in your observability backend. |

## Permissions

**Required:**

```yaml
permissions:
  actions: read
```

**Optional:**

```yaml
permissions:
  actions: read
  contents: read # required for private repositories
  checks: read # enables exporting check annotations
  pull-requests: read # enables exporting PR labels
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
- uses: groundcover-com/groundcover-github-action@v1
  with:
    otlpEndpoint: ${{ secrets.OTLP_ENDPOINT }}
    otlpHeaders: ${{ secrets.OTLP_HEADERS }}
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

Check that your `otlpHeaders` secret contains the correct API key and that the header name matches what your backend expects. Header names are case-sensitive for some backends.

**Jobs or steps are missing from the trace.**

The action reads job and step data from the GitHub API. For private repositories, ensure `contents: read` is included in your permissions. If steps are still missing, the GitHub API may not have finished indexing the run data; adding a short `sleep` before the export step can help.

**The action fails with "Resource not accessible by integration".**

Your token doesn't have `actions: read`. Add it to your workflow's `permissions` block.

**gRPC connections are timing out.**

Ensure your `otlpEndpoint` uses the `grpc://` scheme and that port 443 is reachable from GitHub Actions runners. Some backends require TLS; use `grpcs://` if plain `grpc://` doesn't work.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
