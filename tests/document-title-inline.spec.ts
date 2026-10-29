import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";
import {getTitle, readTitle, setTitleSource} from "./helpers/richTitle";
import {UNDO_SHORTCUT, REDO_SHORTCUT} from "./helpers/keyboard";

interface IInlineNode extends Record<string, unknown> {
    Type: string;
    Data?: string;
    Children?: IInlineNode[];
    Properties?: Record<string, string>;
    TextMarkType?: string;
    TextMarkTextContent?: string;
}

interface ISyDocument {
    ID: string;
    Properties: Record<string, string>;
    DocumentTitle?: {spec: number; format: string; content: string};
    Children: unknown[];
}

const inlineNodes = (content: string) => JSON.parse(content) as IInlineNode[];
const appendAtEnd = async (page: Page, title: Locator, text: string) => {
    await title.focus();
    await title.evaluate(element => {
        const range = window.document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
    });
    await page.keyboard.insertText(text);
    await title.press("Tab");
};

test("all native text marks and combined styles retain their metadata through editing and reload", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Title All Text Marks E2E", "Body must remain unchanged");
    const body = (await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children;
    const marks: IInlineNode[] = ["strong", "em", "u", "s", "mark", "sup", "sub", "kbd", "code", "tag", "strong em u mark"]
        .map((type, index) => ({Type: "NodeTextMark", TextMarkType: type, TextMarkTextContent: `Style${index}`}));
    marks.push(
        // Native .sy attribute fields retain the editor's entity/newline encoding.
        {Type: "NodeTextMark", TextMarkType: "a", TextMarkTextContent: "Link", TextMarkAHref: "https://example.com/a?x=1&amp;y=2", TextMarkATitle: "Link &amp;quot;metadata&amp;quot;"},
        {Type: "NodeTextMark", TextMarkType: "inline-math", TextMarkInlineMathContent: "x^2 + \\frac{a}{b}"},
        {Type: "NodeTextMark", TextMarkType: "inline-memo", TextMarkTextContent: "Memo", TextMarkInlineMemoContent: 'Private note_esc_newline_with "quotes" and <markup>'},
        {Type: "NodeTextMark", TextMarkType: "file-annotation-ref", TextMarkTextContent: "Annotation", TextMarkFileAnnotationRefID: "assets/paper.pdf/20261030000001-abcdefg"},
    );
    marks[10].TextMarkFlashcardOcclusionID = "20261030000002-abcdefg";
    const nodes: IInlineNode[] = marks.flatMap(mark => [mark, {Type: "NodeText", Data: " | "}]);
    nodes.push({Type: "NodeText", Data: "End"});
    const saved = await setTitleSource(siyuanAPI, document.docID, nodes);
    expect(saved.text).not.toContain("Private note");
    expect(saved.text).not.toContain("assets/paper.pdf");
    await page.reload();
    await getDocumentEditor(page, document.docID);
    const title = getTitle(page, document.docID);
    for (const mark of marks) {
        const selector = mark.TextMarkType!.split(" ").map(type => `[data-type~="${type}"]`).join("");
        await expect(title.locator(selector).filter({hasText: mark.TextMarkTextContent || ""}).first()).toBeVisible();
    }
    await expect(title.locator('[data-type="inline-math"] .katex')).toBeVisible();
    await expect(title.locator('[data-type="a"]')).toHaveAttribute("data-href", "https://example.com/a?x=1&y=2");
    await appendAtEnd(page, title, "!");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe(`${saved.text}!`);
    const edited = await readTitle(siyuanAPI, document.docID);
    const editedNodes = inlineNodes(edited.source!.content);
    for (const mark of marks) {
        expect(editedNodes.find(node => node.TextMarkType === mark.TextMarkType), mark.TextMarkType).toEqual(mark);
    }
    expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(body);
    await page.reload();
    await getDocumentEditor(page, document.docID);
    expect((await readTitle(siyuanAPI, document.docID)).source).toEqual(edited.source);
    await expect(getTitle(page, document.docID).locator('[data-type="a"]'))
        .toHaveAttribute("data-href", "https://example.com/a?x=1&y=2");
    await expect(getTitle(page, document.docID).locator('[data-type="inline-memo"]'))
        .toHaveAttribute("data-inline-memo-content", 'Private note\nwith "quotes" and <markup>');
    await expect(getTitle(page, document.docID).locator('[data-type="file-annotation-ref"]'))
        .toHaveAttribute("data-id", "assets/paper.pdf/20261030000001-abcdefg");
});

