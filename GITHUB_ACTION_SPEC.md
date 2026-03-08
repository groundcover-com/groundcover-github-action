# groundcover GitHub Actions OTEL Exporter — Implementation Specification

## Overview

Build a **new, production-grade GitHub Action** under the `groundcover-com` GitHub organization that exports GitHub Actions CI/CD workflow runs as OpenTelemetry traces to any OTLP-compatible backend.

**This is NOT a fork.** It is a clean-room implementation inspired by [`corentinmusard/otel-cicd-action`](https://github.com/corentinmusard/otel-cicd-action) (MIT license). We are building this because the upstream action has a critical architectural limitation: it hardcodes `root: true` on the workflow span, making it impossible to link CI/CD traces with application traces under a single trace ID.

**Repository**: `groundcover-com/otel-cicd-export-action` (public)
**License**: Apache-2.0
**Runtime**: Node.js 20 (GitHub Actions `node20` runner)
**Language**: TypeScript (strict mode)

---

## Why This Exists — The Core Problem

When a CI/CD workflow runs an application (e.g., `go run .`, `npm test`, `python main.py`), that application may emit its own OTEL traces. Ideally, those application traces should appear as **children** of the CI/CD workflow trace — forming a single unified trace in the observability backend.

The upstream action (`corentinmusard/otel-cicd-action@v2`) makes this impossible because in `src/trace/workflow.ts`:

```typescript
return await tracer.startActiveSpan(
    workflowRun.name ?? workflowRun.display_title,
    { attributes, root: true, startTime },  // ← ALWAYS creates a new root trace
    async (rootSpan) => { ... }
);
```

The `root: true` flag forces a new trace ID regardless of any existing context. There is no input to provide a parent trace context.

**Our action solves this** by accepting an optional `traceparent` input (W3C Trace Context format). When provided, the workflow root span becomes a child of that trace context, enabling end-to-end trace correlation between CI/CD pipelines and the applications they run.

---

## Functional Requirements

### Core Behavior

1. **Fetch workflow run data** from the GitHub API (workflow run, jobs, steps, annotations, PR labels)
2. **Construct an OTEL trace** with the following span hierarchy:
   ```
   Workflow Run (root span or child of traceparent)
   ├── Queued (time between workflow start and first job pickup)
   ├── Job 1
   │   ├── Step 1
   │   ├── Step 2
   │   └── ...
   ├── Job 2
   │   ├── Step 1
   │   └── ...
   └── ...
   ```
3. **Export the trace** to an OTLP-compatible endpoint via HTTP/protobuf or gRPC
4. **Output the trace ID** so downstream steps/workflows can reference it

### Trace Context Propagation (THE KEY DIFFERENTIATOR)

When the `traceparent` input is provided:
- Parse it according to [W3C Trace Context](https://www.w3.org/TR/trace-context/) specification
- The workflow root span MUST be a **child** of the provided trace context (NOT `root: true`)
- The trace ID from the `traceparent` MUST be preserved — the entire trace tree uses this trace ID

When `traceparent` is NOT provided:
- Behave identically to the upstream action: create a new root span with a random trace ID

This enables the following workflow pattern:
```yaml
- name: Generate trace context
  run: |
    TRACE_ID=$(openssl rand -hex 16)
    SPAN_ID=$(openssl rand -hex 8)
    echo "TRACEPARENT=00-${TRACE_ID}-${SPAN_ID}-01" >> "$GITHUB_ENV"

- name: Run application
  run: ./my-app  # App reads TRACEPARENT env var, creates child spans
  env:
    GC_OTLP_ENDPOINT: ${{ secrets.GC_OTLP_ENDPOINT }}

# In otel-export workflow (or same workflow):
- uses: groundcover-com/otel-cicd-export-action@v1
  with:
    otlpEndpoint: ${{ secrets.GC_OTLP_ENDPOINT }}/v1/traces
    otlpHeaders: "apikey=${{ secrets.GC_KEY_HEADER }}"
    traceparent: ${{ env.TRACEPARENT }}
```

Result: Both the CI/CD workflow trace AND the application trace share the same trace ID and appear as a single unified trace.

### Supported Trace Export Protocols

Support BOTH transport protocols based on the endpoint URL scheme:

| URL Scheme | Protocol | OTEL Exporter |
|---|---|---|
| `https://` or `http://` | OTLP/HTTP (protobuf) | `@opentelemetry/exporter-trace-otlp-proto` |
| `grpc://` | OTLP/gRPC | `@opentelemetry/exporter-trace-otlp-grpc` |

### GitHub API Data Fetched

For a given workflow run ID, fetch:

1. **Workflow Run** — metadata, status, conclusion, timestamps, head commit, PR info
2. **Jobs** — all jobs in the run (paginated, `filter: latest`)
3. **Steps** — all steps within each job (included in jobs response)
4. **Annotations** — check run annotations per job (optional, graceful failure)
5. **PR Labels** — labels on associated pull requests (optional, graceful failure)

### Span Attributes — OTEL Semantic Conventions

Follow the [OTEL CI/CD semantic conventions](https://opentelemetry.io/docs/specs/semconv/attributes-registry/cicd/) (development status). Map GitHub-specific data to both semantic convention attributes AND `github.*` custom attributes for full fidelity.

#### Workflow Run Span (Root)

Semantic convention attributes:
- `cicd.pipeline.name` — workflow name
- `cicd.pipeline.run.id` — workflow run ID

GitHub-specific attributes (prefix `github.*`):
- `github.workflow_id`, `github.run_id`, `github.run_number`, `github.run_attempt`
- `github.event`, `github.status`, `github.conclusion`
- `github.head_sha`, `github.head_branch`, `github.display_title`
- `github.html_url`, `github.url`
- `github.created_at`, `github.updated_at`, `github.run_started_at`
- `github.head_commit.id`, `github.head_commit.message`, `github.head_commit.author.name`, `github.head_commit.author.email`, `github.head_commit.timestamp`
- `github.head_ref`, `github.base_ref` (from PRs)
- `github.pull_requests.N.number`, `github.pull_requests.N.labels` (from PRs)
- `github.referenced_workflows.N.path`, `github.referenced_workflows.N.sha` (reusable workflows)
- `error` — boolean, true if conclusion is `failure`

#### Job Span

Semantic convention attributes:
- `cicd.pipeline.task.name` — job name
- `cicd.pipeline.task.run.id` — job ID
- `cicd.pipeline.task.run.url.full` — job HTML URL
- `cicd.pipeline.task.type` — heuristic: `build`, `test`, or `deploy` based on job name

GitHub-specific attributes:
- `github.job.id`, `github.job.name`, `github.job.status`, `github.job.conclusion`
- `github.job.runner_name`, `github.job.runner_id`, `github.job.runner_group_name`
- `github.job.labels`, `github.job.head_sha`, `github.job.run_attempt`
- `github.job.started_at`, `github.job.completed_at`
- `github.job.annotations.N.level`, `github.job.annotations.N.message`
- `error` — boolean

#### Step Span

- `github.job.step.name`, `github.job.step.number`
- `github.job.step.status`, `github.job.step.conclusion`
- `github.job.step.started_at`, `github.job.step.completed_at`
- `error` — boolean

#### Resource Attributes

- `service.name` — from `otelServiceName` input, or workflow name, or workflow ID
- `service.version` — head SHA
- `service.instance.id` — `{repo_full_name}/{workflow_id}/{run_id}/{run_attempt}`
- `service.namespace` — repository full name
- Plus any extra attributes from `extraAttributes` input

### Span Timing

- **Workflow span**: `run_started_at` → `updated_at`
- **Queued span**: `run_started_at` → first job's `started_at`
- **Job span**: `started_at` → `completed_at` (with `max(started, completed)` guard for skipped jobs)
- **Step span**: `started_at` → `completed_at` (with same guard)

### Span Status

- `SpanStatusCode.ERROR` if conclusion is `failure`
- `SpanStatusCode.OK` otherwise

### Edge Cases

- **Incomplete jobs** (no `completed_at`): Skip, log info message
- **Skipped steps** (conclusion `skipped`): Skip, log info message
- **completed_at < started_at** (skipped/post jobs): Use `max(started_at, completed_at)` as end time
- **Missing annotations permission**: Catch `RequestError`, log info, continue without annotations
- **Missing PR labels permission**: Catch `RequestError`, log info, continue without labels
- **Invalid traceparent format**: Log warning, fall back to `root: true` (new trace)

---

## Action Interface

### `action.yml`

```yaml
name: "groundcover OTEL CI/CD Export"
description: "Export GitHub Actions workflow runs as OpenTelemetry traces to any OTLP-compatible endpoint"
author: "groundcover"

inputs:
  otlpEndpoint:
    description: >
      OTLP endpoint URL. Supports https://, http://, and grpc:// schemes.
      For HTTP endpoints, this should be the full URL including /v1/traces path.
    required: true
  otlpHeaders:
    description: >
      Comma-separated key=value pairs for OTLP exporter headers.
      Example: "apikey=YOUR_KEY" or "x-honeycomb-team=KEY,x-honeycomb-dataset=DS"
    required: true
  githubToken:
    description: >
      GitHub token with actions:read permission. Required for private repos.
      Use secrets.GITHUB_TOKEN or a PAT.
    required: false
  runId:
    description: "Workflow Run ID to export. Defaults to the current workflow run."
    required: false
  otelServiceName:
    description: "Override the OTEL service.name resource attribute. Defaults to the workflow name."
    required: false
  traceparent:
    description: >
      W3C Trace Context traceparent header value (e.g., 00-<trace_id>-<span_id>-01).
      When provided, the workflow root span becomes a child of this trace context,
      enabling correlation between CI/CD traces and application traces.
      When omitted, a new root trace is created.
    required: false
  extraAttributes:
    description: >
      Extra resource attributes as comma-separated key=value pairs.
      Example: "env=production,team=platform"
    required: false

outputs:
  traceId:
    description: "The OpenTelemetry Trace ID of the exported trace"

branding:
  icon: "activity"
  color: "green"

runs:
  using: "node20"
  main: "dist/index.js"
```

---

## Project Structure

```
groundcover-com/otel-cicd-export-action/
├── action.yml                    # Action metadata (inputs, outputs, branding)
├── package.json                  # Dependencies, scripts, engine constraints
├── package-lock.json             # Lockfile (committed)
├── tsconfig.json                 # TypeScript strict config
├── eslint.config.mjs             # ESLint flat config (v9+)
├── .prettierrc                   # Prettier config
├── rollup.config.ts              # Bundle src → dist/index.js
├── jest.config.ts                # Jest config (ESM)
├── LICENSE                       # Apache-2.0
├── README.md                     # User-facing documentation
├── CONTRIBUTING.md               # Contributor guide
├── SECURITY.md                   # Security policy + vulnerability reporting
├── CODEOWNERS                    # @groundcover-com/platform
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   └── feature_request.yml
│   ├── pull_request_template.md
│   ├── dependabot.yml            # Automated dependency updates
│   └── workflows/
│       ├── ci.yml                # Lint + typecheck + test + build + dist validation
│       ├── release.yml           # Tag-triggered release (update major version tag)
│       └── self-test.yml         # Dog-food: export own CI trace to groundcover
├── src/
│   ├── index.ts                  # Entry point (calls runner.run())
│   ├── runner.ts                 # Main orchestrator: fetch data → create provider → trace → export
│   ├── runner.test.ts            # Integration tests with recorded API responses
│   ├── github.ts                 # GitHub API wrappers (fetch workflow, jobs, annotations, PR labels)
│   ├── github.test.ts            # Unit tests for GitHub API functions
│   ├── tracer.ts                 # OTEL TracerProvider factory (HTTP/gRPC, context propagation)
│   ├── tracer.test.ts            # Unit tests for provider creation, header parsing, context extraction
│   ├── trace/
│   │   ├── workflow.ts           # Workflow run → root span (with optional parent context)
│   │   ├── workflow.test.ts      # Unit tests for workflow tracing + traceparent scenarios
│   │   ├── job.ts                # Job → child span (with steps)
│   │   ├── job.test.ts           # Unit tests for job tracing
│   │   ├── step.ts               # Step → child span
│   │   └── step.test.ts          # Unit tests for step tracing
│   └── __fixtures__/
│       ├── core.ts               # Mock for @actions/core
│       ├── github.ts             # Mock for @actions/github
│       ├── run.rec               # Recorded GitHub API responses for integration tests
│       └── ...                   # Additional recorded response files
└── dist/
    ├── index.js                  # Bundled output (committed — required by GitHub Actions)
    ├── index.js.map              # Source map
    └── licenses.txt              # Third-party license notices
```

---

## Technology Stack

### Runtime & Build

| Tool | Version | Purpose |
|---|---|---|
| Node.js | >=20.0.0 | GitHub Actions runner requirement |
| TypeScript | ^5.7 | Language (strict mode, ESNext target) |
| Rollup | ^4.x | Bundle to single `dist/index.js` |
| `@rollup/plugin-typescript` | ^12.x | TS compilation during bundling |
| `@rollup/plugin-node-resolve` | ^16.x | Resolve node_modules |
| `@rollup/plugin-commonjs` | ^28.x | Convert CJS to ESM |
| `@rollup/plugin-json` | ^6.x | Import JSON files |
| `rollup-plugin-license` | ^3.x | Generate `dist/licenses.txt` |

### GitHub Actions SDK

| Package | Purpose |
|---|---|
| `@actions/core` | Action inputs/outputs, logging, failure reporting |
| `@actions/github` | Authenticated Octokit client, action context |
| `@octokit/openapi-types` | TypeScript types for GitHub API responses |

### OpenTelemetry SDK

| Package | Purpose |
|---|---|
| `@opentelemetry/api` | Trace API (tracer, spans, context, propagation) |
| `@opentelemetry/sdk-trace-base` | TracerProvider, BatchSpanProcessor, IdGenerator |
| `@opentelemetry/exporter-trace-otlp-proto` | OTLP/HTTP (protobuf) exporter |
| `@opentelemetry/exporter-trace-otlp-grpc` | OTLP/gRPC exporter |
| `@opentelemetry/resources` | Resource (service name, version, etc.) |
| `@opentelemetry/context-async-hooks` | Async context propagation in Node.js |
| `@opentelemetry/semantic-conventions` | Stable + incubating CICD semantic convention constants |

### Dev Dependencies

| Tool | Purpose |
|---|---|
| Jest (^29.x) + ts-jest | Testing framework (ESM mode) |
| ESLint (^9.x) flat config | Linting (see linting section) |
| Prettier (^3.x) | Code formatting |
| `@octokit/rest` | Used in test replay infrastructure |

---

## TypeScript Configuration

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "baseUrl": "./",
    "skipLibCheck": true,
    // Strict — ALL enabled
    "strict": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noStrictGenericChecks": false,
    // Extra linter checks
    "noImplicitReturns": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    // Output
    "noEmit": true,
    "esModuleInterop": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "coverage", "jest.config.ts"]
}
```

Note: `noUncheckedIndexedAccess: true` is enabled (the upstream has a FIXME comment about it). Handle all indexed access safely.

---

## Linting & Formatting

Use **ESLint v9 flat config** (NOT legacy `.eslintrc`) + **Prettier** (NOT Biome — ESLint is the industry standard for public-facing projects).

### ESLint Config (`eslint.config.mjs`)

```javascript
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  eslintPluginPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Enforce explicit return types on exported functions
      "@typescript-eslint/explicit-function-return-type": ["error", {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
      }],
      // No floating promises
      "@typescript-eslint/no-floating-promises": "error",
      // No unused vars (allow underscore prefix)
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      // Require await in async functions
      "@typescript-eslint/require-await": "error",
      // No any
      "@typescript-eslint/no-explicit-any": "error",
      // Consistent type imports
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Test files — relax some rules
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  {
    ignores: ["dist/", "coverage/", "jest.config.ts", "rollup.config.ts"],
  },
);
```

### Prettier Config (`.prettierrc`)

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 120,
  "tabWidth": 2
}
```

