import {expect, test} from "./fixtures";
import {expectSemanticInlineText} from "./helpers/editorText";
import {selectTextRange} from "./helpers/selection";
import {getDocumentEditor} from "./helpers/testNotebook";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {useDesktopFrontend} from "./helpers/desktopFrontend";
import {dragSelectTableCells} from "./helpers/tableSelection";

test.beforeEach(async ({page}) => {
    await useDesktopFrontend(page);
});

for (const format of [
    {type: "code", markdown: "`alpha beta`"},
    {type: "tag", markdown: "#alpha beta#"},
    {type: "kbd", markdown: "<kbd>alpha beta</kbd>"},
]) {
    test(`${format.type}: moves across inline boundaries and edits without persisting placeholders`, async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const {editor, docID} = await createTestDocument("Inline Boundary Edit E2E", format.markdown);
        const inline = editor.locator(`span[data-type~="${format.type}"]`);
        const editable = editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]');
        const savedText = async () => JSON.stringify(await siyuanAPI.readDocument(docID)).replace(/\u200b/g, "");
        await editable.focus();
        await selectTextRange(inline, inline, 1, 1);
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.type("Before ");
        await expectSemanticInlineText(inline, "alpha beta");
        await expect.poll(async () => (await editable.textContent())!.replace(/[\u200b\u2060]/g, ""))
            .toBe("Before alpha beta");
        await expect.poll(savedText).toContain('"Data":"Before "');

        await page.keyboard.press("ArrowRight");
        await expect.poll(() => inline.evaluate(element => {
            const selection = getSelection()!;
            return element.contains(selection.anchorNode) && selection.anchorOffset === 1;
        })).toBe(true);
        await page.keyboard.press("Delete");
        await expectSemanticInlineText(inline, "lpha beta");
        await expect.poll(savedText).toContain('"TextMarkTextContent":"lpha beta"');
        await page.keyboard.type("A");
        await expectSemanticInlineText(inline, "Alpha beta");
        await expect.poll(savedText).toContain('"TextMarkTextContent":"Alpha beta"');
        await inline.evaluate(element => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let last: Node = element;
            let node: Node | null;
            while ((node = walker.nextNode())) {
                last = node;
            }
            const range = document.createRange();
            range.setStart(last, last.textContent!.length);
            range.collapse(true);
            getSelection()!.removeAllRanges();
            getSelection()!.addRange(range);
        });
        await page.keyboard.press("ArrowRight");
        await page.keyboard.type(" after");
        await expectSemanticInlineText(inline, "Alpha beta");
        await expect.poll(savedText).toContain('"Data":" after"');

        await selectTextRange(inline, inline, 1, 1);
        await page.keyboard.press("Backspace");
        await expectSemanticInlineText(inline, "Alpha beta");
        await expect.poll(() => inline.evaluate(element =>
            element.contains(getSelection()!.anchorNode))).toBe(false);
        // 首次退格跨出行内元素边界，第二次退格才删除边界外的实际文字。
        await page.keyboard.press("Backspace");
        await expect.poll(async () => (await editable.textContent())!.replace(/[\u200b\u2060]/g, ""))
            .toBe("BeforeAlpha beta after");
        // 等待最后一次退格落盘，避免刷新时读到前一次输入的已保存版本。
        await expect.poll(savedText).toContain('"Data":"Before"');
        expect(JSON.stringify(await siyuanAPI.readDocument(docID))).not.toContain("\u2060");
        await page.reload();
        const reloaded = await getDocumentEditor(page, docID);
        await expectSemanticInlineText(reloaded.locator(`span[data-type~="${format.type}"]`), "Alpha beta");
        await expect.poll(async () => (await reloaded.locator('[contenteditable="true"]').first().textContent())!
            .replace(/[\u200b\u2060]/g, "")).toBe("BeforeAlpha beta after");
    });

    test(`${format.type}: restores inline content with undo and redo`, async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const {editor, docID} = await createTestDocument("Inline Boundary History E2E", format.markdown);
        const inline = editor.locator(`span[data-type~="${format.type}"]`);
        await editor.locator('[contenteditable="true"]').first().focus();
        await selectTextRange(inline, inline, 2, 2);
        await page.keyboard.type("X");
        await expectSemanticInlineText(inline, "aXlpha beta");
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain("aXlpha beta");
        const undoResponse = page.waitForResponse(response => response.url().endsWith("/api/transactions/undo"));
        await page.keyboard.press(UNDO_SHORTCUT);
        expect((await undoResponse).ok()).toBe(true);
        await expectSemanticInlineText(inline, "alpha beta");
        const redoResponse = page.waitForResponse(response => response.url().endsWith("/api/transactions/redo"));
        await page.keyboard.press(REDO_SHORTCUT);
        expect((await redoResponse).ok()).toBe(true);
        await expectSemanticInlineText(inline, "aXlpha beta");
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain("aXlpha beta");
        const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
        expect(saved).not.toContain("\u2060");
        expect(saved).not.toContain("data-inline-boundary");
        await page.reload();
        const reloaded = await getDocumentEditor(page, docID);
        await expectSemanticInlineText(reloaded.locator(`span[data-type~="${format.type}"]`), "aXlpha beta");
    });

    test(`${format.type}: copies plain text without structural markers`, async ({
        page, context, baseURL, createTestDocument,
    }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin: baseURL!});
        const {editor} = await createTestDocument("Inline Boundary Plain Copy E2E", format.markdown + " tail");
        const editable = editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]');
        await editable.focus();
        const point = await editable.evaluate(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            getSelection()!.removeAllRanges();
            getSelection()!.addRange(range);
            const tail = element.lastChild!;
            const offset = tail.textContent!.indexOf("tail");
            const tailRange = document.createRange();
            tailRange.setStart(tail, offset);
            tailRange.setEnd(tail, offset + 4);
            const rect = tailRange.getBoundingClientRect();
            return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
        });
        await page.mouse.click(point.x, point.y, {button: "right"});
        await page.locator('.b3-menu:not(.fn__none) [data-id="copyPlainText"]').click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("alpha beta tail");
    });

    test(`${format.type}: preserves table cell content through editing and reload`, async ({
        page, context, baseURL, createTestDocument, siyuanAPI,
    }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin: baseURL!});
        const {editor, docID} = await createTestDocument("Inline Boundary Table E2E",
            `| Header | Next |\n| --- | --- |\n| ${format.markdown} | ordinary<br />line |`);
        const cell = editor.locator("tbody td").first();
        await cell.click();
        const inline = cell.locator(`.table__cell-editor span[data-type~="${format.type}"]`);
        await expectSemanticInlineText(inline, "alpha beta");
        await selectTextRange(inline, inline, 2, 2);
        await page.keyboard.type("X");
        await expectSemanticInlineText(inline, "aXlpha beta");
        await page.keyboard.press("Escape");
        await expect(cell.locator(".table__cell-editor")).toHaveCount(0);
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain("aXlpha beta");
        const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
        expect(saved).not.toContain("\u2060");
        expect(saved).not.toContain("data-inline-boundary");
        await page.reload();
        const reloaded = await getDocumentEditor(page, docID);
        await expectSemanticInlineText(reloaded.locator(`tbody td span[data-type~="${format.type}"]`).first(), "aXlpha beta");
        const cells = reloaded.locator("tbody td");
        await dragSelectTableCells(page, cells.first(), cells.last());
        await page.keyboard.press("ControlOrMeta+C");
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe("aXlpha beta\tordinary\nline");
        await page.keyboard.press("Escape");
    });

    test(`${format.type}: copies and pastes without leaking boundary markers`, async ({
        page, context, baseURL, createTestDocument, siyuanAPI,
    }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin: baseURL!});
        const {editor, docID} = await createTestDocument("Inline Boundary Clipboard E2E", format.markdown + "\n\nDestination");
        const paragraphs = editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]');
        const source = paragraphs.first();
        await source.focus();
        await source.evaluate(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            getSelection()!.removeAllRanges();
            getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+C");
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("alpha beta");
        const clipboard = await page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const htmlItem = items.find(item => item.types.includes("text/html"));
            return htmlItem ? (await htmlItem.getType("text/html")).text() : "";
        });
        expect(clipboard).not.toContain("\u2060");
        expect(clipboard).not.toContain("data-inline-boundary");
        const destination = paragraphs.last();
        await destination.click();
        await page.keyboard.press("Home");
        await page.keyboard.press("Shift+End");
        await page.keyboard.press("ControlOrMeta+V");
        await expect(editor.locator(`span[data-type~="${format.type}"]`)).toHaveCount(2);
        await expectSemanticInlineText(editor.locator(`span[data-type~="${format.type}"]`).last(), "alpha beta");
        await expect.poll(async () => {
            const serialized = JSON.stringify(await siyuanAPI.readDocument(docID));
            return serialized.split('"TextMarkTextContent":"alpha beta"').length - 1;
        }).toBe(2);
        expect(JSON.stringify(await siyuanAPI.readDocument(docID))).not.toContain("\u2060");
    });
}