test("font, color and background properties survive title editing without altering the body", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Title Inline Appearance E2E", "Independent body");
    const body = (await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children;
    const style = "color: var(--b3-font-color1); background-color: var(--b3-font-background1); font-family: monospace;";
    const mark: IInlineNode = {Type: "NodeTextMark", TextMarkType: "strong em", TextMarkTextContent: "Appearance", Properties: {style}};
    await setTitleSource(siyuanAPI, document.docID, [mark,
        {Type: "NodeKramdownSpanIAL", Data: `{: style="${style}"}`}, {Type: "NodeText", Data: " End"}]);
    await page.reload();
    await getDocumentEditor(page, document.docID);
    const styled = getTitle(page, document.docID).locator('[data-type~="strong"][data-type~="em"]');
    expect(await styled.evaluate(element => ({color: element.style.color, background: element.style.backgroundColor,
        font: element.style.fontFamily}))).toEqual({color: "var(--b3-font-color1)", background: "var(--b3-font-background1)", font: "monospace"});
    await appendAtEnd(page, getTitle(page, document.docID), "!");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe("Appearance End!");
    const saved = inlineNodes((await readTitle(siyuanAPI, document.docID)).source!.content);
    expect(saved.find(node => node.TextMarkTextContent === "Appearance")).toEqual(mark);
    await page.reload();
    await getDocumentEditor(page, document.docID);
    await expect(getTitle(page, document.docID).locator('[data-type~="strong"]')).toHaveCSS("font-family", "monospace");
    expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(body);
});

test("image-only titles with empty alt text retain source, size and tooltip instead of becoming empty titles", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Title Empty Alt Image E2E", "Independent body");
    const body = (await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8bUAAAAASUVORK5CYII=", "base64");
    const upload = await siyuanAPI.uploadAsset(document.docID, `title-inline-${Date.now()}.png`, "image/png", png);
    const asset = Object.values(upload.succMap)[0];
    const image: IInlineNode = {Type: "NodeImage", Data: "span", Properties: {style: "width: 42px;"}, Children: [
        {Type: "NodeBang"}, {Type: "NodeOpenBracket"}, {Type: "NodeLinkText"}, {Type: "NodeCloseBracket"}, {Type: "NodeOpenParen"},
        {Type: "NodeLinkDest", Data: asset}, {Type: "NodeLinkSpace"}, {Type: "NodeLinkTitle", Data: "Image metadata"}, {Type: "NodeCloseParen"},
    ]};
    const saved = await setTitleSource(siyuanAPI, document.docID, [image]);
    expect(saved.text).toBe("");
    expect(saved.empty).toBe(false);
    await page.reload();
    await getDocumentEditor(page, document.docID);
    let title = getTitle(page, document.docID);
    await expect(title.locator("img")).toHaveAttribute("src", asset);
    await expect(title.locator("img")).toHaveAttribute("data-title", "Image metadata");
    await expect(title.locator("img")).toHaveCSS("width", "42px");
    await appendAtEnd(page, title, " suffix");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toContain("suffix");
    const edited = inlineNodes((await readTitle(siyuanAPI, document.docID)).source!.content);
    expect(edited.find(node => node.Type === "NodeImage")).toEqual(image);
    await title.focus();
    await title.press(UNDO_SHORTCUT);
    // Native BlockDOM may add caret text and the paired image IAL node. Undo
    // must restore the complete image metadata and empty visible summary.
    await expect.poll(async () => {
        const restored = await readTitle(siyuanAPI, document.docID);
        return {text: restored.text, empty: restored.empty,
            image: inlineNodes(restored.source!.content).find(node => node.Type === "NodeImage")};
    }).toEqual({text: "", empty: false, image});
    await page.reload();
    await getDocumentEditor(page, document.docID);
    title = getTitle(page, document.docID);
    await expect(title.locator("img")).toBeVisible();
    expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Properties["custom-sy-title-empty"]).toBeUndefined();
    expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(body);
});

