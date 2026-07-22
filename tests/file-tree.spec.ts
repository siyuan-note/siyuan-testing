import {expect, test} from "./fixtures";
import {openWorkspace, showFileTree} from "./helpers/runtime";
import {getDocumentEditor} from "./helpers/testNotebook";

test.describe("file tree", () => {
    test("navigates to the selected document", async ({page, createTestDocument}) => {
        const firstDocument = await createTestDocument("Tree Navigate Target");
        await createTestDocument("Tree Navigate Origin");
        const restoreFileTree = await showFileTree(page);
        try {
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
        } finally {
            await restoreFileTree();
        }
    });

    test("moves a nested document subtree and restores its hierarchy after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const firstParent = await createTestDocument("Tree Subtree First Parent");
        const secondParent = await createTestDocument("Tree Subtree Second Parent");
        const child = await createTestDocument("Tree Subtree Child");
        const marker = `Nested subtree ${Date.now()}`;
        const grandchild = await createTestDocument("Tree Subtree Grandchild", marker);

        await siyuanAPI.moveDocuments([child.docID], firstParent.docID);
        await siyuanAPI.moveDocuments([grandchild.docID], child.docID);
        await expect.poll(async () => (await siyuanAPI.getDocumentPath(grandchild.docID)).path, {
            timeout: 30000,
        }).toBe(`/${firstParent.docID}/${child.docID}/${grandchild.docID}.sy`);

        await siyuanAPI.moveDocuments([child.docID], secondParent.docID);
        await expect.poll(async () => (await siyuanAPI.getDocumentPath(child.docID)).path, {
            timeout: 30000,
        }).toBe(`/${secondParent.docID}/${child.docID}.sy`);
        await expect.poll(async () => (await siyuanAPI.getDocumentPath(grandchild.docID)).path, {
            timeout: 30000,
        }).toBe(`/${secondParent.docID}/${child.docID}/${grandchild.docID}.sy`);
        expect((await siyuanAPI.listDocuments(child.notebookID)).find(
            item => item.id === firstParent.docID,
        )?.subFileCount).toBe(0);
        expect((await siyuanAPI.listDocuments(child.notebookID, `/${secondParent.docID}`)).map(
            item => item.id,
        )).toContain(child.docID);

        await openWorkspace(page, `/?id=${grandchild.docID}`);
        await expect(await getDocumentEditor(page, grandchild.docID)).toContainText(marker);
        const restoreFileTree = await showFileTree(page);
        try {
            await assertNestedTree(page, secondParent.docID, child.docID, grandchild.docID);

            await page.reload();
            await expect(await getDocumentEditor(page, grandchild.docID)).toContainText(marker);
            await assertNestedTree(page, secondParent.docID, child.docID, grandchild.docID);
        } finally {
            await restoreFileTree();
        }
    });

    test("persists a custom document order in an isolated notebook", async ({
        createTestNotebook,
        page,
        siyuanAPI,
    }) => {
        const notebook = await createTestNotebook("Custom Sort");
        const firstID = await siyuanAPI.createDocument(notebook.id, "Custom Sort First");
        const secondID = await siyuanAPI.createDocument(notebook.id, "Custom Sort Second");
        const thirdID = await siyuanAPI.createDocument(notebook.id, "Custom Sort Third");
        const expectedOrder = [thirdID, firstID, secondID];

        const notebookConf = await siyuanAPI.getNotebookConf(notebook.id);
        await siyuanAPI.setNotebookConf(notebook.id, {...notebookConf.conf, sortMode: 6});
        await siyuanAPI.changeFileTreeSort(notebook.id, expectedOrder.map(id => `/${id}.sy`));
        await expect.poll(async () => (await siyuanAPI.listDocuments(notebook.id)).map(
            item => item.id,
        )).toEqual(expectedOrder);

        await openWorkspace(page);
        const restoreFileTree = await showFileTree(page);
        try {
            await expectFileTreeOrder(page, notebook.id, expectedOrder);
            await page.reload();
            await expectFileTreeOrder(page, notebook.id, expectedOrder);
            expect((await siyuanAPI.getNotebookConf(notebook.id)).conf.sortMode).toBe(6);
        } finally {
            await restoreFileTree();
        }
    });
});

const assertNestedTree = async (page: import("@playwright/test").Page, parentID: string, childID: string,
                                grandchildID: string) => {
    const parent = page.locator(`li[data-type="navigation-file"][data-node-id="${parentID}"]`);
    await expect(parent).toBeVisible({timeout: 15000});
    await expandTreeItem(parent);
    const child = parent.locator(
        `xpath=following-sibling::ul[1]/li[@data-type="navigation-file" and @data-node-id="${childID}"]`,
    );
    await expect(child).toBeVisible({timeout: 15000});
    await expandTreeItem(child);
    await expect(child.locator(
        `xpath=following-sibling::ul[1]/li[@data-type="navigation-file" and @data-node-id="${grandchildID}"]`,
    )).toBeVisible({timeout: 15000});
};

const expandTreeItem = async (item: import("@playwright/test").Locator) => {
    const arrow = item.locator(":scope > .b3-list-item__toggle .b3-list-item__arrow");
    await expect(arrow).toBeVisible({timeout: 15000});
    await expect.poll(async () => {
        if (await arrow.evaluate(element => element.classList.contains("b3-list-item__arrow--open"))) {
            return true;
        }
        await item.locator(":scope > .b3-list-item__toggle").click({force: true});
        return arrow.evaluate(element => element.classList.contains("b3-list-item__arrow--open"));
    }, {timeout: 10000}).toBe(true);
};

const expectFileTreeOrder = async (page: import("@playwright/test").Page, notebookID: string,
                                  expectedOrder: string[]) => {
    const notebookRoot = page.locator(
        `ul.b3-list[data-url="${notebookID}"] > li[data-type="navigation-root"]`,
    );
    await expect(notebookRoot).toBeVisible({timeout: 15000});
    await expandTreeItem(notebookRoot);
    const documentList = notebookRoot.locator("xpath=following-sibling::ul[1]");
    await expect(documentList.locator(":scope > li[data-type=\"navigation-file\"]")).toHaveCount(expectedOrder.length);
    await expect.poll(() => documentList.locator(":scope > li[data-type=\"navigation-file\"]").evaluateAll(
        items => items.map(item => item.getAttribute("data-node-id")),
    )).toEqual(expectedOrder);
};
