import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface ISyNode {
    Data?: string;
    ID?: string;
    Properties?: Record<string, string>;
    Type?: string;
    Children?: ISyNode[];
}

const flattenNodes = (node: ISyNode): ISyNode[] => [
    node,
    ...(node.Children || []).flatMap(flattenNodes),
];

const getNodeText = (node: ISyNode): string =>
    (node.Data || "") + (node.Children || []).map(getNodeText).join("");

const readValidDocument = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    const nodes = flattenNodes(document);
    const ids = nodes.flatMap(node => node.ID ? [node.ID] : []);
    expect(ids.length - new Set(ids).size).toBe(0);
    expect(nodes.filter(node => node.ID && node.Properties?.id && node.ID !== node.Properties.id)).toHaveLength(0);
    return document;
};

const focusAtEnd = async (block: Locator) => {
    await block.locator('[contenteditable="true"]').first().evaluate(element => {
        element.focus();
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    });
};

const requestTransaction = async (page: Page, action: () => Promise<void>) => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === "/api/transactions", {timeout: 15000});
    await action();
    await response;
};

const requestHistoryAction = async (page: Page, editor: Locator, shortcut: string,
                                     action: "undo" | "redo") => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === `/api/transactions/${action}`, {timeout: 15000});
    const editable = editor.locator('[contenteditable="true"]').first();
    await focusAtEnd(editable.locator("xpath=ancestor::*[@data-node-id][1]"));
    await page.keyboard.press(shortcut);
    await response;
};

const waitForIndexedBlock = async (api: SiyuanAPI, query: string, blockID: string) => {
    await expect.poll(async () => {
        const result = await api.searchBlocks(query);
        return result.blocks.some(block => block.id === blockID);
    }, {timeout: 30000}).toBe(true);
};

const waitForPersistedBlockText = async (api: SiyuanAPI, docID: string, blockID: string, text: string) => {
    await expect.poll(async () => {
        const document = await readValidDocument(api, docID);
        const block = flattenNodes(document).find(node => node.ID === blockID);
        return block ? getNodeText(block) : "";
    }, {timeout: 30000}).toBe(text);
};

const getTopDOMState = async (editor: Locator) => editor.locator(":scope > [data-node-id]").evaluateAll(elements =>
    elements.map(element => ({
        content: element.getAttribute("data-content") || "",
        id: element.getAttribute("data-node-id") || "",
        text: element.querySelector(':scope > [contenteditable="true"]')?.textContent || "",
        type: element.getAttribute("data-type") || "",
    })));

const getPersistedEmbedState = async (api: SiyuanAPI, docID: string) => {
    const document = await readValidDocument(api, docID);
    const embed = (document.Children || []).find(node => node.Type === "NodeBlockQueryEmbed");
    return {
        id: embed?.ID || "",
        query: (embed?.Children || []).find(node => node.Type === "NodeBlockQueryEmbedScript")?.Data || "",
        topTypes: (document.Children || []).map(node => node.Type),
    };
};

const insertEmbedBlock = async (page: Page, api: SiyuanAPI, docID: string, editor: Locator,
                                sourceID: string, query: string) => {
    const paragraph = editor.locator(':scope > [data-type="NodeParagraph"]').first();
    const paragraphID = await paragraph.getAttribute("data-node-id");
    expect(paragraphID).toBeTruthy();
    await focusAtEnd(paragraph);
    await page.keyboard.type(`{{${query}`, {delay: 10});
    const protyle = editor.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle ')][1]");
    const hint = protyle.locator(".protyle-hint:not(.fn__none)");
    await expect(hint).toBeVisible();
    const sourceOption = hint.locator(`button:has([data-node-id="${sourceID}"])`).first();
    await expect(sourceOption).toBeVisible({timeout: 15000});
    await waitForPersistedBlockText(api, docID, paragraphID!, `{{${query}`);
    await requestTransaction(page, () => sourceOption.click());
    const embed = editor.locator(':scope > [data-type="NodeBlockQueryEmbed"]');
    await expect(embed).toHaveCount(1);
    await expect(embed).toHaveAttribute("data-content", `select * from blocks where id='${sourceID}'`);
    await expect(embed.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toBeVisible({timeout: 15000});
    return embed;
};

test.describe("block query embeds", () => {
    test.describe.configure({mode: "parallel"});

    test("inserts a query embed and restores it with undo and redo", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const query = `Embedded source ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const source = await createTestDocument("Query Embed Source E2E", query);
        const sourceID = await source.editor.locator(':scope > [data-type="NodeParagraph"]').first()
            .getAttribute("data-node-id");
        expect(sourceID).toBeTruthy();
        await waitForIndexedBlock(siyuanAPI, query, sourceID!);

        const target = await createTestDocument("Query Embed Target E2E");
        const initialState = await getTopDOMState(target.editor);
        const typedQueryState = initialState.map(item => ({...item, text: `{{${query}`}));
        let embed = await insertEmbedBlock(page, siyuanAPI, target.docID, target.editor, sourceID!, query);
        const embedID = await embed.getAttribute("data-node-id");
        expect(embedID).toBeTruthy();
        await expect(embed.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toContainText(query);
        await expect.poll(() => getPersistedEmbedState(siyuanAPI, target.docID), {timeout: 30000}).toEqual({
            id: embedID,
            query: `select * from blocks where id='${sourceID}'`,
            topTypes: ["NodeBlockQueryEmbed"],
        });

        await requestHistoryAction(page, target.editor, UNDO_SHORTCUT, "undo");
        await expect.poll(() => getTopDOMState(target.editor)).toEqual(typedQueryState);
        await requestHistoryAction(page, target.editor, REDO_SHORTCUT, "redo");
        embed = target.editor.locator(':scope > [data-type="NodeBlockQueryEmbed"]');
        await expect(embed).toHaveAttribute("data-node-id", embedID!);
        await expect(embed.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toContainText(query);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, target.docID);
        await expect(reloadedEditor.locator(`:scope > [data-node-id="${embedID}"]`)).toHaveAttribute(
            "data-content", `select * from blocks where id='${sourceID}'`);
        await expect(reloadedEditor.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toContainText(query);
    });

    test("edits a source block through an embed and refreshes the rendered result", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const query = `Editable embedded source ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const updatedText = `${query} updated`;
        const source = await createTestDocument("Editable Query Embed Source E2E", query);
        const sourceID = await source.editor.locator(':scope > [data-type="NodeParagraph"]').first()
            .getAttribute("data-node-id");
        expect(sourceID).toBeTruthy();
        await waitForIndexedBlock(siyuanAPI, query, sourceID!);

        const target = await createTestDocument("Editable Query Embed Target E2E");
        const embed = await insertEmbedBlock(page, siyuanAPI, target.docID, target.editor, sourceID!, query);
        const embeddedSource = embed.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"] [data-node-id="${sourceID}"]`);
        const editable = embeddedSource.locator('[contenteditable="true"]').first();
        await expect(editable).toHaveText(query);
        await editable.selectText();
        await page.keyboard.type(updatedText, {delay: 5});
        await waitForPersistedBlockText(siyuanAPI, source.docID, sourceID!, updatedText);
        await expect(editable).toHaveText(updatedText);

        const renderResponse = page.waitForResponse(item =>
            new URL(item.url()).pathname === "/api/search/searchEmbedBlock", {timeout: 15000});
        await embed.locator(".protyle-action__reload").click();
        await renderResponse;
        await expect(embed.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toContainText(updatedText);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, target.docID);
        await expect(reloadedEditor.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toContainText(updatedText);
    });
});
