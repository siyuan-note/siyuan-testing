import {test} from "@playwright/test";
import {ensureTestNotebook} from "./helpers/testNotebook";

test("ensure Test notebook", async ({page}) => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);
    await ensureTestNotebook(page);
});