### Package Scripts

```json
{
  "scripts": {
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "format": "prettier --write src/",
    "format:check": "prettier --check src/",
    "typecheck": "tsc --noEmit",
    "build": "rollup -c --configPlugin @rollup/plugin-typescript",
    "test": "cross-env NODE_OPTIONS=--experimental-vm-modules jest --collect-coverage",
    "test:ci": "cross-env NODE_OPTIONS=--experimental-vm-modules jest --collect-coverage --ci",
    "test:record": "cross-env RECORD_OCTOKIT=true NODE_OPTIONS=--experimental-vm-modules jest",
    "all": "npm run lint && npm run typecheck && npm run test && npm run build"
  }
}
```

---

## Testing Strategy

### Test Infrastructure — HTTP Replay System

Tests use a **record/replay system** for GitHub API calls. This avoids hitting the real API in CI and provides deterministic, fast tests.

**Record mode** (`npm run test:record`):
- Uses a real GitHub token to call the API
- Serializes each request/response (method, path, URL, status, base64-encoded body) to a `.rec` file
- Stored in `src/__fixtures__/`

**Replay mode** (`npm test`):
- Reads `.rec` files and intercepts Octokit requests
- Returns recorded responses in order
- Verifies request method + path match (catches API call ordering changes)
- No network access required

