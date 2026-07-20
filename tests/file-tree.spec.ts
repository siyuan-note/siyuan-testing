import {expect, test} from "@playwright/test";
import {createTestDocument} from "./helpers/testNotebook";

test.describe("file tree", () => {
    test("navigate to a document", async ({page}) => {
        const {docID} = await createTestDocument(page, "Tree Navigate Test");

        const docItem = page.locator(`li.b3-list-item[data-type="navigation-file"][data-node-id="${docID}"]`);
        await expect(docItem).toBeVisible({timeout: 10000});
        await docItem.click({force: true});
        await page.waitForTimeout(1500);

        await expect(page.locator(".protyle-wysiwyg").first()).toBeTruthy();
        await expect(page.locator(".protyle-breadcrumb").first()).toBeTruthy();
    });
});
