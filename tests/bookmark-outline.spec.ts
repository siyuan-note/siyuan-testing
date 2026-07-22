import {expect, test} from "./fixtures";
import {showDock} from "./helpers/runtime";
import {IOutlineBlock, IOutlinePath} from "./helpers/siyuanAPI";
import {getDocumentEditor} from "./helpers/testNotebook";

test.describe("bookmarks and outline", () => {
    test("renames a bookmark, navigates to its block, and removes it", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
        const bookmark = `E2EBookmark${suffix}`;
        const renamed = `E2ERenamedBookmark${suffix}`;
        const marker = `Bookmarked block ${suffix}`;
        const target = await createTestDocument("Bookmark Target", marker);
        const targetBlock = target.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const targetBlockID = await targetBlock.getAttribute("data-node-id");
        expect(targetBlockID).not.toBeNull();
        await siyuanAPI.setBlockAttrs(targetBlockID!, {bookmark});
        await expect.poll(async () => (await siyuanAPI.getBlockAttrs(targetBlockID!)).bookmark).toBe(bookmark);
        await expect.poll(async () => (await siyuanAPI.getBookmarks()).find(
            item => item.name === bookmark,
        )?.blocks.some(block => block.id === targetBlockID)).toBe(true);

        const origin = await createTestDocument("Bookmark Navigation Origin", "Navigate away before opening bookmark");
        await expect(origin.editor).toBeVisible();
        const restoreDockVisibility = await showDock(page);
        const dockItem = page.locator('.dock__item[data-type="bookmark"]').first();
        const initiallyActive = await dockItem.evaluate(element => element.classList.contains("dock__item--active"));

        try {
            await activateDock(page, dockItem, ".sy__bookmark");
            const bookmarkPanel = page.locator(".sy__bookmark").last();
            const bookmarkGroup = bookmarkPanel.locator(`li[data-treetype="bookmark"][data-bookmark="${bookmark}"]`);
            await expect(bookmarkGroup).toBeVisible({timeout: 15000});

            await openMenuItemByIcon(page, bookmarkGroup, "#iconEdit");
            const renameDialog = page.locator('[data-key="dialog-renamebookmark"].b3-dialog--open').last();
            const renameInput = renameDialog.locator("input");
            await expect(renameInput).toBeVisible();
            await renameInput.fill(renamed);
            const renameResponse = page.waitForResponse(response =>
                response.url().endsWith("/api/bookmark/renameBookmark") && response.request().method() === "POST");
            await renameInput.press("Enter");
            expect((await renameResponse).ok()).toBe(true);
            await expect.poll(async () => (await siyuanAPI.getBookmarks()).find(
                item => item.name === renamed,
            )?.blocks.some(block => block.id === targetBlockID)).toBe(true);

            await activateDock(page, dockItem, ".sy__bookmark");
            const updatedBookmarkPanel = page.locator(".sy__bookmark:visible").last();
            const renamedGroup = updatedBookmarkPanel.locator(
                `li[data-treetype="bookmark"][data-bookmark="${renamed}"]`,
            );
            await expect(renamedGroup).toBeVisible({timeout: 15000});
            const bookmarkedBlock = updatedBookmarkPanel.locator(
                `li[data-treetype="bookmark"][data-node-id="${targetBlockID}"]`,
            );
            await expect(bookmarkedBlock).toBeVisible();
            await bookmarkedBlock.locator(":scope > .b3-list-item__text").click();
            await expect(page.locator(`.protyle-title[data-node-id="${target.docID}"]:visible`).last()).toBeVisible();
            await expect(page.locator(`.protyle-wysiwyg [data-node-id="${targetBlockID}"]:visible`).last()).toContainText(marker);

            await openMenuItemByIcon(page, bookmarkedBlock, "#iconTrashcan");
            const confirmButton = page.locator("#confirmDialogConfirmBtn:visible");
            await expect(confirmButton).toBeVisible();
            const removeResponse = page.waitForResponse(response =>
                response.url().endsWith("/api/attr/setBlockAttrs") && response.request().method() === "POST");
            await confirmButton.click();
            expect((await removeResponse).ok()).toBe(true);
            await expect.poll(async () => (await siyuanAPI.getBlockAttrs(targetBlockID!)).bookmark || "").toBe("");
            await expect.poll(async () => (await siyuanAPI.getBookmarks()).some(
                item => item.name === renamed,
            ), {timeout: 30000}).toBe(false);
            await expect(renamedGroup).toHaveCount(0);

            await page.reload();
            await expect(page.locator(`.protyle-wysiwyg [data-node-id="${targetBlockID}"][bookmark]:visible`))
                .toHaveCount(0);
        } finally {
            try {
                await restoreDock(page, dockItem, initiallyActive);
            } finally {
                await restoreDockVisibility();
            }
        }
    });

    test("renders heading hierarchy and navigates from the outline after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
        const headings = [`Outline Parent ${suffix}`, `Outline Child ${suffix}`, `Outline Sibling ${suffix}`];
        const document = await createTestDocument("Outline Navigation", [
            `# ${headings[0]}`,
            "Parent body",
            `## ${headings[1]}`,
            "Child body",
            `## ${headings[2]}`,
            "Sibling body",
        ].join("\n\n"));
        const headingElements = document.editor.locator(':scope > [data-type="NodeHeading"]');
        await expect(headingElements).toHaveCount(3);
        const headingIDs = await headingElements.evaluateAll(elements => elements.map(
            element => element.getAttribute("data-node-id")!,
        ));

        await expect.poll(async () => flattenOutline(await siyuanAPI.getDocumentOutline(document.docID)).map(
            item => item.id,
        )).toEqual(headingIDs);

        const restoreDockVisibility = await showDock(page);
        const dockItem = page.locator('.dock__item[data-type="outline"]').first();
        const initiallyActive = await dockItem.evaluate(element => element.classList.contains("dock__item--active"));
        try {
            await activateDock(page, dockItem, ".sy__outline");
            await assertOutline(page, headingIDs, headings);
            const siblingNode = page.locator(
                `.sy__outline li[data-treetype="outline"][data-node-id="${headingIDs[2]}"]:visible`,
            ).last();
            await siblingNode.locator(":scope > .b3-list-item__text").click();
            await expect(page.locator(`.protyle-wysiwyg [data-node-id="${headingIDs[2]}"]:visible`).last())
                .toContainText(headings[2]);

            await page.reload();
            await expect(await getDocumentEditor(page, document.docID)).toContainText(headings[0]);
            const outlineLogo = page.locator(".sy__outline .block__logo:visible");
            if (await outlineLogo.isVisible()) {
                await dockItem.click();
                await expect(outlineLogo).toBeHidden();
            }
            await activateDock(page, dockItem, ".sy__outline");
            await assertOutline(page, headingIDs, headings);
        } finally {
            try {
                await restoreDock(page, dockItem, initiallyActive);
            } finally {
                await restoreDockVisibility();
            }
        }
    });
});