test("native escapes, entities, emoji and inline breaks remain editable without becoming body blocks", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Title Native Inline Nodes E2E", "Unchanged body");
    const body = (await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children;
    const nodes: IInlineNode[] = [
        {Type: "NodeText", Data: "Literal ** / ／ 中文 "},
        {Type: "NodeBackslash", Children: [{Type: "NodeBackslashContent", Data: "*"}]},
        {Type: "NodeHTMLEntity", Data: "©", HtmlEntityTokens: "JmNvcHk7"},
        {Type: "NodeEmoji", Children: [{Type: "NodeEmojiUnicode", Data: "😄", Children: [{Type: "NodeEmojiAlias", Data: ":smile:"}]}]},
        {Type: "NodeSoftBreak"}, {Type: "NodeText", Data: "Soft"},
        {Type: "NodeHardBreak"}, {Type: "NodeText", Data: "Hard"},
        {Type: "NodeBr", Data: "<br />"}, {Type: "NodeText", Data: "End"},
    ];
    const saved = await setTitleSource(siyuanAPI, document.docID, nodes);
    await page.reload();
    await getDocumentEditor(page, document.docID);
    const title = getTitle(page, document.docID);
    await expect(title).toContainText("©");
    await expect(title).toContainText("😄");
    await appendAtEnd(page, title, "!");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe(`${saved.text}!`);
    const source = await readTitle(siyuanAPI, document.docID);
    expect(inlineNodes(source.source!.content).some(node => node.Type === "NodeBackslash"
        && node.Children?.some(child => child.Data === "*"))).toBe(true);
    expect(source.source!.content).toContain("©");
    expect(source.source!.content).toContain("😄");
    await expect(title.locator('xpath=..')).toHaveAttribute("data-type", "NodeParagraph");
    expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(body);
    await page.reload();
    await getDocumentEditor(page, document.docID);
    expect((await readTitle(siyuanAPI, document.docID)).source).toEqual(source.source);
});

test("clearing a title persists an empty source without promoting the first body paragraph", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Title Empty Source E2E", "Body stays in the body");
    const body = (await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children;
    await getTitle(page, document.docID).fill("");
    await getTitle(page, document.docID).press("Tab");
    await expect.poll(async () => {
        const title = await readTitle(siyuanAPI, document.docID);
        return {text: title.text, empty: title.empty, nodes: inlineNodes(title.source!.content)};
    }).toEqual({text: "", empty: true, nodes: []});
    await page.reload();
    await getDocumentEditor(page, document.docID);
    expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(body);
    expect((await readTitle(siyuanAPI, document.docID)).source!.content).not.toContain("Body stays in the body");
});