This is the same approach used by the upstream action and is excellent. Replicate it.

### Unit Tests

Every module gets its own `*.test.ts` file. Test the following:

#### `tracer.test.ts`
- Provider creation with HTTP endpoint
- Provider creation with gRPC endpoint
- Resource attributes are set correctly
- Extra attributes are merged
- Header parsing (`stringToRecord`):
  - Empty string → empty record
  - Single header
  - Multiple headers
  - Base64 values containing `=`
  - Whitespace trimming
- **TraceparentExtraction (NEW — critical tests)**:
  - Valid traceparent → context has correct trace ID and span ID
  - Empty/missing traceparent → returns root context
  - Malformed traceparent (wrong length, invalid hex) → falls back to root context, logs warning
  - Traceparent with `00` flags (not sampled) → preserves flag correctly
  - Traceparent with `01` flags (sampled) → preserves flag correctly

#### `trace/workflow.test.ts`
- Creates root span with correct name (workflow name or display_title)
- Sets ERROR status on failed workflows
- Sets OK status on successful workflows
- Creates "Queued" span with correct timing
- Processes all jobs as child spans
- Returns correct trace ID
- **Traceparent tests (NEW — critical)**:
  - Without traceparent → creates root span (new trace ID)
  - With valid traceparent → creates child span (preserves trace ID from traceparent)
  - Verify span's parent span ID matches the span ID from the traceparent
  - Verify trace ID in output matches trace ID from traceparent