const flattenOutline = (paths: IOutlinePath[]) => {
    const blocks: IOutlineBlock[] = [];
    const visit = (block: IOutlineBlock) => {
        blocks.push(block);
        block.children?.forEach(visit);
    };
    paths.forEach(path => {
        blocks.push({
            id: path.id,
            content: path.name,
        });
        path.blocks?.forEach(visit);
    });
    return blocks;
};

const activateDock = async (page: import("@playwright/test").Page, dockItem: import("@playwright/test").Locator,
                            panelSelector: string) => {
    if (!await page.locator(`${panelSelector} .block__logo:visible`).isVisible()) {
        if (await dockItem.evaluate(element => element.classList.contains("dock__item--active"))) {
            await dockItem.click();
        }
        await dockItem.click();
    }
    await expect(page.locator(`${panelSelector} .block__logo:visible`)).toBeVisible();
};

const restoreDock = async (page: import("@playwright/test").Page, dockItem: import("@playwright/test").Locator,
                           initiallyActive: boolean) => {
    if (page.isClosed()) {
        return;
    }
    const active = await dockItem.evaluate(element => element.classList.contains("dock__item--active"))
        .catch(() => initiallyActive);
    if (active !== initiallyActive) {
        await dockItem.click().catch(() => undefined);
    }
};

const openMenuItemByIcon = async (page: import("@playwright/test").Page,
                                  node: import("@playwright/test").Locator, icon: string) => {
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
    throw new Error(`menu item ${icon} not found`);
};

const assertOutline = async (page: import("@playwright/test").Page, headingIDs: string[], headings: string[]) => {
    const nodes = page.locator('.sy__outline li[data-treetype="outline"]:visible');
    await expect(nodes).toHaveCount(headingIDs.length, {timeout: 15000});
    await expect.poll(() => nodes.evaluateAll(elements => elements.map(element => ({
        id: element.getAttribute("data-node-id"),
        text: element.querySelector(":scope > .b3-list-item__text")?.textContent?.replace(/\s/g, " ").trim(),
    })))).toEqual(headingIDs.map((id, index) => ({id, text: headings[index]})));
};
