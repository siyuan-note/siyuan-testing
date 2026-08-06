import {ElementHandle, JSHandle, Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openWorkspace, showFileTree} from "./helpers/runtime";
import {expectSearchIndex, submitSearch, withKeywordSearch} from "./helpers/search";
import {IBacklinkPath} from "./helpers/siyuanAPI";
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
        } finally {
            await restoreFileTree();
        }

        await page.reload();
        await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
        const restoreReloadedFileTree = await showFileTree(page);
        try {
            await expectFileTreeOrder(page, notebook.id, expectedOrder);
            expect((await siyuanAPI.getNotebookConf(notebook.id)).conf.sortMode).toBe(6);
        } finally {
            await restoreReloadedFileTree();
        }
    });

    test("moves a subtree through the file tree while preserving indexed navigation data", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        test.slow();
        const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
        const marker = `TreeIndexedMarker${suffix}`;
        const tag = `TreeIndexedTag${suffix}`;
        const bookmark = `TreeIndexedBookmark${suffix}`;
        const referenceTarget = await createTestDocument("Tree Indexed Reference Target", "Reference target");
        const firstParent = await createTestDocument("Tree Indexed First Parent");
        const secondParent = await createTestDocument("Tree Indexed Second Parent");
        const child = await createTestDocument(
            "Tree Indexed Child",
            `${marker} #${tag}#\n\n((${referenceTarget.docID} "${referenceTarget.title}"))`,
        );
        const childBlock = child.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const childBlockID = await childBlock.getAttribute("data-node-id");
        expect(childBlockID).toBeTruthy();
        await siyuanAPI.setBlockAttrs(childBlockID!, {bookmark});
        const grandchild = await createTestDocument("Tree Indexed Grandchild", `Grandchild ${suffix}`);

        await siyuanAPI.moveDocuments([child.docID], firstParent.docID);
        await siyuanAPI.moveDocuments([grandchild.docID], child.docID);
        await expect.poll(async () => (await siyuanAPI.getDocumentPath(grandchild.docID)).path, {
            timeout: 30000,
        }).toBe(`/${firstParent.docID}/${child.docID}/${grandchild.docID}.sy`);
        await expectSearchIndex(siyuanAPI, marker, child.docID);
        await expect.poll(async () => includesSearchTag((await siyuanAPI.searchTags(tag)).tags, tag), {
            timeout: 30000,
        }).toBe(true);
        await expect.poll(async () => (await siyuanAPI.getBookmarks()).find(
            item => item.name === bookmark,
        )?.blocks.some(block => block.id === childBlockID), {timeout: 30000}).toBe(true);
        await expect.poll(async () => findBacklink(await siyuanAPI.getBacklinks(referenceTarget.docID), child.docID)
            ?.hPath || "", {timeout: 30000}).toContain(firstParent.title);

        await openWorkspace(page, `/?id=${child.docID}`);
        const restoreFileTree = await showFileTree(page);
        try {
            await assertNestedTree(page, firstParent.docID, child.docID, grandchild.docID, child.notebookID);
            const source = page.locator(
                `li[data-type="navigation-file"][data-node-id="${child.docID}"]`,
            );
            const target = page.locator(
                `li[data-type="navigation-file"][data-node-id="${secondParent.docID}"]`,
            );
            await dragDocumentInto(page, source, target);

            await expect.poll(async () => (await siyuanAPI.getDocumentPath(child.docID)).path, {
                timeout: 30000,
            }).toBe(`/${secondParent.docID}/${child.docID}.sy`);
            await expect.poll(async () => (await siyuanAPI.getDocumentPath(grandchild.docID)).path, {
                timeout: 30000,
            }).toBe(`/${secondParent.docID}/${child.docID}/${grandchild.docID}.sy`);
            await assertNestedTree(page, secondParent.docID, child.docID, grandchild.docID, child.notebookID);

            await page.reload();
            await expect(await getDocumentEditor(page, child.docID)).toContainText(marker);
            await assertNestedTree(page, secondParent.docID, child.docID, grandchild.docID, child.notebookID);
        } finally {
            await restoreFileTree();
        }

        await expectSearchIndex(siyuanAPI, marker, child.docID);
        await expect.poll(async () => includesSearchTag((await siyuanAPI.searchTags(tag)).tags, tag), {
            timeout: 30000,
        }).toBe(true);
        await expect.poll(async () => (await siyuanAPI.getBookmarks()).find(
            item => item.name === bookmark,
        )?.blocks.some(block => block.id === childBlockID), {timeout: 30000}).toBe(true);
        await expect.poll(async () => findBacklink(await siyuanAPI.getBacklinks(referenceTarget.docID), child.docID)
            ?.hPath || "", {timeout: 30000}).toContain(secondParent.title);
        expect(findBacklink(await siyuanAPI.getBacklinks(referenceTarget.docID), child.docID)?.hPath)
            .not.toContain(firstParent.title);

        await withKeywordSearch(page, async (search) => {
            const response = await submitSearch(page, search, marker);
            expect(response.blocks.some(block =>
                block.rootID === child.docID && block.id === childBlockID)).toBe(true);
            const result = search.results.locator(
                `[data-type="search-item"][data-root-id="${child.docID}"][data-node-id="${childBlockID}"]`,
            );
            await expect(result).toBeVisible();
            await result.dblclick();
            await expect(search.dialog).toHaveCount(0);
            const editor = await getDocumentEditor(page, child.docID);
            await expect(editor.locator(`[data-node-id="${childBlockID}"]`)).toContainText(marker);
            await expect(editor.locator(`[data-node-id="${childBlockID}"] [data-type~="tag"]`)).toHaveText(tag);
            await expect(editor.locator(
                `[data-type~="block-ref"][data-id="${referenceTarget.docID}"]`,
            )).toBeVisible();
            await expect(editor.locator(`[data-node-id="${childBlockID}"]`)).toHaveAttribute("bookmark", bookmark);
        });
        await siyuanAPI.setBlockAttrs(childBlockID!, {bookmark: ""});
        await expect.poll(async () => (await siyuanAPI.getBookmarks()).some(
            item => item.name === bookmark,
        ), {timeout: 30000}).toBe(false);
    });
});

