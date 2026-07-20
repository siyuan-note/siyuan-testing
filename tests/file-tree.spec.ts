import {expect, test} from "./fixtures";
import {createTestDocument} from "./helpers/testNotebook";

test.describe("file tree", () => {
    test("navigate to a document", async ({page}) => {
        const {docID, notebookID} = await createTestDocument(page, "Tree Navigate Test");

        const docItem = page.locator(`li.b3-list-item[data-type="navigation-file"][data-node-id="${docID}"]`);
        if (!await docItem.isVisible()) {
            const notebookRoot = page.locator(`ul.b3-list[data-url="${notebookID}"] > li[data-type="navigation-root"]`);
            await expect(notebookRoot).toBeVisible();
            if (!await notebookRoot.locator(":scope > .b3-list-item__toggle .b3-list-item__arrow--open").isVisible()) {
                await notebookRoot.locator(":scope > .b3-list-item__toggle").click({force: true});
            }
        }
        await expect(docItem).toBeVisible({timeout: 10000});
        await docItem.click({force: true});
        await page.waitForTimeout(1500);

        await expect(page.locator(".protyle-wysiwyg").first()).toBeTruthy();
        await expect(page.locator(".protyle-breadcrumb").first()).toBeTruthy();
    });
});
