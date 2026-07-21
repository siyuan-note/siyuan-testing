import {expect, test} from "./fixtures";
import {openWorkspace} from "./helpers/runtime";
import {getDocumentEditor} from "./helpers/testNotebook";

test.describe("document history", () => {
    test("previews and rolls back a document history snapshot", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const original = `History original ${Date.now()}`;
        const replacement = `History replacement ${Date.now()}`;
        const document = await createTestDocument("Document History E2E", original);
        const paragraph = document.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const paragraphID = await paragraph.getAttribute("data-node-id");
        expect(paragraphID).toBeTruthy();

        await siyuanAPI.createDocumentHistory(document.docID);
        let created = "";
        await expect.poll(async () => {
            const history = await siyuanAPI.searchDocumentHistory(document.docID, document.notebookID, "update");
            created = history.histories[0] || "";
            return created;
        }, {timeout: 15000}).not.toBe("");
        const historyItems = await siyuanAPI.getDocumentHistoryItems(document.docID, created, "update");
        const historyItem = historyItems.find(item => item.path.endsWith(`/${document.docID}.sy`));
        expect(historyItem).toMatchObject({
            notebook: document.notebookID,
            op: "update",
            title: document.title,
        });
        const historyContent = await siyuanAPI.getDocumentHistoryContent(historyItem!.path);
        expect(historyContent.rootID).toBe(document.docID);
        expect(historyContent.content).toContain(original);
        expect(historyContent.content).not.toContain(replacement);

        await siyuanAPI.updateBlock(paragraphID!, replacement);
        await expect(document.editor).toContainText(replacement);
        await expect(document.editor).not.toContainText(original);

        const protyle = document.editor.locator(
            "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle ')][1]",
        );
        await protyle.locator(".protyle-title__icon").click();
        const historyMenuItem = page.locator('#commonMenu:not(.fn__none) [data-id="fileHistory"]');
        await expect(historyMenuItem).toBeVisible();
        await historyMenuItem.click();

        const historyDialog = page.locator('[data-key="dialog-historydoc"]');
        const snapshot = historyDialog.locator(`.history__side .b3-list-item[data-created="${created}"]`);
        await expect(snapshot).toBeVisible({timeout: 15000});
        await snapshot.click();
        const preview = historyDialog.locator('.history__text[data-type="docPanel"]');
        await expect(preview).toBeVisible({timeout: 15000});
        await expect(preview).toContainText(original);
        await expect(preview).not.toContainText(replacement);

        await snapshot.hover();
        const rollbackAction = snapshot.locator('[data-type="rollback"]');
        await expect(rollbackAction).toBeVisible();
        await rollbackAction.click();
        const confirmButton = page.locator("#confirmDialogConfirmBtn:visible");
        await expect(confirmButton).toBeVisible();
        const rollbackResponse = page.waitForResponse(response =>
            new URL(response.url()).pathname === "/api/history/rollbackDocHistory", {timeout: 15000});
        await confirmButton.click();
        expect((await rollbackResponse).ok()).toBe(true);

        await openWorkspace(page, `/?id=${document.docID}`);
        const restoredEditor = await getDocumentEditor(page, document.docID);
        await expect(restoredEditor).toContainText(original);
        await expect(restoredEditor).not.toContainText(replacement);
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument<unknown>(document.docID)), {
            timeout: 15000,
        }).toContain(original);
    });
});
