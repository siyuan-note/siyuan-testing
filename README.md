# SiYuan Testing

End-to-end tests for a running SiYuan instance.

## Requirements

- Start SiYuan before running the tests.
- Use a workspace that may safely contain the dedicated `SiYuan Testing` notebook.
- Install dependencies with `pnpm install`.

The default target is `http://127.0.0.1:6806`. Set `SIYUAN_BASE_URL` to use another local address. Non-loopback targets are rejected unless `SIYUAN_ALLOW_REMOTE=1` is explicitly set. Set `SIYUAN_EXPECT_WORKSPACE` to the expected absolute workspace path when an exact workspace guard is useful.

The setup prints the target URL, workspace path, and SiYuan version before running any feature tests.

The encrypted-notebook lifecycle test is opt-in because creating its isolated notebook requires the workspace master password. Enable encrypted notebooks yourself, set `SIYUAN_TEST_ENCRYPTION_PASSWORD` in the test process, and run `pnpm exec playwright test tests/encrypted-notebook.spec.ts --project=main`. The suite never enables or disables encryption and never changes the master password.

## Commands

- `pnpm test`: run all tests in headless mode.
- `pnpm test:smoke`: run the tagged startup, document, editor, import, flashcard, and WebSocket checks in about one to two minutes.
- `pnpm test:editor`: run all editor specs serially.
- `pnpm test:navigation`: run document, notebook, file-tree, tag, bookmark, outline, and backlink specs serially.
- `pnpm test:data`: run import, export, history, asset, and attribute-view specs serially.
- `pnpm test:headed`: run all tests with a visible browser.
- `pnpm test:ui`: open Playwright UI mode.
- `pnpm test:list`: list discovered tests without executing them.
- `pnpm test:repeat`: repeat the suite ten times to find synchronization problems.
- `pnpm typecheck`: type-check the configuration, fixtures, helpers, and specs.
- `pnpm exec playwright test tests/<feature>.spec.ts --project=main`: run one spec file.
- `pnpm exec playwright test tests/<feature>.spec.ts --project=main --grep "<test name>"`: run one matching test while developing or diagnosing a failure.

During development, start with `pnpm test:smoke`, run only the changed spec or the relevant feature command while iterating, and reserve `pnpm test` for the final regression pass. Focused commands use one worker and retain target validation, test-data cleanup, and kernel-log auditing. Use `--workers=1` when diagnosing a direct Playwright command whose workflow depends on shared UI state or when preserving the order of diagnostic output matters.

## Coverage

The suite covers workspace startup, settings restoration, and main WebSocket reconnection; document and file-tree lifecycle; encrypted-notebook locking, unlocking, and search isolation; editor input, undo and redo, concurrent editors, copy and paste, and cross-document transactions; block splitting, merging, batch operations, transformations, list dragging, super blocks, references, and query embeds; global search; tags, bookmarks, outlines, and backlinks; flashcard creation, review progress, removal, and reload persistence; attribute views and attribute-view history rollback; attachment and image persistence; Markdown and standalone HTML export; export-bundle rendering for highlighted code, math, and Mermaid; Markdown and SiYuan archive round trips with hierarchy, references, and assets; and document history preview, rollback, deletion recovery, and reload persistence.

## Test data and cleanup

Every test creates an independent document in the `SiYuan Testing` notebook. Documents from successful tests are deleted automatically. Documents from failed, timed-out, or interrupted tests are preserved and attached to the Playwright result as JSON metadata.

Notebook-level tests are the only test-data exceptions. The encrypted-notebook test creates a uniquely named encrypted notebook because encryption is a notebook-level property. Notebook lifecycle tests create uniquely named ordinary notebooks. Passing tests remove these notebooks; failing tests preserve them and attach their IDs and names for diagnosis. A failed encrypted-notebook test also locks its notebook before preserving it.

Tests that change global settings must use the `globalSettings` fixture so the original values are restored. Document tests may run in parallel; tests that share global application state must remain serial.

Reusable SiYuan HTTP operations belong in `tests/helpers/siyuanAPI.ts`. Tests should use the `createTestDocument` fixture instead of creating or deleting documents directly.

The lifecycle suite covers document creation, rename, move, duplication, deletion, and history rollback. Documents created indirectly, such as duplicates, must be registered with the `trackTestDocument` fixture so the normal cleanup policy still applies. Cleanup locates tracked documents by ID and checks the complete document tree before removing the test notebook.

The search suite covers title and multilingual content lookup, result navigation, index updates after editing or deletion, special-character input, block-type and path filters, query syntax, regular expressions, and selected-result replacement. It waits for the kernel index through the public search API before asserting the search dialog and isolates persisted search settings from parallel workers.
