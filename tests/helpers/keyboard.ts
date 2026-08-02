import {Locator, Page} from "@playwright/test";

export const PRIMARY_MODIFIER = "ControlOrMeta" as const;
export const UNDO_SHORTCUT = "ControlOrMeta+Z";
export const REDO_SHORTCUT = process.platform === "darwin" ? "Meta+Shift+Z" : "Control+Y";

export const dispatchPrimaryClick = async (page: Page, locator: Locator) => {
    const primaryKey = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(primaryKey);
    try {
        await locator.dispatchEvent("click");
    } finally {
        await page.keyboard.up(primaryKey);
    }
};