#### `trace/job.test.ts`
- Creates span with job name
- Sets correct start/end times
- Handles `completed_at < started_at` edge case
- Skips incomplete jobs (no completed_at)
- Maps task type heuristic (build/test/deploy)
- Includes annotations as attributes
- Sets ERROR status on failed jobs

#### `trace/step.test.ts`
- Creates span with step name
- Skips incomplete steps
- Skips steps with `skipped` conclusion
- Handles timing edge case
- Sets ERROR status on failed steps

#### `github.test.ts`
- Tests pagination of jobs
- Tests annotation fetching and error handling
- Tests PR label fetching and error handling

#### `runner.test.ts` (Integration)
- Full end-to-end with recorded API responses:
  - Successful workflow run → correct trace ID output
  - Failed workflow run → correct trace ID, error spans
  - Cancelled workflow run → correct handling
  - Non-existent run ID → `core.setFailed` called
- **With traceparent (NEW)**:
  - Full run with traceparent → output trace ID matches traceparent's trace ID

### Code Coverage

Target: **≥90% line coverage**. Enforce in CI.

Jest config should include:
```typescript
coverageThreshold: {
  global: {
    branches: 85,
    functions: 90,
    lines: 90,
    statements: 90,
  },
},
```

### Deterministic ID Generation for Tests

