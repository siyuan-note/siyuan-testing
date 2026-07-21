import {test} from "@playwright/test";
import {ensureTestNotebook, TEST_NOTEBOOK_NAME} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";
import {validateTestTarget} from "./helpers/runtime";
import {startKernelLogAudit} from "./helpers/kernelLog";

test(`validate target and ensure ${TEST_NOTEBOOK_NAME} notebook`, async ({request, baseURL}) => {
    if (!baseURL) {
        throw new Error("playwright.config.ts must define use.baseURL");
    }
    const api = new SiyuanAPI(request, baseURL);
    const workspaceInfo = await validateTestTarget(api, baseURL);
    await startKernelLogAudit(workspaceInfo.workspaceDir, baseURL);
    await ensureTestNotebook(api);
});
