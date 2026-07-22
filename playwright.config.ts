import {defineConfig} from "@playwright/test";
import {getBaseURL} from "./tests/helpers/runtime";

const knowledgeNavigationTests = [
    "**/tag.spec.ts",
    "**/bookmark-outline.spec.ts",
    "**/dock-filter.spec.ts",
    "**/backlink.spec.ts",
];

const statefulEditorTests = [
    "**/editor-copy-paste.spec.ts",
    "**/editor-cross-document.spec.ts",
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
            name: "main",
            dependencies: ["setup"],
            testIgnore: [...statefulEditorTests, ...documentNavigationTests, ...knowledgeNavigationTests],
        },
        {
            name: "stateful-editor",
            dependencies: ["main"],
            testMatch: statefulEditorTests,
            workers: 1,
        },
        {
            name: "document-navigation",
            dependencies: ["stateful-editor"],
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
