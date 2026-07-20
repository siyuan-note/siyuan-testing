import {expect, test} from "./fixtures";
import {createTestDocument} from "./helpers/testNotebook";

test.describe("editor", () => {
    test.describe.configure({mode: "parallel"});

    test("create doc and type", async ({page}) => {
        const {docID, title} = await createTestDocument(page, "E2E Test Doc");

        await page.evaluate(() => {
            const editors = document.querySelectorAll(".protyle-wysiwyg");
            (editors[editors.length - 1] as HTMLElement)?.click();
            (editors[editors.length - 1] as HTMLElement)?.focus();
        });
        await page.waitForTimeout(500);
        await page.locator(".protyle-wysiwyg").last().waitFor({state: "attached", timeout: 10000});
        await page.locator(".protyle-wysiwyg").last().pressSequentially("## Hello Heading");
        await page.keyboard.press("Enter");
        await page.locator(".protyle-wysiwyg").last().pressSequentially("This is a test paragraph.");
        await page.keyboard.press("Enter");
        await page.locator(".protyle-wysiwyg").last().pressSequentially("- list item 1");
        await page.keyboard.press("Enter");
        await page.locator(".protyle-wysiwyg").last().pressSequentially("list item 2");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1000);

        await expect(page.locator(".protyle-breadcrumb").first()).toBeTruthy();

        await page.waitForTimeout(5000);

        await page.locator("#barSearch").click();
        await page.waitForTimeout(1500);

        await page.locator(".b3-dialog--open #searchInput").first().fill(title);

        await expect(page.locator(".b3-dialog--open .search__list").first()).toBeTruthy();
        await expect(page.locator(`.b3-dialog--open .search__list .b3-list-item[data-node-id="${docID}"]`))
            .toBeVisible({timeout: 15000});
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
    });

    test("heading fold unfold", async ({page}) => {
        await createTestDocument(page, "Fold E2E Test");

        await page.evaluate(() => {
            const editors = document.querySelectorAll(".protyle-wysiwyg");
            (editors[editors.length - 1] as HTMLElement)?.click();
            (editors[editors.length - 1] as HTMLElement)?.focus();
        });
        await page.waitForTimeout(500);
        await page.locator(".protyle-wysiwyg").last().waitFor({state: "attached", timeout: 10000});
        await page.locator(".protyle-wysiwyg").last().pressSequentially("## Fold Me");
        await page.keyboard.press("Enter");
        await page.locator(".protyle-wysiwyg").last().pressSequentially("sub content under heading");
        await page.keyboard.press("Enter");
        await page.locator(".protyle-wysiwyg").last().pressSequentially("more sub content");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1000);

        await page.locator(".protyle-breadcrumb__item").last().click();
        await page.waitForTimeout(500);

        await page.locator('[data-type="NodeHeading"]').last().click();
        await page.waitForTimeout(300);

        await page.keyboard.press("Control+ArrowUp");
        await page.waitForTimeout(1000);

        await page.keyboard.press("Control+ArrowUp");
        await page.waitForTimeout(500);

        await expect(page.locator('[data-type="NodeHeading"]').first()).toBeTruthy();
    });

    test("undo and redo", async ({page}) => {
        await createTestDocument(page, "Undo Test");

        await page.evaluate(() => {
            const editors = document.querySelectorAll(".protyle-wysiwyg");
            (editors[editors.length - 1] as HTMLElement)?.click();
            (editors[editors.length - 1] as HTMLElement)?.focus();
        });
        await page.waitForTimeout(500);
        await page.locator(".protyle-wysiwyg").last().waitFor({state: "attached", timeout: 10000});
        await page.locator(".protyle-wysiwyg").last().pressSequentially("This will be undone.");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(500);

        await page.keyboard.press("Control+Z");
        await page.waitForTimeout(800);

        await page.keyboard.press("Control+Shift+Z");
        await page.waitForTimeout(500);

        await expect(page.locator(".protyle-wysiwyg").first()).toBeTruthy();
    });

    test("code block", async ({page}) => {
        await createTestDocument(page, "Code Block Test");

        await page.evaluate(() => {
            const editors = document.querySelectorAll(".protyle-wysiwyg");
            (editors[editors.length - 1] as HTMLElement)?.click();
            (editors[editors.length - 1] as HTMLElement)?.focus();
        });
        await page.waitForTimeout(500);
        await page.locator(".protyle-wysiwyg").last().waitFor({state: "attached", timeout: 10000});
        await page.locator(".protyle-wysiwyg").last().pressSequentially("```js");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(800);

        await page.locator(".protyle-wysiwyg").last().pressSequentially("console.log('hello')");
        await page.waitForTimeout(500);

        await expect(page.locator('[data-type="NodeCodeBlock"], .code-block').first()).toBeTruthy();
    });

});
