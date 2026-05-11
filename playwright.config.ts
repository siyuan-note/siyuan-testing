import {defineConfig} from "@playwright/test";

export default defineConfig({
    testDir: "./tests",
    timeout: 60000,
    retries: 0,
    workers: 4,
    use: {
        baseURL: "http://127.0.0.1:6806",
        headless: false,
        viewport: null,
        actionTimeout: 10000,
        channel: "chrome",
        launchOptions: {
            args: ["--start-maximized"],
        },
    },
    projects: [
        {
            name: 'setup',
            testMatch: /global\.setup\.ts/,
        },
        {
            name: 'main',
            dependencies: ['setup'],
        },
    ],
});
