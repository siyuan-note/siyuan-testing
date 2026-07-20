import {test} from "@playwright/test";
import {ensureTestNotebook, TEST_NOTEBOOK_NAME} from "./helpers/testNotebook";

test(`ensure ${TEST_NOTEBOOK_NAME} notebook`, async ({page}) => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);
    await ensureTestNotebook(page);
});