test("keeps adjacent tags separate after deleting their visible separator", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const {editor, docID} = await createTestDocument("Adjacent Tag Boundary E2E", "#alpha# #beta#");
    const tags = editor.locator('span[data-type~="tag"]');
    const editable = editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]');
    await expect(tags).toHaveCount(2);
    await editable.focus();
    await tags.first().evaluate(element => {
        const separator = element.nextSibling!;
        const offset = separator.textContent!.indexOf(" ");
        if (separator.nodeType !== Node.TEXT_NODE || offset < 0) {
            throw new Error("Expected a space between the two tags");
        }
        const range = document.createRange();
        range.setStart(separator, offset);
        range.setEnd(separator, offset + 1);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
    });
    await page.keyboard.press("Backspace");
    await expect(tags).toHaveCount(2);
    await expectSemanticInlineText(tags.first(), "alpha");
    await expectSemanticInlineText(tags.last(), "beta");
    await selectTextRange(tags.last(), tags.last(), 1, 1);
    await page.keyboard.insertText("X");
    await expectSemanticInlineText(tags.last(), "Xbeta");
    await expect.poll(async () => {
        const serialized = JSON.stringify(await siyuanAPI.readDocument(docID));
        return [serialized.includes('"TextMarkTextContent":"alpha"'),
            serialized.includes('"TextMarkTextContent":"Xbeta"')];
    }).toEqual([true, true]);
    const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
    expect(saved).not.toContain("\u2060");
    expect(saved).not.toContain("data-inline-boundary");
    await page.reload();
    const reloaded = await getDocumentEditor(page, docID);
    const reloadedTags = reloaded.locator('span[data-type~="tag"]');
    await expect(reloadedTags).toHaveCount(2);
    await expectSemanticInlineText(reloadedTags.first(), "alpha");
    await expectSemanticInlineText(reloadedTags.last(), "Xbeta");
});

