import {defineConfig} from "@playwright/test";
import {getBaseURL} from "./tests/helpers/runtime";

const knowledgeNavigationTests = [
    "**/tag.spec.ts",
    "**/bookmark-outline.spec.ts",
    "**/dock-filter.spec.ts",
    "**/backlink.spec.ts",
];

const parallelTests = [
    "**/api-robustness.spec.ts",
    "**/kernel-log.spec.ts",
];

const editorTests = [
    "**/editor*.spec.ts",
];

const attributeViewTests = [
    "**/editor-attribute-view.spec.ts",
];

const encryptedNotebookTests = [
    "**/encrypted-notebook.spec.ts",
];

const documentNavigationTests = [
    "**/document-lifecycle.spec.ts",
    "**/file-tree.spec.ts",
    "**/notebook-lifecycle.spec.ts",
];

export default defineConfig({
    testDir: "./tests",
    timeout: 60000,
    retries: 0,
    workers: 2,
    use: {
        baseURL: getBaseURL(),
        headless: true,
        viewport: {width: 1440, height: 900},
        actionTimeout: 10000,
        channel: "chrome",
    },
    projects: [
        {
            name: "setup",
            testMatch: /global\.setup\.ts/,
            teardown: "cleanup",
        },
        {
            name: "parallel",
            dependencies: ["setup"],
            testMatch: parallelTests,
            workers: 2,
        },
        {
            name: "main",
            dependencies: ["parallel"],
            testIgnore: [
                ...encryptedNotebookTests,
                ...editorTests,
                ...documentNavigationTests,
                ...knowledgeNavigationTests,
                ...parallelTests,
            ],
            workers: 1,
        },
        {
            name: "encrypted-notebook",
            dependencies: ["main"],
            testMatch: encryptedNotebookTests,
            workers: 1,
        },
        {
            name: "editor",
            dependencies: ["encrypted-notebook"],
            testMatch: editorTests,
            testIgnore: process.env.SIYUAN_E2E_EXCLUDE_ATTRIBUTE_VIEW === "1" ?
                attributeViewTests : undefined,
            workers: 1,
        },
        {
            name: "document-navigation",
            dependencies: ["editor"],
            testMatch: documentNavigationTests,
            workers: 1,
        },
        {
            name: "knowledge-navigation",
            dependencies: ["document-navigation"],
            testMatch: knowledgeNavigationTests,
            workers: 1,
        },
        {
            name: "cleanup",
            testMatch: /global\.teardown\.ts/,
        },
    ],
});
