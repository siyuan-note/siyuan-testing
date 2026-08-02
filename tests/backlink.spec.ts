import {expect, test} from "./fixtures";
import {dispatchPrimaryClick} from "./helpers/keyboard";
import {showDock} from "./helpers/runtime";
import {getDocumentEditor} from "./helpers/testNotebook";

test("refreshes backlinks, navigates to the referring document, and removes the relationship", async ({
    createTestDocument,
    page,
    siyuanAPI,
}) => {
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
    const targetMarker = `Backlink target ${suffix}`;
    const sourceMarker = `Backlink source ${suffix}`;
    const removedMarker = `Backlink removed ${suffix}`;
    const target = await createTestDocument("Backlink Target", targetMarker);
    const source = await createTestDocument(
        "Backlink Source",
        `${sourceMarker} ((${target.docID} "${target.title}"))`,
    );
    const sourceBlock = source.editor.locator(':scope > [data-type="NodeParagraph"]').first();
    const sourceBlockID = await sourceBlock.getAttribute("data-node-id");
    expect(sourceBlockID).toBeTruthy();
    const reference = source.editor.locator(`[data-type~="block-ref"][data-id="${target.docID}"]`);
    await expect(reference).toBeVisible();

    await expect.poll(async () => {
        const result = await siyuanAPI.getBacklinks(target.docID);
        return {
            count: result.linkRefsCount,
            source: result.backlinks.some(path => path.id === source.docID),
        };
    }, {timeout: 30000}).toEqual({count: 1, source: true});

    await reference.click();
    await expect((await getDocumentEditor(page, target.docID)).locator(
        `:scope > [data-type="NodeParagraph"]`,
    ).first()).toContainText(targetMarker);
    const restoreDockVisibility = await showDock(page);
    const dockItem = page.locator('.dock__item[data-type="backlink"]').first();
    const initiallyActive = await dockItem.evaluate(element => element.classList.contains("dock__item--active"));

    try {
        await activateBacklinkDock(page, dockItem);
        let panel = page.locator(".sy__backlink:not(.sy__backlink--bottom):visible").last();
        let sourceNode = panel.locator(
            `.backlinkList li[data-treetype="backlink"][data-node-id="${source.docID}"]`,
        );
        await expect(sourceNode).toBeVisible({timeout: 15000});
        await expect(panel.locator(".listCount")).toHaveText("1");

        await dispatchPrimaryClick(page, sourceNode);
        await expect((await getDocumentEditor(page, source.docID)).locator(
            `[data-node-id="${sourceBlockID}"]`,
        )).toContainText(sourceMarker);

        await siyuanAPI.updateBlock(sourceBlockID!, removedMarker);
        await expect.poll(async () => {
            const result = await siyuanAPI.getBacklinks(target.docID);
            return {
                count: result.linkRefsCount,
                source: result.backlinks.some(path => path.id === source.docID),
            };
        }, {timeout: 30000}).toEqual({count: 0, source: false});

        await page.goto(`/?id=${target.docID}`);
        await getDocumentEditor(page, target.docID);
        await activateBacklinkDock(page, dockItem);
        panel = page.locator(".sy__backlink:not(.sy__backlink--bottom):visible").last();
        const refreshButton = panel.locator('.block__icon[data-type="refresh"]');
        await expect(refreshButton.locator("svg")).not.toHaveClass(/fn__rotate/, {timeout: 15000});
        await panel.locator(".block__icons").first().hover();
        await expect(refreshButton).toBeVisible();
        const refreshResponse = page.waitForResponse(response =>
            response.url().endsWith("/api/ref/refreshBacklink") && response.request().method() === "POST", {
            timeout: 15000,
        });
        await refreshButton.click();
        expect((await refreshResponse).ok()).toBe(true);
        sourceNode = panel.locator(
            `.backlinkList li[data-treetype="backlink"][data-node-id="${source.docID}"]`,
        );
        await expect(sourceNode).toHaveCount(0, {timeout: 15000});
        await expect(panel.locator(".listCount")).toHaveText("");
        await expect(panel.locator(".listCount")).toHaveClass(/fn__none/);

        await page.goto(`/?id=${source.docID}`);
        await page.reload();
        const reloadedSource = await getDocumentEditor(page, source.docID);
        await expect(reloadedSource.locator(
            `[data-type~="block-ref"][data-id="${target.docID}"]`,
        )).toHaveCount(0);
        await expect(reloadedSource.locator(`[data-node-id="${sourceBlockID}"]`)).toContainText(removedMarker);
        expect((await siyuanAPI.getBacklinks(target.docID)).linkRefsCount).toBe(0);
    } finally {
        try {
            await restoreDock(page, dockItem, initiallyActive);
        } finally {
            await restoreDockVisibility();
        }
    }
});

const activateBacklinkDock = async (page: import("@playwright/test").Page,
                                    dockItem: import("@playwright/test").Locator) => {
    const panel = page.locator(".sy__backlink:not(.sy__backlink--bottom):visible").last();
    const logo = panel.locator(".block__logo").first();
    if (!await logo.isVisible()) {
        if (await dockItem.evaluate(element => element.classList.contains("dock__item--active"))) {
            await dockItem.click();
        }
        await dockItem.click();
    }
    await expect(logo).toBeVisible();
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
