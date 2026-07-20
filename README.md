# SiYuan Testing

End-to-end tests for a running SiYuan instance.

## Requirements

- Start SiYuan before running the tests.
- Use a workspace that may safely contain the dedicated `SiYuan Testing` notebook.
- Install dependencies with `pnpm install`.

The default target is `http://127.0.0.1:6806`. Set `SIYUAN_BASE_URL` to use another local address. Non-loopback targets are rejected unless `SIYUAN_ALLOW_REMOTE=1` is explicitly set. Set `SIYUAN_EXPECT_WORKSPACE` to the expected absolute workspace path when an exact workspace guard is useful.

The setup prints the target URL, workspace path, and SiYuan version before running any feature tests.

## Commands

- `pnpm test`: run all tests in headless mode.
- `pnpm test:headed`: run all tests with a visible browser.
- `pnpm test:ui`: open Playwright UI mode.
- `pnpm test:list`: list discovered tests without executing them.
- `pnpm test:repeat`: repeat the suite ten times to find synchronization problems.
- `pnpm typecheck`: type-check the configuration, fixtures, helpers, and specs.
- `pnpm exec playwright test tests/<feature>.spec.ts --project=main`: run one spec file.

## Test data and cleanup

Every test creates an independent document in the `SiYuan Testing` notebook. Documents from successful tests are deleted automatically. Documents from failed, timed-out, or interrupted tests are preserved and attached to the Playwright result as JSON metadata.

Tests that change global settings must use the `globalSettings` fixture so the original values are restored. Document tests may run in parallel; tests that share global application state must remain serial.

Reusable SiYuan HTTP operations belong in `tests/helpers/siyuanAPI.ts`. Tests should use the `createTestDocument` fixture instead of creating or deleting documents directly.

The lifecycle suite covers document creation, rename, move, duplication, deletion, and history rollback. Documents created indirectly, such as duplicates, must be registered with the `trackTestDocument` fixture so the normal cleanup policy still applies. Cleanup locates tracked documents by ID and checks the complete document tree before removing the test notebook.
