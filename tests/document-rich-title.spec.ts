import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface ITitleSource {
    text: string;
    revision: string;
    blockDOM: string;
    source: {spec: number; format: string; content: string} | null;
}

interface ISyDocument {
    ID: string;
    DocumentTitle?: unknown;
    Children: unknown[];
}

const getTitle = (page: Page, id: string) => page.locator(
    `.protyle-title[data-node-id="${id}"]:visible .protyle-title__rich .protyle-title__input`,
).last();

const readTitle = (api: SiyuanAPI, id: string) => api.post<ITitleSource>("/api/block/getDocTitle", {id});

const pasteParagraphIntoTitle = async (source: Locator, title: Locator, clear = false) => {
    await source.focus();
    const clipboard = await source.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        const data = new DataTransfer();
        element.dispatchEvent(new ClipboardEvent("copy", {bubbles: true, cancelable: true, clipboardData: data}));
        return Object.fromEntries(Array.from(data.types, type => [type, data.getData(type)]));
    });
    expect(clipboard["text/html"]).toBeTruthy();
    // 选中文字后粘贴单个引用会按原生规则创建静态锚文本；先清空才能验证动态引用。
    if (clear) await title.fill("");
    await title.focus();
    await title.evaluate((element, clipboard) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        const data = new DataTransfer();
        Object.entries(clipboard).forEach(([type, value]) => data.setData(type, value));
        element.dispatchEvent(new ClipboardEvent("paste", {bubbles: true, cancelable: true, clipboardData: data}));
    }, clipboard);
    await title.press("Tab");
};

test("rich title preserves inline styles and body through paste, reload and undo", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Rich Title Inline E2E",
        "**Bold** *Italic* ~~Strike~~ ==Mark== `Code` [Link](https://example.com) $x^2$ #Tag# :smile:");
    expect(await document.editor.evaluate(element => element.closest(".protyle-title") === null)).toBe(true);
    const before = await siyuanAPI.readDocument<ISyDocument>(document.docID);
    const initial = await readTitle(siyuanAPI, document.docID);
    const source = document.editor.locator('[data-type="NodeParagraph"] > [contenteditable]').first();
    const title = getTitle(page, document.docID);
    await expect(title).toBeVisible();
    await pasteParagraphIntoTitle(source, title);
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).source !== null).toBe(true);
    const saved = await readTitle(siyuanAPI, document.docID);
    for (const type of ["strong", "em", "s", "mark", "code", "a", "inline-math", "tag"]) {
        await expect(title.locator(`[data-type~="${type}"]`)).toHaveCount(1);
    }
    expect(saved.source).toMatchObject({spec: 1, format: "inline-ast"});
    expect(saved.revision).not.toBe(initial.revision);
    expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(before.Children);
    await title.focus();
    await title.press("ControlOrMeta+z");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe(initial.text);
    await title.press("ControlOrMeta+y");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).source).toEqual(saved.source);
    await page.reload();
    await getDocumentEditor(page, document.docID);
    await expect(getTitle(page, document.docID).locator('[data-type~="strong"]')).toHaveText("Bold");
    expect((await readTitle(siyuanAPI, document.docID)).source).toEqual(saved.source);
    expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(before.Children);
});

test("title block references create a root backlink and follow target renames", async ({
    page, createTestDocument, siyuanAPI, trackTestDocument,
}) => {
    const target = await createTestDocument("Rich Title Target E2E", "Independent reference target");
    const sourceID = await siyuanAPI.createDocument(target.notebookID, `Rich Title Ref E2E ${Date.now()}`,
        `((${target.docID} '${target.title}'))`);
    trackTestDocument({id: sourceID, notebookID: target.notebookID, title: "Rich Title Ref E2E"});
    await page.goto(`/stage/build/desktop/?id=${sourceID}`);
    const editor = await getDocumentEditor(page, sourceID);
    await pasteParagraphIntoTitle(editor.locator('[data-type="NodeParagraph"] > [contenteditable]').first(),
        getTitle(page, sourceID), true);
    await expect.poll(async () => (await readTitle(siyuanAPI, sourceID)).source?.content || "")
        .toContain(target.docID);
    await expect.poll(async () => {
        const rows = await siyuanAPI.post<Array<{block_id: string}>>("/api/query/sql", {
            stmt: `SELECT block_id FROM refs WHERE def_block_id='${target.docID}' AND block_id='${sourceID}'`,
        });
        return rows.length;
    }, {timeout: 30000}).toBe(1);
    const backlinks = await siyuanAPI.post<{backlinks: unknown[]}>("/api/ref/getBacklink2", {
        id: target.docID, notebook: target.notebookID, k: "", mk: "", includeMentions: false,
    });
    expect(JSON.stringify(backlinks.backlinks)).toContain(sourceID);
    await page.goto(`/stage/build/desktop/?id=${target.docID}`);
    await getDocumentEditor(page, target.docID);
    const renamed = `${target.title} renamed`;
    await getTitle(page, target.docID).fill(renamed);
    await getTitle(page, target.docID).press("Tab");
    await expect.poll(async () => (await readTitle(siyuanAPI, sourceID)).text, {timeout: 30000}).toBe(renamed);
    await page.goto(`/stage/build/desktop/?id=${sourceID}`);
    await getDocumentEditor(page, sourceID);
    await expect(getTitle(page, sourceID).locator(`[data-type~="block-ref"][data-id="${target.docID}"]`))
        .toHaveText(renamed);
});
