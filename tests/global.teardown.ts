import {expect, test} from "@playwright/test";
import {TEST_NOTEBOOK_NAME} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";
import {finishKernelLogAudit} from "./helpers/kernelLog";

test(`remove empty ${TEST_NOTEBOOK_NAME} notebook and audit kernel log`, async ({request, baseURL}, testInfo) => {
    if (!baseURL) {
        throw new Error("playwright.config.ts must define use.baseURL");
    }
    const api = new SiyuanAPI(request, baseURL);
    const notebook = (await api.listNotebooks()).find(item => item.name === TEST_NOTEBOOK_NAME);
    if (notebook) {
        const documents = await api.listAllDocuments(notebook.id);
        if (documents.length === 0) {
            await api.removeNotebook(notebook.id);
        }
    }

    const audit = await finishKernelLogAudit();
    if (!audit.enabled) {
        console.log(`[siyuan-testing] Kernel log audit skipped: ${audit.reason}`);
        return;
    }
    if (audit.errors.length > 0) {
        await testInfo.attach("kernel-log-errors", {
            body: Buffer.from(audit.errors.join("\n")),
            contentType: "text/plain",
        });
    }
    expect(audit.errors, `new kernel errors in ${audit.logPath}`).toEqual([]);
});
