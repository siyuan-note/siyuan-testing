import {defineConfig} from "@playwright/test";
import {getBaseURL} from "./tests/helpers/runtime";

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
            name: "focused",
            dependencies: ["setup"],
            testIgnore: /global\.(setup|teardown)\.ts/,
        },
        {
            name: "cleanup",
            testMatch: /global\.teardown\.ts/,
        },
    ],
});