for (const {markdown, html} of [
    {markdown: "- First\n- Second", html: "<ul><li>First</li><li>Second</li></ul>"},
    {markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |", html: "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"},
    {markdown: "First paragraph\n\nSecond paragraph", html: "<p>First paragraph</p><p>Second paragraph</p>"},
]) {
    test(`block-level paste preserves the title and body: ${markdown.split("\n")[0]}`, async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const document = await createTestDocument("Title Reject Block Paste E2E", markdown);
        const before = await readTitle(siyuanAPI, document.docID);
        const body = (await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children;
        const message = await page.evaluate(() => window.siyuan.languages.documentTitleInlineOnly);
        const title = getTitle(page, document.docID);
        await title.focus();
        await title.evaluate((element, clipboard) => {
            const range = window.document.createRange();
            range.selectNodeContents(element);
            getSelection()!.removeAllRanges();
            getSelection()!.addRange(range);
            const data = new DataTransfer();
            data.setData("text/html", clipboard.html);
            data.setData("text/plain", clipboard.markdown);
            element.dispatchEvent(new ClipboardEvent("paste", {bubbles: true, cancelable: true, clipboardData: data}));
        }, {html, markdown});
        await expect(page.locator(".b3-snackbar__content").filter({hasText: message})).toBeVisible();
        expect(await readTitle(siyuanAPI, document.docID)).toEqual(before);
        expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(body);
        await page.reload();
        await getDocumentEditor(page, document.docID);
        await expect(getTitle(page, document.docID)).toHaveText(before.text);
    });
}

test("cross-mark selection replacement, undo and redo preserve the unselected inline metadata", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Title Inline Selection E2E", "Unchanged body");
    const saved = await setTitleSource(siyuanAPI, document.docID, [
        {Type: "NodeTextMark", TextMarkType: "strong", TextMarkTextContent: "Bold"},
        {Type: "NodeTextMark", TextMarkType: "em", TextMarkTextContent: "Italic"},
        {Type: "NodeTextMark", TextMarkType: "inline-memo", TextMarkTextContent: "Memo", TextMarkInlineMemoContent: "Protected metadata"},
    ]);
    await page.reload();
    await getDocumentEditor(page, document.docID);
    const title = getTitle(page, document.docID);
    await title.focus();
    await title.evaluate(element => {
        const first = element.querySelector('[data-type="strong"]')!;
        const last = element.querySelector('[data-type="em"]')!;
        const range = window.document.createRange();
        range.setStart(first.firstChild!, 2);
        range.setEnd(last.firstChild!, 2);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
    });
    await page.keyboard.insertText("替换");
    await title.press("Tab");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe("Bo替换alicMemo");
    expect((await readTitle(siyuanAPI, document.docID)).source!.content).toContain("Protected metadata");
    await title.focus();
    await title.press(UNDO_SHORTCUT);
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).source).toEqual(saved.source);
    await title.press(REDO_SHORTCUT);
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe("Bo替换alicMemo");
    await page.reload();
    await getDocumentEditor(page, document.docID);
    await expect(getTitle(page, document.docID).locator('[data-type="inline-memo"]')).toHaveAttribute("data-inline-memo-content", "Protected metadata");
});

for (const boundary of [
    {name: "formatted trailing edge", plain: false, text: "Bold测试 suffix", bold: "Bold测试"},
    {name: "following plain text", plain: true, text: "Bold 测试suffix", bold: "Bold"},
]) {
    test(`Chromium composition commits Chinese text with native formatting at the ${boundary.name}`, async ({
        page, context, createTestDocument, siyuanAPI,
    }) => {
        const document = await createTestDocument("Title Composition Protocol E2E", "Independent body");
        await setTitleSource(siyuanAPI, document.docID, [
            {Type: "NodeTextMark", TextMarkType: "strong", TextMarkTextContent: "Bold"}, {Type: "NodeText", Data: " suffix"},
        ]);
        await page.reload();
        await getDocumentEditor(page, document.docID);
        const title = getTitle(page, document.docID);
        await title.focus();
        await title.evaluate((element, plain) => {
            const range = window.document.createRange();
            const strong = element.querySelector('[data-type="strong"]')!;
            if (plain) {
                range.setStart(strong.nextSibling!, 1);
            } else {
                range.setStartAfter(strong);
            }
            range.collapse(true);
            getSelection()!.removeAllRanges();
            getSelection()!.addRange(range);
        }, boundary.plain);
        const cdp = await context.newCDPSession(page);
        try {
            await cdp.send("Input.imeSetComposition", {text: "测", selectionStart: 1, selectionEnd: 1});
            await cdp.send("Input.imeSetComposition", {text: "测试", selectionStart: 2, selectionEnd: 2});
            await cdp.send("Input.insertText", {text: "测试"});
        } finally {
            await cdp.detach();
        }
        await title.press("Tab");
        await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe(boundary.text);
        await page.reload();
        await getDocumentEditor(page, document.docID);
        await expect(getTitle(page, document.docID).locator('[data-type="strong"]')).toHaveText(boundary.bold);
    });
}

