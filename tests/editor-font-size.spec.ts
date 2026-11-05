import {expect, test} from "./fixtures";
import {runPaletteCommand} from "./helpers/commandPanel";
import {openWorkspace} from "./helpers/runtime";
import {getDocumentEditor} from "./helpers/testNotebook";

test.describe("editor font size", () => {
    test("changes, persists, and resets the font size from the command palette", async ({page, siyuanAPI, createTestDocument}) => {
        const {docID} = await createTestDocument("Editor Font Size E2E", "Editor font size test");
        const originalEditor = (await siyuanAPI.getConf()).conf.editor;
        await siyuanAPI.setEditor({...originalEditor, fontSize: 16});

        try {
            await page.reload();
            let editor = await getDocumentEditor(page, docID);
            await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontSize)).toBe(16);

            await runPaletteCommand(page, "core.general.increaseEditorFontSize");

            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontSize)).toBe(17);
            await expect.poll(() => editor.locator("[data-node-id]").first().evaluate((element) =>
                getComputedStyle(element).fontSize)).toBe("17px");
            await expect.poll(async () => (await siyuanAPI.getConf()).conf.editor.fontSize).toBe(17);

            await page.reload();
            editor = await getDocumentEditor(page, docID);
            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontSize)).toBe(17);
            await expect.poll(() => editor.locator("[data-node-id]").first().evaluate((element) =>
                getComputedStyle(element).fontSize)).toBe("17px");

            await runPaletteCommand(page, "core.general.resetEditorFontSize");

            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontSize)).toBe(16);
            await expect.poll(async () => (await siyuanAPI.getConf()).conf.editor.fontSize).toBe(16);
            await expect.poll(() => editor.locator("[data-node-id]").first().evaluate((element) =>
                getComputedStyle(element).fontSize)).toBe("16px");
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
