import {expect, Locator, Page} from "@playwright/test";

export const openBlockMenu = async (page: Page, block: Locator, hoverTarget: Locator = block) => {
    const blockID = await block.getAttribute("data-node-id");
    expect(blockID).toBeTruthy();
    const menu = page.locator("#commonMenu:not(.fn__none)");
    await expect(async () => {
        await page.mouse.move(0, 0);
        await hoverTarget.hover({timeout: 3000});
        const gutter = page.locator(`.protyle-gutters button[data-node-id="${blockID}"]`);
        await expect(gutter).toBeVisible({timeout: 3000});
        await gutter.dispatchEvent("click");
        await expect(menu).toBeVisible({timeout: 3000});
    }).toPass({timeout: 15000});
    return menu;
};