test("Chromium composition cancellation preserves a neighboring formula and restores the insertion point", async ({
    page, context, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Title Composition Cancel E2E", "Independent body");
    await setTitleSource(siyuanAPI, document.docID, [
        {Type: "NodeTextMark", TextMarkType: "inline-math", TextMarkInlineMathContent: "x^2"},
        {Type: "NodeText", Data: " after"},
    ]);
    await page.reload();
    await getDocumentEditor(page, document.docID);
    const title = getTitle(page, document.docID);
    await title.focus();
    await title.evaluate(element => {
        const math = element.querySelector('[data-type="inline-math"]')!;
        const range = window.document.createRange();
        range.setStart(math.nextSibling!, 1);
        range.collapse(true);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
    });
    const cdp = await context.newCDPSession(page);
    try {
        await cdp.send("Input.imeSetComposition", {text: "测试", selectionStart: 2, selectionEnd: 2});
        await cdp.send("Input.imeSetComposition", {text: "", selectionStart: 0, selectionEnd: 0});
    } finally {
        await cdp.detach();
    }
    await page.keyboard.insertText("Done");
    await title.press("Tab");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe("x^2 Doneafter");
    const saved = await readTitle(siyuanAPI, document.docID);
    expect(inlineNodes(saved.source!.content).find(node => node.TextMarkType === "inline-math"))
        .toMatchObject({TextMarkInlineMathContent: "x^2"});
    await page.reload();
    await getDocumentEditor(page, document.docID);
    await expect(getTitle(page, document.docID).locator('[data-type="inline-math"] .katex')).toBeVisible();
});

const invalidSources = [
    {name: "unsupported version", source: {spec: 2, format: "inline-ast", content: "[]"}},
    {name: "unsupported format", source: {spec: 1, format: "markdown", content: "Title"}},
    {name: "block node", source: {spec: 1, format: "inline-ast", content: '[{"Type":"NodeParagraph"}]'}},
    {name: "raw inline HTML", source: {spec: 1, format: "inline-ast", content: '[{"Type":"NodeInlineHTML","Data":"<b>raw</b>"}]'}},
    {name: "duplicate inline fields", source: {spec: 1, format: "inline-ast", content: '[{"Type":"NodeText","Data":"first","Data":"second"}]'}},
    {name: "malformed inline JSON", source: {spec: 1, format: "inline-ast", content: "["}},
    {name: "NUL character", source: {spec: 1, format: "inline-ast", content: JSON.stringify([{Type: "NodeText", Data: "\u0000"}])}},
    {name: "source byte limit", source: {spec: 1, format: "inline-ast", content: JSON.stringify([{Type: "NodeText", Data: "x".repeat(1024 * 1024)}])}},
    {name: "source node limit", source: {spec: 1, format: "inline-ast", content: JSON.stringify(Array.from({length: 8193}, () => ({Type: "NodeText", Data: "x"})))}},
];
for (const {name, source} of invalidSources) {
    test(`invalid title source is rejected without changing saved content: ${name}`, async ({
        page, request, createTestDocument, siyuanAPI,
    }) => {
        const document = await createTestDocument("Title Invalid Source E2E", "Preserved body");
        const before = await setTitleSource(siyuanAPI, document.docID, [{Type: "NodeTextMark", TextMarkType: "strong", TextMarkTextContent: "Preserved title"}]);
        const body = (await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children;
        const response = await request.post("/api/transactions", {data: {
            app: "siyuan-testing", session: document.docID, reqId: Date.now(),
            transactions: [{doOperations: [{action: "setDocTitle", id: document.docID, data: {
                source, expectedRevision: before.revision,
            }}]}],
        }});
        expect(response.ok()).toBe(true);
        expect((await response.json() as {code: number}).code).not.toBe(0);
        expect(await readTitle(siyuanAPI, document.docID)).toEqual(before);
        expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(body);
        await page.reload();
        await getDocumentEditor(page, document.docID);
        await expect(getTitle(page, document.docID).locator('[data-type="strong"]')).toHaveText("Preserved title");
    });
}
