import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface ISyNode {
    Data?: string;
    ID?: string;
    Properties?: Record<string, string>;
    TextMarkBlockRefID?: string;
    TextMarkBlockRefSubtype?: string;
    TextMarkTextContent?: string;
    TextMarkType?: string;
    Type?: string;
    Children?: ISyNode[];
}

const flattenNodes = (node: ISyNode): ISyNode[] => [
    node,
    ...(node.Children || []).flatMap(flattenNodes),
];

const getNodeText = (node: ISyNode): string =>
    (node.Data || node.TextMarkTextContent || "") + (node.Children || []).map(getNodeText).join("");

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

const requestHistoryAction = async (page: Page, editor: Locator, shortcut: "Control+Z" | "Control+Y",
                                    action: "undo" | "redo") => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === `/api/transactions/${action}`, {timeout: 15000});
    await focusAtEnd(editor.locator('[data-type="NodeParagraph"]').first());
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

const insertDynamicReference = async (page: Page, api: SiyuanAPI, docID: string, editor: Locator,
                                      sourceID: string, query: string) => {
    const paragraph = editor.locator(':scope > [data-type="NodeParagraph"]').first();
    const paragraphID = await paragraph.getAttribute("data-node-id");
    expect(paragraphID).toBeTruthy();
    const initialText = await paragraph.locator('[contenteditable="true"]').textContent() || "";
    await focusAtEnd(paragraph);
    await page.keyboard.type(`((${query}`, {delay: 10});
    const protyle = editor.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle ')][1]");
    const hint = protyle.locator(".protyle-hint:not(.fn__none)");
    await expect(hint).toBeVisible();
    const sourceOption = hint.locator(`button:has([data-node-id="${sourceID}"])`).first();
    await expect(sourceOption).toBeVisible({timeout: 15000});
    await waitForPersistedBlockText(api, docID, paragraphID!, `${initialText}((${query}`);
    await requestTransaction(page, () => sourceOption.click());
    const reference = editor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`);
    await expect(reference).toHaveCount(1);
    await expect(reference).toHaveAttribute("data-subtype", "d");
    return reference;
};

const getPersistedReferenceState = async (api: SiyuanAPI, docID: string, sourceID: string) => {
    const document = await readValidDocument(api, docID);
    return flattenNodes(document)
        .filter(node => node.Type === "NodeTextMark" && node.TextMarkType?.split(" ").includes("block-ref") &&
            node.TextMarkBlockRefID === sourceID)
        .map(node => ({
            id: node.TextMarkBlockRefID || "",
            subtype: node.TextMarkBlockRefSubtype || "",
            text: node.TextMarkTextContent || "",
            type: node.Type || "",
        }));
};

test.describe("block references", () => {
    test.describe.configure({mode: "parallel"});

    test("inserts a dynamic block reference and restores it with undo and redo", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const query = `Dynamic reference source ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const source = await createTestDocument("Dynamic Reference Source E2E", query);
        const sourceBlock = source.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const sourceID = await sourceBlock.getAttribute("data-node-id");
        expect(sourceID).toBeTruthy();
        await waitForIndexedBlock(siyuanAPI, query, sourceID!);

        const target = await createTestDocument("Dynamic Reference Target E2E", "Reference: ");
        let reference = await insertDynamicReference(page, siyuanAPI, target.docID, target.editor, sourceID!, query);
        await expect(reference).toHaveText(query);
        await expect.poll(() => getPersistedReferenceState(siyuanAPI, target.docID, sourceID!),
            {timeout: 30000}).toEqual([{
            id: sourceID,
            subtype: "d",
            text: query,
            type: "NodeTextMark",
        }]);

        await requestHistoryAction(page, target.editor, "Control+Z", "undo");
        await expect(target.editor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`)).toHaveCount(0);
        await requestHistoryAction(page, target.editor, "Control+Y", "redo");
        reference = target.editor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`);
        await expect(reference).toHaveText(query);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, target.docID);
        await expect(reloadedEditor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`)).toHaveText(query);
    });

    test("navigates to a referenced block and refreshes its dynamic anchor text", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const query = `Navigable reference source ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const updatedText = `${query} updated`;
        const source = await createTestDocument("Navigable Reference Source E2E", query);
        const sourceBlock = source.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const sourceID = await sourceBlock.getAttribute("data-node-id");
        expect(sourceID).toBeTruthy();
        await waitForIndexedBlock(siyuanAPI, query, sourceID!);

        const target = await createTestDocument("Navigable Reference Target E2E", "Go to: ");
        const reference = await insertDynamicReference(page, siyuanAPI, target.docID, target.editor, sourceID!, query);
        await reference.click();

        const sourceEditor = await getDocumentEditor(page, source.docID);
        const sourceEditable = sourceEditor.locator(`[data-node-id="${sourceID}"] [contenteditable="true"]`);
        await expect(sourceEditable).toHaveText(query);
        await sourceEditable.selectText();
        await page.keyboard.type(updatedText, {delay: 5});
        await expect(sourceEditable).toHaveText(updatedText);
        await waitForPersistedBlockText(siyuanAPI, source.docID, sourceID!, updatedText);
        await expect.poll(() => getPersistedReferenceState(siyuanAPI, target.docID, sourceID!),
            {timeout: 30000}).toEqual([{
            id: sourceID,
            subtype: "d",
            text: updatedText,
            type: "NodeTextMark",
        }]);

        await page.keyboard.press("Control+[");
        const targetEditor = await getDocumentEditor(page, target.docID);
        const updatedReference = targetEditor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`);
        await expect(updatedReference).toHaveText(updatedText);
        await expect.poll(() => getPersistedReferenceState(siyuanAPI, target.docID, sourceID!),
            {timeout: 30000}).toEqual([{
            id: sourceID,
            subtype: "d",
            text: updatedText,
            type: "NodeTextMark",
        }]);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, target.docID);
        await expect(reloadedEditor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`)).toHaveText(updatedText);
    });
});
