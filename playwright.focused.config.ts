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

const getWorkerCount = () => ["main", "editor"].includes(process.env.SIYUAN_E2E_SHARD || "") ? 2 : 1;

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
                // main shard 的测试互相独立（独立文档 + teardown），并行提速；
                // retries 兜底并行下偶发的拖拽时序 flake
                retries: 1,
            };
        case "editor":
            return {
                name: "editor",
                testMatch: editorTests,
                testIgnore: attributeViewTests,
                // editor 是多文件 shard，按文件并行提速（测试互相独立：独立文档 + teardown）；
                // retries 兜底并行下偶发的粘贴/控件时序 flake
                retries: 1,
            };
        case "attribute-view":
            return {
                name: "attribute-view",
                testMatch: attributeViewTests,
                // attribute-view 是单文件 shard，测试依赖内核事务串行处理，并行实测无提速，保持单 worker
            };
        default:
            throw new Error(`Unknown SIYUAN_E2E_SHARD: ${process.env.SIYUAN_E2E_SHARD}`);
    }
};

export default defineConfig({
    testDir: "./tests",
    timeout: 60000,
    retries: 0,
    workers: getWorkerCount(),
    use: {
        baseURL: getBaseURL(),
        headless: true,
        viewport: {width: 1440, height: 900},
        actionTimeout: 10000,
        channel: "chrome",
        trace: "on-first-retry",
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