Keep the `DeterministicIdGenerator` pattern from the upstream (seeded PRNG for stable trace/span IDs in tests). This is controlled via `OTEL_ID_SEED` env var, only used in tests. In production, the default random generator is used.

---

## CI/CD Workflows

### `ci.yml` — Main CI Pipeline

Runs on: push to `main`, all PRs

```yaml
jobs:
  lint:
    # ESLint + Prettier check
    steps:
      - npm ci
      - npm run lint
      - npm run format:check

  typecheck:
    # TypeScript compilation check
    steps:
      - npm ci
      - npm run typecheck

  test:
    # Tests on all platforms
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    steps:
      - npm ci
      - npm run test:ci
      # Upload coverage (ubuntu only) to codecov or similar

  build:
    # Build dist and validate it's committed
    needs: [lint, typecheck, test]
    steps:
      - npm ci
      - npm run build
      - name: Validate dist is up to date
        run: |
          git diff --exit-code dist/
          # Fail if dist/ is outdated — forces contributors to run `npm run build` before committing

  security:
    # npm audit
    steps:
      - npm ci
      - npm audit --audit-level=high
```

### `release.yml` — Release Automation

Triggered by: pushing a semver tag (e.g., `v1.2.3`)

```yaml
# 1. Verify CI passed for the tagged commit
# 2. Update the major version tag (v1 → points to latest v1.x.x)
# 3. Create GitHub Release with auto-generated changelog
```

