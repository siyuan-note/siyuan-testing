import {expect, test} from "./fixtures";
import {openWorkspace} from "./helpers/runtime";

test.describe("workspace", () => {
    test("toggles and restores the dock sidebar", async ({page}) => {
        await openWorkspace(page);
        const dockIcon = page.locator("#barDock use");
        const originalIcon = await dockIcon.getAttribute("xlink:href");
        expect(["#iconDock", "#iconHideDock"]).toContain(originalIcon);
        const initialIcon = originalIcon as "#iconDock" | "#iconHideDock";
        const originalHidden = initialIcon === "#iconDock";

        try {
            await page.locator("#barDock").click();
            await expect(dockIcon).toHaveAttribute("xlink:href", originalHidden ? "#iconHideDock" : "#iconDock");
            await expect.poll(() => page.evaluate(() => window.siyuan.config.uiLayout.hideDock)).toBe(!originalHidden);

            await page.locator("#barDock").click();
            await expect(dockIcon).toHaveAttribute("xlink:href", initialIcon);
            await expect.poll(() => page.evaluate(() => window.siyuan.config.uiLayout.hideDock)).toBe(originalHidden);
        } finally {
            if (await dockIcon.getAttribute("xlink:href") !== initialIcon) {
                await page.locator("#barDock").click();
            }
            await expect(dockIcon).toHaveAttribute("xlink:href", initialIcon);
            await expect.poll(() => page.evaluate(() => window.siyuan.config.uiLayout.hideDock)).toBe(originalHidden);
        }
    });

    test("changes and restores the appearance mode", async ({page, globalSettings}) => {
        const targetMode = globalSettings.appearance.mode === 1 && !globalSettings.appearance.modeOS ? 0 : 1;
        const targetID = targetMode === 0 ? "themeLight" : "themeDark";

        await page.locator("#barMode").click();
        const menuItem = page.locator(`[data-id="${targetID}"]`);
        await expect(menuItem).toBeVisible();
        await menuItem.click();

        await expect.poll(() => page.evaluate(() => ({
            mode: window.siyuan.config.appearance.mode,
            modeOS: window.siyuan.config.appearance.modeOS,
        }))).toEqual({mode: targetMode, modeOS: false});
        await expect(page.locator("html")).toHaveAttribute("data-theme-mode", targetMode === 0 ? "light" : "dark");
    });
});
