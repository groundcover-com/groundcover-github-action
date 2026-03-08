# Contributing

Thanks for your interest in contributing. This document covers how to get set up, run tests, and submit changes.

## Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/groundcover-com/groundcover-github-action.git
   cd groundcover-github-action
   ```

2. Install dependencies:

   ```bash
   npm ci
   ```

3. Build and verify everything passes:

   ```bash
   npm run all
   ```

   This runs linting, type checking, tests, and the production build in sequence.

## Project Structure

```
src/                 TypeScript source and tests (*.test.ts)
src/__fixtures__/    Recorded API fixtures and test shims
dist/                Compiled output (committed, do not edit manually)
action.yml           Action metadata (inputs, outputs, branding)
scripts/             Maintainer scripts (branch protection setup)
.github/workflows/   CI, release, self-test, CodeQL, stale maintenance
```

## Recording Test Fixtures

Tests use recorded HTTP fixtures so they don't make live GitHub API calls. Fixtures are stored as `.rec` files in `src/__fixtures__/`.

To record new fixtures against the real GitHub API, set a `GITHUB_TOKEN` environment variable with `actions:read` access and run:

```bash
npm run test:record
```

This sets `RECORD_OCTOKIT=true`, which tells the test harness to make real API calls and write the responses to disk. Commit the resulting `.rec` files alongside your test changes.

When `RECORD_OCTOKIT` is not set, tests replay the recorded fixtures and never hit the network.

## Making Changes

1. Create a branch:

   ```bash
   git checkout -b my-feature
   ```

2. Make your changes in `src/`.

3. Add or update tests in `src/*.test.ts` and `src/trace/*.test.ts`. If your change touches GitHub API calls, re-record relevant fixtures with `npm run test:record`.

4. Run the full check suite:

   ```bash
   npm run all
   ```

5. Commit the compiled output in `dist/`. The `dist/` directory is checked in so the action can run without a build step in consumer workflows. The `npm run build` step in `npm run all` updates it automatically.

6. Open a pull request against `main`. The CI workflow will run linting, tests, and a dist check to confirm the committed `dist/` matches the source.

## Code Style

- TypeScript strict mode is enabled.
- ESLint and Prettier are configured. Run `npm run lint:fix` and `npm run format` before committing.
- Keep functions small and focused. Prefer explicit types over `any`.

## CI/CD Workflows

- `ci.yml`: lint, typecheck, tests (Linux/Windows/macOS), build, and `npm audit`
- `release.yml`: tag-triggered release publishing and major tag update
- `self-test.yml`: dogfooding workflow that exports CI traces with this action
- `codeql.yml`: code scanning on push/PR plus weekly schedule
- `stale.yml`: stale issue/PR lifecycle management

All required checks should pass before merge.

## Branch Protection Setup

For new repositories or rebuilds, configure branch protection with:

```bash
./scripts/setup-branch-protection.sh
```

This script configures required checks, required reviews, CODEOWNERS enforcement, linear history, and conversation resolution for `main`.

## Release Process

Releases are tagged from `main`. The major tag (e.g., `v1`) is kept in sync with the latest patch release so consumers using `@v1` always get the latest stable version.

1. Merge all changes to `main`.
2. Create a new SemVer tag (e.g., `v1.2.3`) and push it.
3. The release workflow publishes a GitHub Release and updates the major tag.

To create a tag manually:

```bash
git tag v1.2.3
git push origin v1.2.3
```

The CI will handle the rest.