Major version tag update allows users to pin to `@v1` and get non-breaking updates automatically, following the GitHub Actions convention.

### `self-test.yml` — Dog-fooding

Runs after CI completes. Uses `./` (the action itself) to export its own CI workflow trace to groundcover. This validates the action works end-to-end on every change.

```yaml
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

jobs:
  self-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        with:
          otlpEndpoint: ${{ secrets.GC_OTLP_ENDPOINT }}/v1/traces
          otlpHeaders: "apikey=${{ secrets.GC_KEY_HEADER }}"
          githubToken: ${{ secrets.GITHUB_TOKEN }}
          runId: ${{ github.event.workflow_run.id }}
        env:
          OTEL_CONSOLE_ONLY: ${{ secrets.GC_OTLP_ENDPOINT == '' && 'true' || 'false' }}
```

---

## Security

### Dependency Management

- **`dependabot.yml`**: Enable automated PRs for npm dependency updates (weekly)
- **`npm audit`**: Run in CI, fail on `high` or `critical` vulnerabilities
- **Lockfile committed**: `package-lock.json` MUST be committed. Use `npm ci` everywhere.

### Secret Handling

- **Never log secrets**: The `otlpHeaders` input contains API keys. Never log its value. Use `core.setSecret()` for any value that could contain secrets.
- **Token permissions**: Document minimum required GitHub token permissions clearly. The action only READS data — it never writes.

### Permissions Documentation

In README, clearly document required permissions:

```yaml
permissions:
  actions: read     # REQUIRED — to fetch workflow run and job data
  contents: read    # REQUIRED for private repos
  checks: read      # OPTIONAL — to fetch job annotations
  pull-requests: read  # OPTIONAL — to fetch PR labels
```

### Supply Chain

- Pin all GitHub Actions in CI to full SHA (not just tags)
- `dist/index.js` is committed (GitHub Actions requirement), but CI validates it matches the source via `git diff --exit-code dist/`
- Include `dist/licenses.txt` with all third-party license notices

### SECURITY.md

```markdown
# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities to security@groundcover.com.

Do NOT open a public GitHub issue for security vulnerabilities.

We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Supported Versions

| Version | Supported |
|---|---|
| v1.x | ✅ |
```

---

## Documentation

### README.md Structure

The README is the primary user-facing documentation. It must be clear, scannable, and copy-pasteable.

