import {Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openWorkspace} from "./helpers/runtime";

const openEditorFontSizeMenu = async (page: Page) => {
    await page.locator("#barWorkspace").click();
    const workspaceMenu = page.locator('.b3-menu[data-name="barWorkspace"]:not(.fn__none)');
    await expect(workspaceMenu).toBeVisible();
    const zoomMenuItem = workspaceMenu.locator('[data-id="zoomControls"]').first();
    await zoomMenuItem.hover();
    const editorFontSizeMenuItem = zoomMenuItem.locator(
        ':scope > .b3-menu__submenu > .b3-menu__items > [data-id="editorFontSize"]',
    );
    await expect(editorFontSizeMenuItem).toBeVisible();
    await editorFontSizeMenuItem.hover();
    return editorFontSizeMenuItem;
};

test.describe("editor font size", () => {
    test("changes and persists the font size from the main menu", async ({page, siyuanAPI, createTestDocument}) => {
        const {editor} = await createTestDocument("Editor Font Size E2E", "Editor font size test");
        const originalEditor = (await siyuanAPI.getConf()).conf.editor;
        await siyuanAPI.setEditor({...originalEditor, fontSize: 16});

        try {
            await page.reload();
            await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontSize)).toBe(16);

            let editorFontSizeMenuItem = await openEditorFontSizeMenu(page);
            await expect(editorFontSizeMenuItem.locator(":scope > .b3-menu__accelerator")).toHaveText("16 px");
            const increaseItem = editorFontSizeMenuItem.locator(
                ':scope > .b3-menu__submenu > .b3-menu__items > [data-id="increaseEditorFontSize"]',
            );
            await expect(increaseItem).toBeVisible();
            await increaseItem.click();

            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontSize)).toBe(17);
            await expect.poll(() => editor.locator("[data-node-id]").first().evaluate((element) =>
                getComputedStyle(element).fontSize)).toBe("17px");
            await expect.poll(async () => (await siyuanAPI.getConf()).conf.editor.fontSize).toBe(17);

            editorFontSizeMenuItem = await openEditorFontSizeMenu(page);
            await expect(editorFontSizeMenuItem.locator(":scope > .b3-menu__accelerator")).toHaveText("17 px");
            const resetItem = editorFontSizeMenuItem.locator(
                ':scope > .b3-menu__submenu > .b3-menu__items > [data-id="resetEditorFontSize"]',
            );
            await expect(resetItem).toBeVisible();
            await resetItem.click();

            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontSize)).toBe(16);
            await expect.poll(async () => (await siyuanAPI.getConf()).conf.editor.fontSize).toBe(16);
        } finally {
            await siyuanAPI.setEditor(originalEditor);
            if (!page.isClosed()) {
                await openWorkspace(page);
                await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontSize))
                    .toBe(originalEditor.fontSize);
            }
        }
    });
});
