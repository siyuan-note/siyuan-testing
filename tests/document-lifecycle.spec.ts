import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";
import {openWorkspace, showFileTree} from "./helpers/runtime";

interface ISyDocument {
    ID: string;
    Properties: Record<string, string>;
}

test.describe("document lifecycle", () => {
    test("creates a document with persisted content", async ({page, createTestDocument, siyuanAPI}) => {
        const marker = `Lifecycle created ${Date.now()}`;
        const document = await createTestDocument("Lifecycle Create", marker);

        await expect(document.editor).toContainText(marker);
        await expect.poll(async () => {
            const entries = await siyuanAPI.listDocuments(document.notebookID);
            return entries.find(item => item.id === document.docID);
        }).toMatchObject({
            id: document.docID,
            name: document.title,
            path: `/${document.docID}.sy`,
        });

        const persisted = await siyuanAPI.readDocument<ISyDocument>(document.docID);
        expect(persisted.ID).toBe(document.docID);
        expect(persisted.Properties).toMatchObject({id: document.docID, title: document.title});

        await page.reload();
        await expect(await getDocumentEditor(page, document.docID)).toContainText(marker);
    });

    test("renames a document and persists its title", async ({page, createTestDocument, siyuanAPI}) => {
        const document = await createTestDocument("Lifecycle Rename");
        const renamedTitle = `Lifecycle Renamed ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        await siyuanAPI.renameDocument(document.docID, renamedTitle);
        await expect.poll(async () => {
            const entries = await siyuanAPI.listDocuments(document.notebookID);
            return entries.find(item => item.id === document.docID)?.name;
        }).toBe(renamedTitle);
        await expect.poll(async () => {
            const persisted = await siyuanAPI.readDocument<ISyDocument>(document.docID);
            return persisted.Properties.title;
        }).toBe(renamedTitle);

        await openWorkspace(page, `/?id=${document.docID}`);
        await expect(page.locator(`.protyle-title[data-node-id="${document.docID}"]`)).toHaveText(renamedTitle);
    });

    test("moves a document below another document", async ({page, createTestDocument, siyuanAPI}) => {
        const parent = await createTestDocument("Lifecycle Move Parent");
        const child = await createTestDocument("Lifecycle Move Child", "Moved child content");
        const expectedPath = `/${parent.docID}/${child.docID}.sy`;

        await siyuanAPI.moveDocuments([child.docID], parent.docID);
        await expect.poll(async () => (await siyuanAPI.getDocumentPath(child.docID)).path, {
            timeout: 30000,
        }).toBe(expectedPath);
        await expect.poll(async () => {
            const entries = await siyuanAPI.listDocuments(child.notebookID, `/${parent.docID}`);
            return entries.map(item => item.id);
        }).toContain(child.docID);
        await expect.poll(async () => {
            const entries = await siyuanAPI.listAllDocuments(child.notebookID);
            return entries.map(item => item.id);
        }).toEqual(expect.arrayContaining([parent.docID, child.docID]));

        await openWorkspace(page, `/?id=${child.docID}`);
        await expect(await getDocumentEditor(page, child.docID)).toContainText("Moved child content");
        const restoreFileTree = await showFileTree(page);
        try {
            const parentItem = page.locator(
                `li[data-type="navigation-file"][data-node-id="${parent.docID}"]`,
            );
            await expect(parentItem).toBeVisible({timeout: 15000});
            const parentArrow = parentItem.locator(":scope > .b3-list-item__toggle .b3-list-item__arrow");
            if (!await parentArrow.evaluate(element => element.classList.contains("b3-list-item__arrow--open"))) {
                await parentItem.locator(":scope > .b3-list-item__toggle").click({force: true});
            }
            await expect(parentItem.locator(
                `xpath=following-sibling::ul[1]/li[@data-type="navigation-file" and @data-node-id="${child.docID}"]`,
            )).toBeVisible({timeout: 15000});
        } finally {
            await restoreFileTree();
        }
    });

    test("duplicates a document with independent persisted IDs", async ({
        page,
        createTestDocument,
        siyuanAPI,
        trackTestDocument,
    }) => {
        const marker = `Duplicated content ${Date.now()}`;
        const source = await createTestDocument("Lifecycle Duplicate", marker);

        const duplicate = await siyuanAPI.duplicateDocument(source.docID);
        trackTestDocument({id: duplicate.id, notebookID: duplicate.notebook, title: duplicate.hPath});
        expect(duplicate.id).not.toBe(source.docID);
        expect(duplicate.notebook).toBe(source.notebookID);
        expect(duplicate.path).toBe(`/${duplicate.id}.sy`);

        await expect.poll(async () => {
            const entries = await siyuanAPI.listDocuments(source.notebookID);
            return entries.map(item => item.id);
        }).toContain(duplicate.id);
        const persisted = await siyuanAPI.readDocument<ISyDocument>(duplicate.id);
        expect(persisted.ID).toBe(duplicate.id);
        expect(persisted.Properties.id).toBe(duplicate.id);
        expect(persisted.Properties.title).toContain(source.title);

        await openWorkspace(page, `/?id=${duplicate.id}`);
        await expect(await getDocumentEditor(page, duplicate.id)).toContainText(marker);
    });

    test("restores a deleted document from its generated history", async ({page, createTestDocument, siyuanAPI}) => {
        const marker = `Restored content ${Date.now()}`;
        const document = await createTestDocument("Lifecycle Restore", marker);

        await siyuanAPI.removeDocument(document.docID);
        await expect.poll(async () => {
            const entries = await siyuanAPI.listDocuments(document.notebookID);
            return entries.some(item => item.id === document.docID);
        }).toBe(false);

        let historyCreated = "";
        await expect.poll(async () => {
            const history = await siyuanAPI.searchDocumentHistory(document.docID, document.notebookID, "delete");
            historyCreated = history.histories[0] || "";
            return historyCreated;
        }, {timeout: 15000}).not.toBe("");
        const historyItems = await siyuanAPI.getDocumentHistoryItems(document.docID, historyCreated, "delete");
        const deletedDocument = historyItems.find(item => item.path.endsWith(`/${document.docID}.sy`));
        expect(deletedDocument).toMatchObject({
            title: document.title,
            op: "delete",
            notebook: document.notebookID,
        });

        await siyuanAPI.rollbackDocumentHistory(deletedDocument!.path);
        await expect.poll(async () => (await siyuanAPI.getDocumentPath(document.docID)).path, {
            timeout: 15000,
        }).toBe(`/${document.docID}.sy`);
        const restored = await siyuanAPI.readDocument<ISyDocument>(document.docID);
        expect(restored.Properties.title).toBe(document.title);

        await openWorkspace(page, `/?id=${document.docID}`);
        await expect(await getDocumentEditor(page, document.docID)).toContainText(marker);
    });
});
