# AGENTS.md

SiYuan end-to-end testing guide. This repository contains Playwright tests for a running SiYuan instance.

## 1. Toolchain and commands

- Use Node.js with pnpm; preserve `pnpm-lock.yaml` as the dependency source of truth.
- Install dependencies with `pnpm install`.
- Run all tests in headless background mode with `pnpm test`; it compiles the desktop bundle, starts the local test kernel, and stops both processes after the run.
- Run one test file with `pnpm test:focused -- tests/<feature>.spec.ts`; managed test commands create and use `~/SiYuan-Testing` by default.
- Use `pnpm start:siyuan` only when a separately managed long-running instance is useful for interactive debugging.
- Use `pnpm test:headed` or `pnpm test:ui` only when interactive debugging is useful.

## 2. Test data

- Run all tests in the notebook named `SiYuan Testing`. The global setup must create it when it does not exist and open it when it is closed.
- Run the local test instance in `~/SiYuan-Testing`; use `SIYUAN_EXPECT_WORKSPACE` only when an isolated environment requires another absolute path.
- Create an independent document for every test. Do not use the user guide, an existing user document, or data created by another test.
- Use `tests/helpers/testNotebook.ts` for notebook and document setup instead of duplicating API calls.
- Give generated documents a feature-specific prefix and a unique suffix so failures can be identified after a run.
- Tests may run in parallel. Do not depend on execution order or shared mutable document state.
- Delete documents created by a successful test in the automatic fixture teardown; preserve documents created by failed, timed-out, or interrupted tests.
- Delete the `SiYuan Testing` notebook only when the complete Playwright run passes; preserve it when any test does not pass.

## 3. Test organization

- Name spec files after the tested feature and behavior, for example `editor-list-drag.spec.ts`; avoid generic names such as `siyuan.spec.ts`.
- Keep each test focused on one observable behavior. Use independent tests for distinct drop zones, structures, or user-visible outcomes.
- Put reusable setup and assertions in `tests/helpers/`.
- Prefer stable semantic selectors such as `data-type` and `data-node-id`. Avoid selectors tied only to layout, generated classes, or translated text unless that text is the behavior under test.
- Restore any global UI state changed by a test, including dock visibility, layout, and settings.

## 4. Editor and drag-and-drop tests

- Exercise the real editor interaction path. Drag-and-drop tests must dispatch the relevant pointer or drag events instead of only calling internal implementation functions.
- Assert the user-visible drag tip when it distinguishes drop semantics.
- Assert the exact final position and hierarchy, not only that the dragged text remains visible.
- Cover structurally different drop zones separately, such as before an item, after an item, inside an item, and into a nested list when they are relevant.
- Reload the document when persistence or editor rehydration could change the result.

## 5. Structural validation

- For changes that can affect block hierarchy, validate both the live editor DOM and the persisted `.sy` tree.
- DOM assertions must reject invalid containment, duplicate node IDs, and nodes placed outside their valid block parent.
- Read persisted documents through SiYuan's HTTP APIs. Do not locate workspace files by assuming a local absolute path.
- Validate `.sy` data against the format documented in the SiYuan repository's `docs/SY-FORMAT.md`; validate workspace paths against `docs/WORKSPACE.md`.
- Verify relevant node IDs, `Properties.id`, parent-child constraints, and type-specific fields. Keep reusable format checks in helper modules.
- Poll for persisted state when the editor saves asynchronously; do not replace synchronization with arbitrary long sleeps. Use an explicit timeout appropriate to the operation, allowing up to 30 seconds for kernel indexing when needed.

## 6. Verification and maintenance

- Run the narrowest affected spec while developing, then run the complete suite before handing off a change when the environment permits.
- A regression test should fail against the faulty behavior and pass with the fix.
- Do not weaken an assertion merely to remove flakiness. Identify and synchronize on the actual application state.
- Preserve unrelated changes in both this repository and the SiYuan repository.
- Do not commit or push unless explicitly requested.
