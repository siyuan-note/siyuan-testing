import {defineConfig} from "@playwright/test";

if (!process.env.SIYUAN_ELECTRON_APP_DIR) {
    throw new Error("SIYUAN_ELECTRON_APP_DIR must select the compiled app checkout");
}

export default defineConfig({
    testDir: "../tests",
    testMatch: ["document-rich-title.spec.ts", "document-title-backlinks.spec.ts", "document-title-inline.spec.ts"],
    workers: 1,
    retries: 0,
    timeout: 120000,
    reporter: "list",
    outputDir: "../test-results/electron",
    use: {
        baseURL: process.env.SIYUAN_BASE_URL || "http://127.0.0.1:6806",
        screenshot: "only-on-failure",
    },
});
