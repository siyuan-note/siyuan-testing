import {expect, test} from "./fixtures";
import {useDesktopFrontend} from "./helpers/desktopFrontend";
import {selectTextRange} from "./helpers/selection";
import {getDocumentEditor} from "./helpers/testNotebook";

test.beforeEach(async ({page}) => {
    await useDesktopFrontend(page);
});

for (const format of [
    {type: "code", markdown: "`value`"},
    {type: "tag", markdown: "#value#"},
    {type: "kbd", markdown: "<kbd>value</kbd>"},
]) {
    for (const key of ["ControlOrMeta+X", "Backspace"]) {
        test(`${format.type}: removes the entire inline element with ${key} without leaving markers`, async ({
            page, createTestDocument, siyuanAPI,
        }) => {
            const {editor, docID} = await createTestDocument("Inline Element Removal E2E",
                `${format.markdown} after`);
            const inline = editor.locator(`span[data-type~="${format.type}"]`);
            await editor.locator('[contenteditable="true"]').first().focus();
            await selectTextRange(inline, inline, 0, (await inline.textContent())!.length);
            await page.keyboard.press(key);
            await expect(inline).toHaveCount(0);
            await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).not.toContain("value");
            const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
            expect(saved).not.toContain("\u2060");
            expect(saved).not.toContain("data-inline-boundary");
            await page.reload();
            const reloaded = await getDocumentEditor(page, docID);
            await expect.poll(async () => (await reloaded.textContent())!.replace(/\u200b/g, "").trim())
                .toBe("after");
        });
    }
}