const assertNestedTree = async (page: import("@playwright/test").Page, parentID: string, childID: string,
                                grandchildID: string, notebookID?: string) => {
    if (notebookID) {
        const notebookRoot = page.locator(
            `ul.b3-list[data-url="${notebookID}"] > li[data-type="navigation-root"]`,
        );
        await expect(notebookRoot).toBeVisible({timeout: 15000});
        await expandTreeItem(notebookRoot);
    }
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

const dragDocumentInto = async (page: Page, source: Locator, target: Locator) => {
    await expect(source).toBeVisible({timeout: 15000});
    await expect(target).toBeVisible({timeout: 15000});
    const sourcePath = await source.getAttribute("data-path");
    const targetPath = await target.getAttribute("data-path");
    const sourceTitle = await source.locator(":scope > .b3-list-item__text").textContent();
    const targetTitle = await target.locator(":scope > .b3-list-item__text").textContent();
    expect(sourcePath).toBeTruthy();
    expect(targetPath).toBeTruthy();
    const endTarget = await source.elementHandle() as ElementHandle<HTMLElement>;
    expect(endTarget).not.toBeNull();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer()) as JSHandle<DataTransfer>;
    await source.dispatchEvent("dragstart", {dataTransfer});
    await expect.poll(() => dataTransfer.evaluate(transfer => Array.from(transfer.types).length))
        .toBeGreaterThan(0);
    const targetBox = await target.boundingBox();
    expect(targetBox).not.toBeNull();
    const point = {
        clientX: targetBox!.x + targetBox!.width / 2,
        clientY: targetBox!.y + targetBox!.height / 2,
    };
    // 在页面内同步测量并派发事件，避免测量与事件处理之间的布局漂移；文件树
    // 只在目标相同且纵坐标变化时重新判定插入位置，因此第二次 dragover 需与
    // 首次坐标不同（中心下方 4px，仍在目标的中间插入区内）
    await target.evaluate((element, dataTransfer) => {
        const rect = element.getBoundingClientRect();
        const center = {
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
        };
        element.dispatchEvent(new DragEvent("dragenter", {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            ...center,
        }));
        element.dispatchEvent(new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            ...center,
        }));
    }, dataTransfer);
    await nextAnimationFrame(page);
    await target.evaluate((element, dataTransfer) => {
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2 + 4,
        }));
    }, dataTransfer);
    await nextAnimationFrame(page);
    await expect(target).toHaveClass(/(^|\s)dragover(\s|$)/);
    const expectedTip = await page.evaluate(({sourceName, targetName}) => ({
        action: window.siyuan.languages.dragTipMoveChild.replace("${x}", targetName),
        title: sourceName,
    }), {
        sourceName: sourceTitle?.trim() || "",
        targetName: targetTitle?.trim() || "",
    });
    await expect(page.locator(".drag-tip__title")).toHaveText(expectedTip.title);
    await expect(page.locator(".drag-tip__action")).toHaveText(expectedTip.action);

    const moveResponse = page.waitForResponse(response => {
        if (!response.url().endsWith("/api/filetree/moveDocs") || response.request().method() !== "POST") {
            return false;
        }
        const payload = response.request().postDataJSON() as {fromPaths?: string[]; toPath?: string};
        return payload.fromPaths?.includes(sourcePath!) === true && payload.toPath === targetPath;
    }, {timeout: 30000});
    await target.dispatchEvent("drop", {dataTransfer, ...point});
    await endTarget.dispatchEvent("dragend", {dataTransfer});
    await dataTransfer.dispose();
    expect((await moveResponse).ok()).toBe(true);
};

const nextAnimationFrame = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
    requestAnimationFrame(() => resolve())));

const includesSearchTag = (values: string[], label: string) => values.some(value =>
    value.replace(/<[^>]+>/g, "") === label,
);

const findBacklink = (result: {backlinks: IBacklinkPath[]}, rootID: string) => {
    const paths = [...result.backlinks];
    while (paths.length > 0) {
        const path = paths.shift()!;
        if (path.id === rootID) {
            return path;
        }
        paths.push(...(path.children || []));
    }
    return undefined;
};
