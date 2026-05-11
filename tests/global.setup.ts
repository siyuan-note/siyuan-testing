import {expect, test} from "@playwright/test";

test("open user guide", async ({page}) => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);

    await page.locator("#barWorkspace").click();
    await page.waitForTimeout(300);
    await page.locator('[data-id="userGuide"]').click();
    await page.waitForTimeout(4000);

    await expect(page.locator(".protyle-wysiwyg").first()).toBeTruthy();
    await expect(page.locator(".protyle-breadcrumb").first()).toBeTruthy();

    await page.waitForTimeout(1000);
});