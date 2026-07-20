import {test} from "@playwright/test";
import {ensureTestNotebook, TEST_NOTEBOOK_NAME} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";
import {validateTestTarget} from "./helpers/runtime";

test(`validate target and ensure ${TEST_NOTEBOOK_NAME} notebook`, async ({request, baseURL}) => {
    if (!baseURL) {
        throw new Error("playwright.config.ts must define use.baseURL");
    }
    const api = new SiyuanAPI(request, baseURL);
    await validateTestTarget(api, baseURL);
    await ensureTestNotebook(api);
});
