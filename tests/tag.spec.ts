import {expect, test} from "./fixtures";
import {showDock} from "./helpers/runtime";
import {ISiyuanResponse, ISearchResult} from "./helpers/siyuanAPI";
import {getDocumentEditor} from "./helpers/testNotebook";

interface ISyNode {
    Children?: ISyNode[];
    TextMarkTextContent?: string;
    TextMarkType?: string;
    Type: string;
}

const flattenNodes = (root: ISyNode) => {
    const nodes: ISyNode[] = [];
    const visit = (node: ISyNode) => {
        nodes.push(node);
        node.Children?.forEach(visit);
    };
    visit(root);
    return nodes;
};

const persistedTags = (root: ISyNode) => flattenNodes(root).filter(node =>
    node.Type === "NodeTextMark" && node.TextMarkType?.split(" ").includes("tag"),
).map(node => node.TextMarkTextContent || "");

const includesSearchTag = (values: string[], label: string) => values.some(value =>
    value.replace(/<[^>]+>/g, "") === label,
);

test.describe("tags", () => {
    test("renames, searches, navigates, and removes a persisted tag", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
        const originalTag = `E2ETag${suffix}`;
        const renamedTag = `E2ERenamedTag${suffix}`;
        const marker = `Tagged content ${suffix}`;
        const document = await createTestDocument("Tag Lifecycle", `${marker} #${originalTag}#`);
        const restoreDockVisibility = await showDock(page);
        const dockItem = page.locator('.dock__item[data-type="tag"]').first();

        try {
            let editor = document.editor;
            const editorTag = editor.locator('span[data-type~="tag"]');
            await expect(editorTag).toHaveText(originalTag);
            await expect.poll(async () => includesSearchTag(
                (await siyuanAPI.searchTags(originalTag)).tags,
                originalTag,
            ), {timeout: 30000}).toBe(true);
            await expect.poll(async () => persistedTags(await siyuanAPI.readDocument<ISyNode>(document.docID)), {
                timeout: 30000,
            })
                .toContain(originalTag);

            await page.reload();
            editor = await getDocumentEditor(page, document.docID);
            await expect(editor.locator('span[data-type~="tag"]')).toHaveText(originalTag);

            const tagPanel = page.locator(".sy__tag:visible").last();
            if (!await tagPanel.isVisible()) {
                if (await dockItem.evaluate(element => element.classList.contains("dock__item--active"))) {
                    await dockItem.click();
                }
                await dockItem.click();
            }
            await expect(tagPanel).toBeVisible();
            const originalNode = tagPanel.locator(`li[data-treetype="tag"][data-label="${originalTag}"]`);
            await expect(originalNode).toBeVisible({timeout: 15000});

            await openTagMenuItem(page, originalNode, "#iconEdit");
            const renameDialog = page.locator('[data-key="dialog-renametag"].b3-dialog--open').last();
            const renameInput = renameDialog.locator("input");
            await expect(renameInput).toBeVisible();
            await renameInput.fill(renamedTag);
            await renameInput.press("Escape");
            const renameResponse = page.waitForResponse(response =>
                response.url().endsWith("/api/tag/renameTag") && response.request().method() === "POST");
            await renameInput.press("Enter");
            expect((await renameResponse).ok()).toBe(true);

            await expect.poll(async () => includesSearchTag(
                (await siyuanAPI.searchTags(renamedTag)).tags,
                renamedTag,
            ), {timeout: 30000}).toBe(true);
            await expect.poll(async () => includesSearchTag(
                (await siyuanAPI.searchTags(originalTag)).tags,
                originalTag,
            ), {timeout: 30000}).toBe(false);
            await expect.poll(async () => persistedTags(await siyuanAPI.readDocument<ISyNode>(document.docID)), {
                timeout: 30000,
            })
                .toContain(renamedTag);
            const renamedNode = tagPanel.locator(`li[data-treetype="tag"][data-label="${renamedTag}"]`);
            await expect(renamedNode).toBeVisible({timeout: 15000});
            await expect(editor.locator('span[data-type~="tag"]')).toHaveText(renamedTag);

            const searchResponse = page.waitForResponse(response => {
                if (!response.url().endsWith("/api/search/fullTextSearchBlock")) {
                    return false;
                }
                return response.request().postDataJSON().query === `#${renamedTag}#`;
            });
            await renamedNode.locator(":scope > .b3-list-item__text").click();
            const searchResult = await (await searchResponse).json() as ISiyuanResponse<ISearchResult>;
            expect(searchResult.code).toBe(0);
            expect(searchResult.data.blocks.some(block => block.rootID === document.docID)).toBe(true);
            const searchInput = page.locator("#searchInput:visible").last();
            await expect(searchInput).toHaveValue(`#${renamedTag}#`);
            const resultItem = page.locator(
                `#searchList:visible [data-type="search-item"][data-root-id="${document.docID}"]`,
            ).first();
            await expect(resultItem).toBeVisible();
            const resultBlockID = await resultItem.getAttribute("data-node-id");
            expect(resultBlockID).not.toBeNull();
            await resultItem.dblclick();
            await expect(page.locator(`.protyle-title[data-node-id="${document.docID}"]:visible`).last()).toBeVisible();
            await expect(page.locator(`.protyle-wysiwyg [data-node-id="${resultBlockID}"]:visible`)).toBeVisible();
            editor = await getDocumentEditor(page, document.docID);

            await openTagMenuItem(page, renamedNode, "#iconTrashcan");
            const confirmButton = page.locator("#confirmDialogConfirmBtn:visible");
            await expect(confirmButton).toBeVisible();
            const removeResponse = page.waitForResponse(response =>
                response.url().endsWith("/api/tag/removeTag") && response.request().method() === "POST");
            await confirmButton.click();
            expect((await removeResponse).ok()).toBe(true);

            await expect.poll(async () => includesSearchTag(
                (await siyuanAPI.searchTags(renamedTag)).tags,
                renamedTag,
            ), {timeout: 15000}).toBe(false);
            await expect.poll(async () => persistedTags(await siyuanAPI.readDocument<ISyNode>(document.docID)), {
                timeout: 15000,
            }).not.toContain(renamedTag);
            await expect(renamedNode).toHaveCount(0);
            await expect(editor.locator('span[data-type~="tag"]')).toHaveCount(0);
            await expect(editor).toContainText(marker);

            await page.reload();
            editor = await getDocumentEditor(page, document.docID);
            await expect(editor.locator('span[data-type~="tag"]')).toHaveCount(0);
            await expect(editor).toContainText(marker);
        } finally {
            if (!page.isClosed()) {
                try {
                    await closeSearchTab(page, `#${renamedTag}#`);
                    await activateFileTree(page);
                } finally {
                    await restoreDockVisibility();
                }
            }
        }
    });
});

