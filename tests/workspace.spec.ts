import {expect, test} from "./fixtures";

test.describe("workspace", () => {
    test.describe.configure({mode: "parallel"});

    test("toggle dock sidebar", async ({page}) => {
        await page.goto("http://127.0.0.1:6806");
        await page.waitForTimeout(3000);

        const dock = page.locator("#dockLeft");
        const isVisible = await dock.isVisible().catch(() => false);

        await page.locator("#barDock").click();
        await page.waitForTimeout(500);

        if (isVisible) {
            await expect(dock).not.toBeVisible();
        } else {
            await expect(dock).toBeVisible();
        }

        await page.locator("#barDock").click();
        await page.waitForTimeout(500);
        if (isVisible) {
            await expect(dock).toBeVisible();
        } else {
            await expect(dock).not.toBeVisible();
        }
    });

    test("toggle theme", async ({page}) => {
        await page.goto("http://127.0.0.1:6806");
        await page.waitForTimeout(3000);

        await page.locator("#barMode").click();
        await page.waitForTimeout(300);

        await page.locator('[data-id="themeDark"]').click();
        await page.waitForTimeout(500);

        await expect(page.locator(".b3-dialog--open")).toHaveCount(0, {timeout: 5000});
    });
});
