import {Locator} from "@playwright/test";
import {expect, test} from "./fixtures";
import {useDesktopFrontend} from "./helpers/desktopFrontend";
import {expectSemanticInlineText} from "./helpers/editorText";
import {selectTextRange} from "./helpers/selection";
import {getDocumentEditor} from "./helpers/testNotebook";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";

const formats = [
    {type: "code", markdown: (text: string) => `\`${text}\``},
    {type: "tag", markdown: (text: string) => `#${text}#`},
    {type: "kbd", markdown: (text: string) => `<kbd>${text}</kbd>`},
];

const firstLine = (inline: Locator) => inline.evaluate(element => {
    const editable = element.closest('[contenteditable="true"]')!;
    const range = document.createRange();
    range.setStart(element.firstChild!, 1);
    range.setEnd(element.firstChild!, 2);
    return (range.getBoundingClientRect().top - editable.getBoundingClientRect().top) /
        parseFloat(getComputedStyle(editable).lineHeight);
});

const selectInlineContents = (inline: Locator) => inline.evaluate(element => {
    const firstText = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setStart(firstText, 1);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
});

test.beforeEach(async ({page}) => {
    await useDesktopFrontend(page);
});

for (const format of formats) {
    test(`${format.type}: fills the first line when a mixed long token fits only the next line`, async ({
        page, context, baseURL, createTestDocument, siyuanAPI,
    }, testInfo) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write", "local-network-access"], {origin: baseURL!});
        await page.setViewportSize({width: 1000, height: 900});
        const {editor, docID} = await createTestDocument("Mixed Inline Wrap E2E", "- [ ] 11111 / " + format.markdown("1"));
        const inline = editor.locator(`span[data-type~="${format.type}"]`);
        await expectSemanticInlineText(inline, "1");
        const geometry = await inline.evaluate(element => {
            const editable = element.closest('[contenteditable="true"]')!;
            const prefix = document.createRange();
            prefix.setStart(editable, 0);
            prefix.setEndBefore(element);
            const character = document.createRange();
            character.setStart(element.firstChild!, 1);
            character.setEnd(element.firstChild!, 2);
            const style = getComputedStyle(element);
            return {
                width: editable.getBoundingClientRect().width,
                prefix: prefix.getBoundingClientRect().width,
                character: character.getBoundingClientRect().width,
                padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
            };
        });
        // 长串小于完整行宽、大于当前行剩余宽度，覆盖评论中整体移到下一行的情况。
        const count = Math.floor((geometry.width - geometry.padding - geometry.prefix / 2) / geometry.character);
        const expected = "1".repeat(count);
        const width = count * geometry.character + geometry.padding;
        expect(count).toBeGreaterThanOrEqual(32);
        expect(width).toBeLessThan(geometry.width);
        expect(width + geometry.prefix).toBeGreaterThan(geometry.width);
        await editor.locator('[contenteditable="true"]').first().focus();
        await selectTextRange(inline, inline, 1, 2);
        await page.keyboard.insertText(expected);
        await expectSemanticInlineText(inline, expected);
        await expect.poll(() => firstLine(inline)).toBeLessThan(0.5);
        await testInfo.attach("mixed-editor", {
            body: await editor.screenshot({path: testInfo.outputPath("mixed-editor.png")}),
            contentType: "image/png",
        });
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID)))
            .toContain(`"TextMarkTextContent":"${expected}"`);
        const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
        expect(saved).not.toContain("data-inline-wrap");
        expect(saved).not.toContain("data-inline-boundary");
        expect(saved).not.toContain("\u2060");
        await selectInlineContents(inline);
        await page.keyboard.press("ControlOrMeta+C");
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
        const clipboard = await page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const item = items.find(value => value.types.includes("text/html"));
            return item ? (await item.getType("text/html")).text() : "";
        });
        expect(clipboard).not.toContain("data-inline-wrap");
        await page.reload();
        const reloaded = await getDocumentEditor(page, docID);
        const reloadedInline = reloaded.locator(`span[data-type~="${format.type}"]`);
        await expectSemanticInlineText(reloadedInline, expected);
        for (const width of [1000, 800, 1440]) {
            await page.setViewportSize({width, height: 900});
            await expect.poll(() => firstLine(reloadedInline)).toBeLessThan(0.5);
        }
    });

    test(`${format.type}: updates wrapping after typing, deletion, history, and spaces`, async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const short = "1".repeat(31);
        const {editor, docID} = await createTestDocument("Inline Wrap Editing E2E",
            "11111 / " + format.markdown(short));
        const inline = editor.locator(`span[data-type~="${format.type}"]`);
        const expectSaved = async (text: string) => {
            await expectSemanticInlineText(inline, text);
            await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID)))
                .toContain(`"TextMarkTextContent":${JSON.stringify(text)}`);
        };
        const expectBreakAll = async (enabled: boolean) => {
            await expect.poll(() => inline.evaluate(element => getComputedStyle(element).wordBreak === "break-all"))
                .toBe(enabled);
        };
        await expectSemanticInlineText(inline, short);
        await expectBreakAll(false);
        await editor.locator('[contenteditable="true"]').first().focus();
        await selectTextRange(inline, inline, 32, 32);
        await page.keyboard.type("2");
        await expectSaved(short + "2");
        await expectBreakAll(true);
        await page.keyboard.press(UNDO_SHORTCUT);
        await expectSaved(short);
        await expectBreakAll(false);
        await page.keyboard.press(REDO_SHORTCUT);
        await expectSaved(short + "2");
        await expectBreakAll(true);
        await page.keyboard.press("Backspace");
        await expectSaved(short);
        await expectBreakAll(false);
        await selectInlineContents(inline);
        const long = "1".repeat(100);
        await page.keyboard.insertText(long);
        await expectSaved(long);
        await expectBreakAll(true);
        await selectTextRange(inline, inline, 51, 51);
        await page.keyboard.type(" ");
        await expectSaved("1".repeat(50) + " " + "1".repeat(50));
        await expectBreakAll(false);
        // 按当前文本节点选中空格，删除操作与上一次输入留下的光标位置无关。
        await inline.evaluate(element => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
                const offset = node.textContent!.indexOf(" ");
                if (offset >= 0) {
                    const range = document.createRange();
                    range.setStart(node, offset);
                    range.setEnd(node, offset + 1);
                    getSelection()!.removeAllRanges();
                    getSelection()!.addRange(range);
                    return;
                }
            }
            throw new Error("Expected a space inside the inline element");
        });
        await page.keyboard.press("Backspace");
        await expectSaved(long);
        await expectBreakAll(true);
        await selectInlineContents(inline);
        await page.keyboard.insertText("ordinary words remain intact");
        await expectSaved("ordinary words remain intact");
        await expectBreakAll(false);
        const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
        expect(saved).not.toContain("data-inline-wrap");
        await page.reload();
        const reloaded = await getDocumentEditor(page, docID);
        await expectSemanticInlineText(reloaded.locator(`span[data-type~="${format.type}"]`),
            "ordinary words remain intact");
    });
}
