import {defineConfig} from "@playwright/test";
import {getBaseURL} from "../tests/helpers/runtime";

export default defineConfig({
    testDir: "../tests",
    outputDir: "../test-results",
    timeout: 120000,
    retries: 0,
    workers: 1,
    use: {
        baseURL: getBaseURL(),
        headless: true,
        viewport: {width: 1440, height: 900},
        channel: "chrome",
    },
    projects: [
        {name: "setup", testMatch: /global\.setup\.ts/, teardown: "cleanup"},
        {name: "ipad", testMatch: "**/ipad/*.spec.ts", dependencies: ["setup"]},
        {name: "touch-cancel", testMatch: "**/editor-touch-block-selection.spec.ts", dependencies: ["setup"]},
        {name: "cleanup", testMatch: /global\.teardown\.ts/},
    ],
});
