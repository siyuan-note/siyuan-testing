import {defineConfig} from "@playwright/test";
import {getBaseURL} from "./tests/helpers/runtime";

const editorTests = [
    "**/editor*.spec.ts",
];

const attributeViewTests = [
    "**/editor-attribute-view.spec.ts",
];

const encryptedNotebookTests = [
    "**/encrypted-notebook.spec.ts",
];

const getFocusedProject = () => {
    switch (process.env.SIYUAN_E2E_SHARD) {
        case undefined:
            return {
                name: "focused",
                testIgnore: /global\.(setup|teardown)\.ts/,
            };
        case "main":
            return {
                name: "main",
                testIgnore: [
                    /global\.(setup|teardown)\.ts/,
                    ...encryptedNotebookTests,
                    ...editorTests,
                ],
            };
        case "editor":
            return {
                name: "editor",
                testMatch: editorTests,
                testIgnore: attributeViewTests,
            };
        case "attribute-view":
            return {
                name: "attribute-view",
                testMatch: attributeViewTests,
            };
        default:
            throw new Error(`Unknown SIYUAN_E2E_SHARD: ${process.env.SIYUAN_E2E_SHARD}`);
    }
};

export default defineConfig({
    testDir: "./tests",
    timeout: 60000,
    retries: 0,
    workers: 1,
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
            ...getFocusedProject(),
            dependencies: ["setup"],
        },
        {
            name: "cleanup",
            testMatch: /global\.teardown\.ts/,
        },
    ],
});
