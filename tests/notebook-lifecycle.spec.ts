import {expect, test} from "./fixtures";
import {openWorkspace, showFileTree} from "./helpers/runtime";
import {getDocumentEditor, TEMP_TEST_NOTEBOOK_PREFIX} from "./helpers/testNotebook";

test.describe("notebook lifecycle", () => {
    test("creates and renames a notebook with persisted navigation state", async ({
        createTestNotebook,
        page,
        siyuanAPI,
    }) => {
        const notebook = await createTestNotebook("Rename");
        await openWorkspace(page);
        const restoreFileTree = await showFileTree(page);
        try {
            const notebookRoot = page.locator(
                `ul.b3-list[data-url="${notebook.id}"] > li[data-type="navigation-root"]`,
            );
            await expect(notebookRoot).toBeVisible({timeout: 15000});
            await expect(notebookRoot.locator(":scope > .b3-list-item__text")).toHaveText(notebook.name);

            const renamed = `${TEMP_TEST_NOTEBOOK_PREFIX} Renamed ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            await siyuanAPI.renameNotebook(notebook.id, renamed);
            await expect.poll(async () => (await siyuanAPI.listNotebooks()).find(
                item => item.id === notebook.id,
            )?.name).toBe(renamed);
            await expect(notebookRoot.locator(":scope > .b3-list-item__text")).toHaveText(renamed);

            await page.reload();
            const reloadedRoot = page.locator(
                `ul.b3-list[data-url="${notebook.id}"] > li[data-type="navigation-root"]`,
            );
            await expect(reloadedRoot.locator(":scope > .b3-list-item__text")).toHaveText(renamed);
        } finally {
            await restoreFileTree();
        }
    });

    test("closes and reopens a notebook without losing its document", async ({
        createTestNotebook,
        page,
        siyuanAPI,
    }) => {
        const notebook = await createTestNotebook("Reopen");
        const marker = `Notebook reopen ${Date.now()}`;
        const docID = await siyuanAPI.createDocument(notebook.id, "Notebook Reopen Document", marker);
        await openWorkspace(page, `/?id=${docID}`);
        await expect(await getDocumentEditor(page, docID)).toContainText(marker);

        await page.goto("about:blank");
        await siyuanAPI.closeNotebook(notebook.id);
        await expect.poll(async () => (await siyuanAPI.listNotebooks()).find(
            item => item.id === notebook.id,
        )?.closed).toBe(true);

        await siyuanAPI.openNotebook(notebook.id);
        await expect.poll(async () => (await siyuanAPI.listNotebooks()).find(
            item => item.id === notebook.id,
        )?.closed).toBe(false);
        await expect.poll(async () => (await siyuanAPI.findDocumentPath(docID))?.notebook, {
            timeout: 30000,
        }).toBe(notebook.id);
        await openWorkspace(page, `/?id=${docID}`);
        await expect(await getDocumentEditor(page, docID)).toContainText(marker);
        expect((await siyuanAPI.getDocumentPath(docID)).notebook).toBe(notebook.id);
    });

    test("removes a notebook and its indexed documents", async ({
        createTestNotebook,
        page,
        siyuanAPI,
    }) => {
        const notebook = await createTestNotebook("Remove");
        const docID = await siyuanAPI.createDocument(notebook.id, "Notebook Removal Document", "Removed with notebook");
        await expect.poll(async () => (await siyuanAPI.findDocumentPath(docID))?.notebook).toBe(notebook.id);

        await page.goto("about:blank");
        await siyuanAPI.removeNotebook(notebook.id);
        await expect.poll(async () => (await siyuanAPI.listNotebooks()).some(
            item => item.id === notebook.id,
        ), {timeout: 30000}).toBe(false);
        await expect.poll(() => siyuanAPI.findDocumentPath(docID), {timeout: 30000}).toBeUndefined();
    });
});