const openTagMenuItem = async (page: import("@playwright/test").Page, node: import("@playwright/test").Locator,
                               icon: string) => {
    await node.hover();
    await node.locator(":scope > .b3-list-item__action").click({force: true});
    const items = page.locator(".b3-menu:not(.fn__none) .b3-menu__item");
    for (let index = 0; index < await items.count(); index++) {
        const item = items.nth(index);
        const use = item.locator("use").first();
        if (await use.count() === 0) {
            continue;
        }
        const itemIcon = await use.evaluate(element =>
            element.getAttribute("href") || element.getAttribute("xlink:href") || "");
        if (itemIcon === icon) {
            await item.click();
            return;
        }
    }
    throw new Error(`tag menu item ${icon} not found`);
};

const closeSearchTab = async (page: import("@playwright/test").Page, query: string) => {
    const panelIDs = await page.locator("#searchInput").evaluateAll((elements, expectedQuery) => elements
        .filter(element => (element as HTMLInputElement).value === expectedQuery)
        .map(element => element.closest<HTMLElement>("[data-id]")?.dataset.id)
        .filter((id): id is string => Boolean(id)), query);
    for (const panelID of panelIDs) {
        const tabHeader = page.locator(`li[data-type="tab-header"][data-id="${panelID}"]`);
        if (await tabHeader.count() > 0) {
            const layoutResponse = page.waitForResponse(response =>
                response.url().endsWith("/api/system/setUILayout") && response.request().method() === "POST");
            await tabHeader.locator(".item__close").click({force: true});
            await expect(tabHeader).toHaveCount(0);
            expect((await layoutResponse).ok()).toBe(true);
        }
    }
};

const activateFileTree = async (page: import("@playwright/test").Page) => {
    const tagDockItem = page.locator('.dock__item[data-type="tag"]').first();
    if (await tagDockItem.evaluate(element => element.classList.contains("dock__item--active"))) {
        const layoutResponse = page.waitForResponse(response =>
            response.url().endsWith("/api/system/setUILayout") && response.request().method() === "POST");
        await tagDockItem.click();
        expect((await layoutResponse).ok()).toBe(true);
    }
    const dockItem = page.locator('.dock__item[data-type="file"]').first();
    if (!await page.locator(".sy__file .block__logo:visible").isVisible()) {
        const layoutResponse = page.waitForResponse(response =>
            response.url().endsWith("/api/system/setUILayout") && response.request().method() === "POST");
        if (await dockItem.evaluate(element => element.classList.contains("dock__item--active"))) {
            await dockItem.click();
        }
        await dockItem.click();
        expect((await layoutResponse).ok()).toBe(true);
    }
    await expect(page.locator(".sy__file .block__logo:visible")).toBeVisible();
};
