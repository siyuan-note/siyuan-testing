import {defineConfig} from "@playwright/test";

export default defineConfig({
    testDir: "./tests",
    timeout: 60000,
    retries: 0,
    workers: 4,
    use: {
        baseURL: "http://127.0.0.1:6806",
        headless: true,
        viewport: {width: 1440, height: 900},
        actionTimeout: 10000,
        channel: "chrome",
    },
    projects: [
        {
            name: 'setup',
            testMatch: /global\.setup\.ts/,
            teardown: 'cleanup',
        },
        {
            name: 'main',
            dependencies: ['setup'],
        },
        {
            name: 'cleanup',
            testMatch: /global\.teardown\.ts/,
        },
    ],
});
