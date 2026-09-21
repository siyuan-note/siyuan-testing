import {Locator} from "@playwright/test";
import {expect, test} from "./fixtures";
import {useDesktopFrontend} from "./helpers/desktopFrontend";
import {getDocumentEditor} from "./helpers/testNotebook";
import {UNDO_SHORTCUT, REDO_SHORTCUT} from "./helpers/keyboard";

const textRange = (root: Locator, start: number, end = start) => root.evaluate((element, offsets) => {
    const position = (offset: number) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
            if (offset <= node.textContent!.length) {
                return {node, offset};
            }
            offset -= node.textContent!.length;
        }
        throw new Error("Text offset is outside the editor");
    };
    (element.closest('[contenteditable="true"]') as HTMLElement).focus();
    const from = position(offsets.start);
    const to = position(offsets.end);
    getSelection()!.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
}, {start, end});

const layout = (root: Locator, target: string) => root.evaluate((element, token) => {
    const content = element.textContent!;
    const nodes: {node: Node, start: number}[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    let offset = 0;
    while ((node = walker.nextNode())) {
        nodes.push({node, start: offset});
        offset += node.textContent!.length;
    }
    const rangeFor = (start: number, length: number) => {
        const range = document.createRange();
        const first = nodes.find(item => item.start + item.node.textContent!.length > start)!;
        const last = nodes.find(item => item.start + item.node.textContent!.length >= start + length)!;
        range.setStart(first.node, start - first.start);
        range.setEnd(last.node, start + length - last.start);
        return range;
    };
    const first = content.search(/[^\u200b\u2060\ufeff\s]/u);
    const top = rangeFor(first, 1).getBoundingClientRect().top;
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
    const splitWords = Array.from(content.matchAll(/[a-zA-Z]{2,31}/g))
        .filter(match => !/[a-zA-Z]/.test(content[match.index! - 1] || "") &&
            !/[a-zA-Z]/.test(content[match.index! + match[0].length] || ""))
        .filter(match => new Set(Array.from(rangeFor(match.index!, match[0].length).getClientRects())
            .filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size > 1)
        .map(match => match[0]);
    return {
        firstLine: (rangeFor(content.indexOf(token), 1).getBoundingClientRect().top - top) / lineHeight,
        lines: new Set(Array.from(rangeFor(content.indexOf(token), token.length).getClientRects())
            .filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size,
        splitWords,
        overflow: element.scrollWidth - element.clientWidth,
    };
}, target);

const examples = [
    {name: "Chinese and digits", text: "测试" + "1".repeat(94), run: "1".repeat(94)},
    {name: "Chinese and letters", text: "测试2" + "a".repeat(63), run: "a".repeat(63)},
    {name: "English and a space", text: "test 3" + "1".repeat(100), run: "3" + "1".repeat(100)},
    {name: "English without a space", text: "test4" + "1".repeat(100), run: "test4" + "1".repeat(100)},
];

test.beforeEach(async ({page}) => {
    await useDesktopFrontend(page);
});

for (const sample of examples) {
    test(`plain text: ${sample.name} fills the first task line`, async ({page, createTestDocument, siyuanAPI}, testInfo) => {
        const {editor, docID} = await createTestDocument("Plain Long Text Wrap E2E", "- [ ] " + sample.text);
        const editable = editor.locator('[data-type="NodeParagraph"] [contenteditable="true"]').first();
        for (const width of [800, 1000]) {
            await page.setViewportSize({width, height: 900});
            await expect.poll(async () => (await layout(editable, sample.run)).firstLine).toBeLessThan(0.5);
            const result = await layout(editable, sample.run);
            expect(result.lines).toBeGreaterThan(1);
            expect(result.overflow).toBeLessThanOrEqual(1);
            expect(result.splitWords).toEqual([]);
        }
        await testInfo.attach("wrapping", {
            body: await editable.screenshot({path: testInfo.outputPath("wrapping.png")}), contentType: "image/png",
        });
        const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
        expect(saved).toContain(`"Data":${JSON.stringify(sample.text)}`);
        expect(saved).not.toContain("data-inline-wrap");
        await page.reload();
        const reloaded = await getDocumentEditor(page, docID);
        await expect.poll(async () => (await layout(reloaded.locator('[data-type="NodeParagraph"] [contenteditable="true"]').first(),
            sample.run)).firstLine).toBeLessThan(0.5);
    });
}

const formats = [
    {name: "plain", format: (text: string) => text, selector: '[data-type="NodeParagraph"] [contenteditable="true"]', prefix: 0},
    {name: "code", format: (text: string) => "`" + text + "`", selector: 'span[data-type~="code"]', prefix: 1},
    {name: "tag", format: (text: string) => "#" + text + "#", selector: 'span[data-type~="tag"]', prefix: 1},
    {name: "kbd", format: (text: string) => "<kbd>" + text + "</kbd>", selector: 'span[data-type~="kbd"]', prefix: 1},
];

for (const format of formats) {
    test(`${format.name}: wraps long runs with spaces while preserving words and copied text`, async ({
        page, context, baseURL, createTestDocument, siyuanAPI,
    }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin: baseURL!});
        const run = "1".repeat(100);
        const text = "测试 ordinary " + run + " ordinary words remain intact " + "a".repeat(80) + " ending";
        const {editor, docID} = await createTestDocument("Spaced Long Text Wrap E2E", "- [ ] " + format.format(text));
        const inline = editor.locator(format.selector).first();
        for (const width of [800, 920, 1040, 1160, 1280]) {
            await page.setViewportSize({width, height: 900});
            await expect.poll(async () => (await layout(inline, run)).firstLine).toBeLessThan(0.5);
            expect((await layout(inline, run)).splitWords).toEqual([]);
        }
        await textRange(inline, format.prefix, format.prefix + text.length);
        await page.keyboard.press("ControlOrMeta+C");
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
        const rich = await page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const item = items.find(value => value.types.includes("text/html"));
            return item ? (await item.getType("text/html")).text() : "";
        });
        expect(rich).not.toContain("data-inline-wrap");
        const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
        expect(saved).toContain(JSON.stringify(text));
        expect(saved).not.toContain("data-inline-wrap");
        await page.reload();
        const reloaded = await getDocumentEditor(page, docID);
        await expect.poll(async () => (await layout(reloaded.locator(format.selector).first(), run)).firstLine).toBeLessThan(0.5);
    });

    test(`${format.name}: preserves editing and history across long-run boundaries`, async ({page, createTestDocument, siyuanAPI}) => {
        const {editor, docID} = await createTestDocument("Long Text Editing E2E", format.format("test " + "1".repeat(31)));
        const inline = editor.locator(format.selector).first();
        const savedText = async (text: string) => {
            await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain(JSON.stringify(text));
            await expect(inline).toHaveText(new RegExp(text + "$"));
        };
        await textRange(inline, format.prefix + 36);
        await page.keyboard.type("2");
        await savedText("test " + "1".repeat(31) + "2");
        await expect(inline.locator('[data-inline-wrap="token"]')).toHaveCount(1);
        await page.keyboard.press(UNDO_SHORTCUT);
        await savedText("test " + "1".repeat(31));
        await expect(inline.locator('[data-inline-wrap="token"]')).toHaveCount(0);
        await page.keyboard.press(REDO_SHORTCUT);
        await savedText("test " + "1".repeat(31) + "2");
        await textRange(inline, format.prefix + 21);
        await page.keyboard.type(" ");
        await savedText("test " + "1".repeat(16) + " " + "1".repeat(15) + "2");
        await expect(inline.locator('[data-inline-wrap="token"]')).toHaveCount(0);
        await page.keyboard.press("Backspace");
        await savedText("test " + "1".repeat(31) + "2");
        await expect(inline.locator('[data-inline-wrap="token"]')).toHaveCount(1);
        await textRange(inline, format.prefix + 5, format.prefix + 37);
        await page.keyboard.insertText("ordinary words remain intact");
        await savedText("test ordinary words remain intact");
        await expect(inline.locator('[data-inline-wrap="token"]')).toHaveCount(0);
        const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
        expect(saved).not.toContain("data-inline-wrap");
        await page.reload();
        const reloaded = await getDocumentEditor(page, docID);
        await expect(reloaded.locator(format.selector).first()).toContainText("test ordinary words remain intact");
    });

    test(`${format.name}: commits Chinese composition inside a long run at the original caret`, async ({
        page, context, createTestDocument, siyuanAPI,
    }) => {
        const text = "test " + "1".repeat(100) + " end";
        const {editor, docID} = await createTestDocument("Long Text Composition E2E", format.format(text));
        const inline = editor.locator(format.selector).first();
        await expect(inline.locator('[data-inline-wrap="token"]')).toHaveCount(1);
        await textRange(inline, format.prefix + 55);
        const cdp = await context.newCDPSession(page);
        try {
            await cdp.send("Input.imeSetComposition", {text: "测", selectionStart: 1, selectionEnd: 1});
            await expect(inline.locator('[data-inline-wrap="token"]')).toHaveCount(0);
            await cdp.send("Input.imeSetComposition", {text: "测试", selectionStart: 2, selectionEnd: 2});
            await cdp.send("Input.insertText", {text: "测试"});
        } finally {
            await cdp.detach();
        }
        const expected = "test " + "1".repeat(50) + "测试" + "1".repeat(50) + " end";
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain(JSON.stringify(expected));
        await page.keyboard.type(".");
        const final = expected.replace("测试", "测试.");
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain(JSON.stringify(final));
        const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
        expect(saved).not.toContain("data-inline-wrap");
        expect(saved).not.toContain("\u2060");
        await page.reload();
        const reloaded = await getDocumentEditor(page, docID);
        await expect(reloaded.locator(format.selector).first()).toContainText(final);
    });
}

