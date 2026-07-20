import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";

test.describe("file tree", () => {
    test("navigates to the selected document", async ({page, createTestDocument}) => {
        const firstDocument = await createTestDocument("Tree Navigate Target");
        await createTestDocument("Tree Navigate Origin");

        const docItem = page.locator(
            `li.b3-list-item[data-type="navigation-file"][data-node-id="${firstDocument.docID}"]`,
        );
        if (!await docItem.isVisible()) {
            const notebookRoot = page.locator(
                `ul.b3-list[data-url="${firstDocument.notebookID}"] > li[data-type="navigation-root"]`,
            );
            await expect(notebookRoot).toBeVisible();
            if (!await notebookRoot.locator(":scope > .b3-list-item__toggle .b3-list-item__arrow--open").isVisible()) {
                await notebookRoot.locator(":scope > .b3-list-item__toggle").click({force: true});
            }
        }
        await expect(docItem).toBeVisible({timeout: 10000});
        await docItem.click({force: true});

        await expect(page.locator(`.protyle-title[data-node-id="${firstDocument.docID}"]`)).toBeVisible();
        await expect(await getDocumentEditor(page, firstDocument.docID)).toBeVisible();
        await expect(page.locator(`.protyle-breadcrumb__item[data-node-id="${firstDocument.docID}"]`).last())
            .toBeVisible();
    });
});
