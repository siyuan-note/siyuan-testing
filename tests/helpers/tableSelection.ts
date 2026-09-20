import {expect, Locator, Page} from "@playwright/test";

export const dragSelectTableCells = async (page: Page, startCell: Locator, endCell: Locator) => {
    const startBox = await startCell.boundingBox();
    const endBox = await endCell.boundingBox();
    expect(startBox).not.toBeNull();
    expect(endBox).not.toBeNull();
    await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + startBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(endBox!.x + endBox!.width / 2, endBox!.y + endBox!.height / 2, {steps: 8});
    await page.mouse.up();
    const selection = page.locator(".protyle-table-control__selection:visible");
    await expect(selection).toHaveCount(1);
    await expect.poll(async () => {
        const selectionBox = await selection.boundingBox();
        if (!selectionBox) {
            return false;
        }
        const left = Math.min(startBox!.x, endBox!.x);
        const top = Math.min(startBox!.y, endBox!.y);
        const right = Math.max(startBox!.x + startBox!.width, endBox!.x + endBox!.width);
        const bottom = Math.max(startBox!.y + startBox!.height, endBox!.y + endBox!.height);
        const tolerance = 2;
        return selectionBox.x <= left + tolerance &&
            selectionBox.y <= top + tolerance &&
            selectionBox.x + selectionBox.width >= right - tolerance &&
            selectionBox.y + selectionBox.height >= bottom - tolerance;
    }).toBe(true);
};
