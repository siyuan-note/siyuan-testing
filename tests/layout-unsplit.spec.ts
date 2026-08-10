import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";

const centerWnds = (page: Page) => page.locator('.layout__center [data-type="wnd"]');
const centerWndByID = (page: Page, id: string) =>
    page.locator(`.layout__center [data-type="wnd"][data-id="${id}"]`);

const selectSplitAction = async (page: Page, tabHeader: Locator, action: "splitLR" | "unsplit" | "unsplitAll") => {
    await tabHeader.click({button: "right"});
    const menu = page.locator("#commonMenu:not(.fn__none)");
    await expect(menu).toBeVisible();
    const splitItem = menu.locator('[data-id="split"]').first();
    await splitItem.hover();
    const actionItem = splitItem.locator(`:scope > .b3-menu__submenu [data-id="${action}"]`);
    await expect(actionItem).toBeVisible();
    await actionItem.click();
};

const ensureSinglePane = async (page: Page) => {
    const wnds = centerWnds(page);
    if (await wnds.count() > 1) {
        const tabHeader = wnds.locator('li[data-type="tab-header"].item--focus').last();
        await selectSplitAction(page, tabHeader, "unsplitAll");
        await expect(wnds).toHaveCount(1);
    }
};

const createThreeHorizontalPanes = async (page: Page) => {
    const wnds = centerWnds(page);
    await expect(wnds).toHaveCount(1);
    for (let count = 2; count <= 3; count++) {
        const tabHeader = wnds.last().locator('li[data-type="tab-header"].item--focus');
        await expect(tabHeader).toBeVisible();
        await selectSplitAction(page, tabHeader, "splitLR");
        await expect(wnds).toHaveCount(count);
    }

    const paneIDs = await wnds.evaluateAll(elements => elements.map(element => element.getAttribute("data-id")));
    const tabIDs = await wnds.evaluateAll(elements => elements.map(element =>
        element.querySelector('li[data-type="tab-header"].item--focus')?.getAttribute("data-id")));
    expect(paneIDs).not.toContain(null);
    expect(tabIDs).not.toContain(null);
    return {
        paneIDs: paneIDs as string[],
        tabIDs: tabIDs as string[],
    };
};

test.describe("layout unsplit", () => {
    test("unsplits only the selected pane", async ({page, createTestDocument, siyuanAPI}) => {
        await createTestDocument("Layout Unsplit Current E2E", "Current pane marker");
        const initialLayout = await page.evaluate(() => window.siyuan.config.uiLayout);

        try {
            await ensureSinglePane(page);
            const {paneIDs, tabIDs} = await createThreeHorizontalPanes(page);
            const wnds = centerWnds(page);
            await selectSplitAction(
                page,
                centerWndByID(page, paneIDs[2]).locator(
                    `li[data-type="tab-header"][data-id="${tabIDs[2]}"]`,
                ),
                "unsplit",
            );

            await expect(wnds).toHaveCount(2);
            await expect(centerWndByID(page, paneIDs[0])).toHaveCount(1);
            await expect(centerWndByID(page, paneIDs[1])).toHaveCount(1);
            await expect(centerWndByID(page, paneIDs[2])).toHaveCount(0);
            await expect(centerWndByID(page, paneIDs[0]).locator(
                `li[data-type="tab-header"][data-id="${tabIDs[0]}"]`,
            )).toHaveCount(1);
            await expect(centerWndByID(page, paneIDs[1]).locator(
                `li[data-type="tab-header"][data-id="${tabIDs[1]}"]`,
            )).toHaveCount(1);
            await expect(centerWndByID(page, paneIDs[1]).locator(
                `li[data-type="tab-header"][data-id="${tabIDs[2]}"]`,
            )).toHaveCount(1);
        } finally {
            await siyuanAPI.post<null>("/api/system/setUILayout", {layout: initialLayout});
            await page.reload();
            await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
        }
    });

    test("unsplits all panes", async ({page, createTestDocument, siyuanAPI}) => {
        await createTestDocument("Layout Unsplit All E2E", "All panes marker");
        const initialLayout = await page.evaluate(() => window.siyuan.config.uiLayout);

        try {
            await ensureSinglePane(page);
            const {paneIDs, tabIDs} = await createThreeHorizontalPanes(page);
            const wnds = centerWnds(page);
            await selectSplitAction(
                page,
                centerWndByID(page, paneIDs[2]).locator(
                    `li[data-type="tab-header"][data-id="${tabIDs[2]}"]`,
                ),
                "unsplitAll",
            );

            await expect(wnds).toHaveCount(1);
            await expect(wnds).toHaveAttribute("data-id", paneIDs[0]);
            for (const tabID of tabIDs) {
                await expect(wnds.locator(`li[data-type="tab-header"][data-id="${tabID}"]`)).toHaveCount(1);
            }
        } finally {
            await siyuanAPI.post<null>("/api/system/setUILayout", {layout: initialLayout});
            await page.reload();
            await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
        }
    });
});
