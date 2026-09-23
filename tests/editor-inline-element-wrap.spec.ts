import {expect, test} from "./fixtures";
import {expectSemanticInlineText} from "./helpers/editorText";
import {getDocumentEditor} from "./helpers/testNotebook";
import {selectTextRange} from "./helpers/selection";
import {useDesktopFrontend} from "./helpers/desktopFrontend";

const cases = [
    ...["", "- ", "1. ", "- [ ] "].flatMap((prefix, index) => [
        {name: `tag context ${index}`, prefix, mark: "#seed#", type: "tag", spaced: false},
        {name: `kbd context ${index}`, prefix, mark: "<kbd>seed</kbd>", type: "kbd", spaced: false},
    ]),
    {name: "tag with spaces", prefix: "", mark: "#seed#", type: "tag", spaced: true},
    {name: "kbd with spaces", prefix: "", mark: "<kbd>seed</kbd>", type: "kbd", spaced: true},
    {name: "tag after prose", prefix: "- Example: ", mark: "#seed#", type: "tag", spaced: false},
    {name: "kbd after prose", prefix: "- Example: ", mark: "<kbd>seed</kbd>", type: "kbd", spaced: false},
    {name: "bold tag", prefix: "- ", mark: "**#seed#**", type: "tag", spaced: false},
    {name: "bold kbd", prefix: "- ", mark: "**<kbd>seed</kbd>**", type: "kbd", spaced: false},
    {name: "bold code", prefix: "- ", mark: "**`seed`**", type: "code", spaced: false},
    {name: "bold text", prefix: "- ", mark: "**seed**", type: "strong", spaced: false},
    {name: "italic text", prefix: "- ", mark: "*seed*", type: "em", spaced: false},
    {name: "highlighted text", prefix: "- ", mark: "==seed==", type: "mark", spaced: false},
    {name: "underlined text", prefix: "- ", mark: "<u>seed</u>", type: "u", spaced: false},
    {name: "struck through text", prefix: "- ", mark: "~~seed~~", type: "s", spaced: false},
    {name: "superscript text", prefix: "- ", mark: "<sup>seed</sup>", type: "sup", spaced: false},
    {name: "subscript text", prefix: "- ", mark: "<sub>seed</sub>", type: "sub", spaced: false},
    {name: "link text", prefix: "- ", mark: "[seed](https://example.com)", type: "a", spaced: false},
];

test.beforeEach(async ({page}) => {
    await useDesktopFrontend(page);
});

for (const item of cases) {
    test(`${item.name} wraps without an empty first line`, async ({page, createTestDocument, siyuanAPI}, testInfo) => {
        const {editor, docID} = await createTestDocument("Inline Element Wrap E2E", item.prefix + item.mark);
        const mark = editor.locator(`span[data-type~="${item.type}"]`).first();
        await expectSemanticInlineText(mark, "seed");
        await editor.locator('[contenteditable="true"]').first().focus();
        const offset = (await mark.textContent())!.indexOf("seed") + 3;
        await selectTextRange(mark, mark, offset, offset);
        const inserted = item.spaced ? "ordinary words remain intact ".repeat(12) : "1234567890".repeat(24);
        const expected = `see${inserted}d`;
        await page.keyboard.insertText(inserted);
        await expectSemanticInlineText(mark, expected);

        for (const width of [1440, 800]) {
            await page.setViewportSize({width, height: 900});
            await mark.scrollIntoViewIfNeeded();
            const state = await mark.evaluate(element => {
                const editable = element.closest('[contenteditable="true"]')!;
                const bounds = editable.getBoundingClientRect();
                const rects: DOMRect[] = [];
                const splitWords: string[] = [];
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                let node: Node | null;
                while ((node = walker.nextNode())) {
                    const text = node.textContent!;
                    for (let offset = 0; offset < text.length; offset++) {
                        if (/[\s\u200b\u2060]/.test(text[offset])) {
                            continue;
                        }
                        const range = document.createRange();
                        range.setStart(node, offset);
                        range.setEnd(node, offset + 1);
                        rects.push(range.getBoundingClientRect());
                    }
                    for (const word of text.matchAll(/[a-z]+/gi)) {
                        const range = document.createRange();
                        range.setStart(node, word.index!);
                        range.setEnd(node, word.index! + word[0].length);
                        if (new Set(Array.from(range.getClientRects()).map(rect => Math.round(rect.top))).size > 1) {
                            splitWords.push(word[0]);
                        }
                    }
                }
                return {
                    firstLine: (rects[0].top - bounds.top) / parseFloat(getComputedStyle(editable).lineHeight),
                    lines: new Set(rects.map(rect => Math.round(rect.top))).size,
                    overflow: Math.max(...rects.map(rect => rect.right - bounds.right)),
                    splitWords,
                };
            });
            await testInfo.attach(`layout-${width}`, {body: JSON.stringify(state), contentType: "application/json"});
            await testInfo.attach(`editor-${width}`, {
                body: await editor.screenshot({path: testInfo.outputPath(`editor-${width}.png`)}),
                contentType: "image/png",
            });
            expect.soft(state.firstLine).toBeLessThan(0.5);
            expect.soft(state.lines).toBeGreaterThan(1);
            expect.soft(state.overflow).toBeLessThanOrEqual(1);
            if (item.spaced) {
                expect.soft(state.splitWords).toEqual([]);
            }
        }
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain(expected);
        const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
        expect(saved).not.toContain("\u2060");
        expect(saved).not.toContain("data-inline-boundary");
        expect(saved).not.toContain("data-inline-wrap");
        await page.reload();
        const reloaded = await getDocumentEditor(page, docID);
        await expectSemanticInlineText(reloaded.locator(`span[data-type~="${item.type}"]`).first(), expected);
    });
}