```markdown
# groundcover OTEL CI/CD Export Action

[![CI](badge)](link) [![License](badge)](link) [![GitHub Release](badge)](link)

Export GitHub Actions workflow runs as OpenTelemetry traces.

## Quick Start

[Minimal working example — copy-paste ready]

## Features

- Export workflow → jobs → steps as OTEL trace hierarchy
- Link CI/CD traces with application traces via `traceparent`
- OTLP/HTTP and OTLP/gRPC support
- Full OTEL CI/CD semantic convention compliance
- Custom resource attributes

## Usage

### Basic — Separate Workflow (Recommended)

[workflow_run trigger example]

### Basic — Same Workflow

[needs: [job1, job2] example with if: always()]

### Link CI/CD + Application Traces

[Full example showing traceparent generation → app → export action]

### groundcover

[Copy-paste example specifically for groundcover users]

### Other Platforms

[Examples for Honeycomb, Axiom, New Relic, Grafana, Jaeger]

## Inputs

[Table with all inputs, descriptions, required/optional, defaults, examples]

## Outputs

[Table with traceId output]

## Permissions

[Required and optional permissions with explanation]

## Private Repositories

[Additional permissions needed]

## Trace Structure

[Visual diagram of span hierarchy]

## How Trace Linking Works

[Explain the traceparent flow with a diagram:
 Generate TRACEPARENT → App reads it → Export action reads it → Same trace ID]

## Troubleshooting

[Common issues: endpoint URL format, permissions, private repos, rate limits]

## Contributing

[Link to CONTRIBUTING.md]

## License

Apache-2.0
```

### CONTRIBUTING.md

```markdown
# Contributing

## Development Setup

1. Clone the repo
2. npm ci
3. npm run all (lint + typecheck + test + build)

## Recording Test Fixtures

Tests use recorded GitHub API responses. To update:

1. Create a `.env.test` file with `GH_TOKEN=your_token`
2. npm run test:record
3. Commit updated .rec files

## Making Changes

1. Create a feature branch
2. Make changes in src/
3. Run `npm run all`
4. Run `npm run build` — commit dist/ changes
5. Open a PR

## Release Process

1. Merge PR to main
2. Create a semver tag: `git tag v1.x.x && git push --tags`
3. Release workflow updates `v1` tag and creates GitHub Release
```

---

## Implementation Details — Key Differences from Upstream

### 1. Trace Context Propagation (`traceparent` input)

This is the core differentiator. In `tracer.ts` or a new `context.ts`:

```typescript
import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

function extractParentContext(traceparent: string | undefined): Context {
  if (!traceparent) {
    return ROOT_CONTEXT;
  }

  // Validate format: 00-<32 hex>-<16 hex>-<2 hex>
  const TRACEPARENT_REGEX = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
  if (!TRACEPARENT_REGEX.test(traceparent)) {
    core.warning(`Invalid traceparent format: "${traceparent}". Creating new root trace.`);
    return ROOT_CONTEXT;
  }

  const propagator = new W3CTraceContextPropagator();
  const carrier = { traceparent };
  return propagator.extract(ROOT_CONTEXT, carrier, {
    get: (c, key) => c[key],
    keys: (c) => Object.keys(c),
  });
}
```

In `trace/workflow.ts`, change the span creation:

```typescript
// BEFORE (upstream — always root):
{ attributes, root: true, startTime }

// AFTER (ours — conditionally root):
const spanOptions = {
  attributes,
  startTime,
  ...(parentContext === ROOT_CONTEXT ? { root: true } : {}),
};

// Start span within the parent context (or root if no parent):
return await tracer.startActiveSpan(name, spanOptions, parentContext, async (rootSpan) => { ... });
```

### 2. ESLint Instead of Biome

The upstream uses Biome. We use ESLint + Prettier because:
- ESLint has a vastly larger ecosystem
- `typescript-eslint` strict + stylistic rules catch more issues
- ESLint is the industry standard for public TypeScript projects
- Better IDE integration

### 3. Better Error Handling

- Use `core.warning()` for non-fatal issues (missing permissions, invalid traceparent)
- Use `core.error()` + `core.setFailed()` only for truly fatal errors
- Never swallow errors silently

### 4. `noUncheckedIndexedAccess: true`

The upstream has this disabled with a FIXME. We enable it and handle indexed access properly with type narrowing.

---

## Acceptance Criteria

The action is ready for v1.0.0 release when ALL of the following are true:

### Functionality
- [ ] Exports workflow → jobs → steps as OTEL trace hierarchy
- [ ] Supports OTLP/HTTP (protobuf) and OTLP/gRPC endpoints
- [ ] `traceparent` input correctly links parent trace context
- [ ] Without `traceparent`, creates a new root trace (backward compatible)
- [ ] Outputs `traceId` for downstream use
- [ ] All semantic convention attributes are mapped correctly
- [ ] Edge cases handled (incomplete jobs, skipped steps, timing anomalies)
- [ ] Graceful degradation on missing permissions (annotations, PR labels)