test("plain text: formatting, splitting, and merging preserve the long run", async ({page, createTestDocument, siyuanAPI}) => {
    const run = "1".repeat(100);
    const text = "test " + run + " ordinary words";
    const {editor, docID} = await createTestDocument("Long Text Formatting E2E", text);
    const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]');
    await textRange(paragraphs.first(), 5, 105);
    await page.keyboard.press("ControlOrMeta+B");
    await expect(paragraphs.first().locator('span[data-type~="strong"]')).toHaveText(run);
    await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain('"TextMarkType":"strong"');
    await page.keyboard.press(UNDO_SHORTCUT);
    await expect(paragraphs.first().locator('span[data-type~="strong"]')).toHaveCount(0);
    await textRange(paragraphs.first(), 55);
    await page.keyboard.press("Enter");
    await expect(paragraphs).toHaveCount(2);
    await expect(paragraphs.nth(0)).toHaveText("test " + "1".repeat(50));
    await expect(paragraphs.nth(1)).toHaveText("1".repeat(50) + " ordinary words");
    await page.keyboard.press("Backspace");
    await expect(paragraphs).toHaveCount(1);
    await expect(paragraphs.first()).toHaveText(text);
    await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain(JSON.stringify(text));
    const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
    expect(saved).not.toContain("data-inline-wrap");
    expect(saved).not.toContain("\u200b");
    await page.reload();
    const reloaded = await getDocumentEditor(page, docID);
    await expect(reloaded.locator('[data-type="NodeParagraph"] [contenteditable="true"]').first()).toHaveText(text);
});

test("code blocks keep their own wrapping and source text", async ({createTestDocument, siyuanAPI}) => {
    const text = "ordinary " + "a".repeat(100) + " ending";
    const {editor, docID} = await createTestDocument("Long Text Code Block E2E", "```text\n" + text + "\n```");
    const code = editor.locator('[data-type="NodeCodeBlock"] .hljs');
    await expect(code).toContainText(text);
    await expect(code.locator("[data-inline-wrap]")).toHaveCount(0);
    const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
    expect(saved).toContain(text);
    expect(saved).not.toContain("data-inline-wrap");
});