test("preserves user-authored word joiners during editing and reload", async ({
    page, context, baseURL, createTestDocument, siyuanAPI,
}) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin: baseURL!});
    const {editor, docID} = await createTestDocument("Inline Code Literal Joiner E2E",
        "outside\u2060text `co\u2060de`");
    const code = editor.locator('span[data-type~="code"]');
    await code.click();
    await selectTextRange(code, code, 2, 2);
    await page.keyboard.insertText("X");
    await expectSemanticInlineText(code, "cXo\u2060de");
    await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID)))
        .toContain("cXo\u2060de");
    const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
    expect(saved).toContain("outside\u2060text");
    expect(saved.split("\u2060")).toHaveLength(3);
    const editable = editor.locator('[contenteditable="true"]').first();
    await editable.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
    });
    await editable.click({button: "right", position: {x: 30, y: 8}});
    await page.locator('.b3-menu:not(.fn__none) [data-id="copyPlainText"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe("outside\u2060text cXo\u2060de");
    await page.reload();
    const reloaded = await getDocumentEditor(page, docID);
    await expectSemanticInlineText(reloaded.locator('span[data-type~="code"]'), "cXo\u2060de");
});

test("deletes empty code and keeps the neighboring code boundary usable", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const {editor, docID} = await createTestDocument("Inline Code Adjacent Delete E2E", "`one` **`two`**");
    const codes = editor.locator('span[data-type~="code"]');
    await codes.first().click();
    await selectTextRange(codes.first(), codes.first(), 1, 4);
    await page.keyboard.press("Backspace");
    await expect(codes).toHaveCount(1);
    await expectSemanticInlineText(codes, "two");
    await codes.click();
    await selectTextRange(codes, codes, 1, 1);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.insertText("before");
    await expectSemanticInlineText(codes, "two");
    await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain("before");
    expect(JSON.stringify(await siyuanAPI.readDocument(docID))).not.toContain("\u2060");
});