### Quality
- [ ] TypeScript strict mode with zero `any` types
- [ ] ≥90% test coverage
- [ ] Tests run on ubuntu, windows, macos
- [ ] ESLint strict + stylistic passes with zero warnings
- [ ] Prettier formatting consistent
- [ ] `dist/` is validated in CI (matches source)

### Documentation
- [ ] README with quick start, all examples, input/output tables, troubleshooting
- [ ] CONTRIBUTING.md with dev setup and release process
- [ ] SECURITY.md with vulnerability reporting process
- [ ] LICENSE (Apache-2.0)
- [ ] CODEOWNERS configured

### CI/CD
- [ ] CI pipeline: lint, typecheck, test (multi-platform), build, security audit
- [ ] Release automation: semver tag → major tag update → GitHub Release
- [ ] Self-test: dog-food the action on its own CI traces
- [ ] Dependabot configured for weekly npm updates

### Security
- [ ] `npm audit` passes (no high/critical)
- [ ] Secrets are never logged
- [ ] Minimum permissions documented
- [ ] GitHub Actions in CI pinned to SHA

---

## Reference: Upstream Source Analysis

The following is a complete analysis of every source file in `corentinmusard/otel-cicd-action@v2` to ensure nothing is missed:

| File | Lines | Purpose | Keep/Change |
|---|---|---|---|
| `src/index.ts` | 1 | Entry point: `import { run } from "./runner"; run();` | Keep as-is |
| `src/runner.ts` | 89 | Main orchestrator: read inputs → fetch GitHub data → create provider → trace → export | Keep structure, add `traceparent` input reading |
| `src/tracer.ts` | 95 | TracerProvider factory: HTTP/gRPC exporter, DeterministicIdGenerator for tests | Keep, add `extractParentContext()` |
| `src/github.ts` | 57 | GitHub API wrappers: getWorkflowRun, listJobs, getAnnotations, getPRLabels | Keep as-is |
| `src/trace/workflow.ts` | 125 | Root span creation + all workflow run attributes | **CHANGE**: Remove hardcoded `root: true`, accept parent context |
| `src/trace/job.ts` | 100 | Job span creation + task type heuristic + annotations | Keep as-is |
| `src/trace/step.ts` | 47 | Step span creation | Keep as-is |
| `src/replay.ts` | 118 | Record/replay GitHub API calls for tests | Keep (excellent testing approach) |
| `src/runner.test.ts` | 100 | Integration tests with recorded responses | Keep, add traceparent test cases |
| `src/tracer.test.ts` | 65 | Unit tests for provider + header parsing | Keep, add traceparent extraction tests |
| `src/__fixtures__/core.ts` | ~15 | Mock for @actions/core | Keep as-is |
| `src/__fixtures__/github.ts` | ~10 | Mock for @actions/github | Keep as-is |
| `rollup.config.ts` | 30 | Bundle config | Keep as-is |

---

## Non-Functional Requirements

### Performance
- The action typically processes workflows with 1-20 jobs and 1-100 steps. Performance is not a concern.
- Use `BatchSpanProcessor` (not `SimpleSpanProcessor`) for efficient export.
- Call `provider.forceFlush()` before `provider.shutdown()` to ensure all spans are exported.

### Reliability
- The action runs AFTER workflow completion. If it fails, it does NOT affect the original workflow.
- Use `core.setFailed()` for hard failures — this marks the export job as failed but doesn't block merges.

### Compatibility
- Target the same platforms as the GitHub Actions runner: Linux, Windows, macOS
- Node.js 20+ (GitHub Actions `node20` runner)
- Test on all three platforms in CI

---

## Naming Conventions

- **Repository**: `otel-cicd-export-action` (hyphenated, descriptive)
- **NPM package name** (in package.json): `@groundcover-com/otel-cicd-export-action` (scoped, not published to npm)
- **Action name** (in action.yml): `groundcover OTEL CI/CD Export`
- **OTEL service name default**: The workflow name from the GitHub API
- **Tracer name**: `otel-cicd-export-action`
