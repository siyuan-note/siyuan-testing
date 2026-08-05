import {ElementHandle, JSHandle, Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {selectTextRange} from "./helpers/selection";
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

interface IDragSession {
    dataTransfer: JSHandle<DataTransfer>;
    endTarget: ElementHandle<HTMLElement>;
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

const requestHistoryAction = async (page: Page, editor: Locator, shortcut: string,
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
                                      sourceID: string, query: string, paragraphIndex = 0) => {
    const paragraph = editor.locator(':scope > [data-type="NodeParagraph"]').nth(paragraphIndex);
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

const startGutterBlockDrag = async (page: Page, source: Locator) => {
    const id = await source.getAttribute("data-node-id");
    expect(id).toBeTruthy();
    await page.mouse.move(0, 0);
    await source.hover();
    const handle = page.locator(`.protyle-gutters button[data-node-id="${id}"] > span[draggable="true"]`);
    await expect(handle).toBeVisible();
    const endTarget = await handle.locator("xpath=../..").elementHandle() as ElementHandle<HTMLElement>;
    expect(endTarget).not.toBeNull();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer()) as JSHandle<DataTransfer>;
    await handle.dispatchEvent("dragstart", {dataTransfer});
    await expect.poll(() => dataTransfer.evaluate(transfer => Array.from(transfer.types).join(",")))
        .toContain("nodeparagraph");
    return {dataTransfer, endTarget} as IDragSession;
};

const finishDrag = async (session: IDragSession) => {
    await session.endTarget.dispatchEvent("dragend", {dataTransfer: session.dataTransfer});
    await session.dataTransfer.dispose();
};

const isReferenceCaretVisible = (page: Page) => page.evaluate(() =>
    Array.from(document.body.children).some(element => {
        const style = (element as HTMLElement).style;
        return style.zIndex === "1000000" && style.width === "2px" && style.pointerEvents === "none";
    }));

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

        await requestHistoryAction(page, target.editor, UNDO_SHORTCUT, "undo");
        await expect(target.editor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`)).toHaveCount(0);
        await requestHistoryAction(page, target.editor, REDO_SHORTCUT, "redo");
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
        await expect(target.editor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`))
            .toHaveText(updatedText, {timeout: 15000});

        await page.keyboard.press("ControlOrMeta+[");
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

    test("turns a partially deleted dynamic reference into a static reference", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const query = `Editable dynamic reference ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const source = await createTestDocument("Editable Dynamic Reference Source E2E", query);
        const sourceID = await source.editor.locator(':scope > [data-type="NodeParagraph"]').first()
            .getAttribute("data-node-id");
        expect(sourceID).toBeTruthy();
        await waitForIndexedBlock(siyuanAPI, query, sourceID!);

        const leadingText = "333333333333333333";
        const target = await createTestDocument(
            "Editable Dynamic Reference Target E2E",
            `${leadingText}\n\nAnchor: `,
        );
        let reference = await insertDynamicReference(
            page, siyuanAPI, target.docID, target.editor, sourceID!, query, 1);
        const paragraphs = target.editor.locator(':scope > [data-type="NodeParagraph"]');
        await expect(paragraphs).toHaveCount(2);
        const startOffset = 9;
        const remainingText = query.slice(-2);
        await selectTextRange(
            paragraphs.nth(0).locator('[contenteditable="true"]'),
            reference,
            startOffset,
            query.length - remainingText.length,
        );

        await requestTransaction(page, () => page.keyboard.press("Backspace"));
        await expect(paragraphs).toHaveCount(1);
        reference = target.editor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`);
        await expect(reference).toHaveAttribute("data-subtype", "s");
        await expect(reference).toHaveText(remainingText);
        await expect(paragraphs.first().locator('[contenteditable="true"]'))
            .toHaveText(leadingText.slice(0, startOffset) + remainingText);
        await expect.poll(() => getPersistedReferenceState(siyuanAPI, target.docID, sourceID!)).toEqual([{
            id: sourceID,
            subtype: "s",
            text: remainingText,
            type: "NodeTextMark",
        }]);

        await requestHistoryAction(page, target.editor, UNDO_SHORTCUT, "undo");
        await expect(paragraphs).toHaveCount(2);
        reference = target.editor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`);
        await expect(reference).toHaveAttribute("data-subtype", "d");
        await expect(reference).toHaveText(query);

        await requestHistoryAction(page, target.editor, REDO_SHORTCUT, "redo");
        await expect(paragraphs).toHaveCount(1);
        await expect(target.editor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`))
            .toHaveAttribute("data-subtype", "s");
    });

    test("shows a caret and inserts a reference when a block is dropped into an empty paragraph", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const sourceText = `Dragged reference ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const {docID, editor} = await createTestDocument("Dragged Reference E2E", sourceText);
        const source = editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const sourceID = await source.getAttribute("data-node-id");
        expect(sourceID).toBeTruthy();

        await focusAtEnd(source);
        await requestTransaction(page, () => page.keyboard.press("Enter"));
        const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
        await expect(paragraphs).toHaveCount(2);
        const target = paragraphs.last();
        await expect(target.locator('[contenteditable="true"]')).toBeEmpty();

        const session = await startGutterBlockDrag(page, source);
        const targetEditable = target.locator('[contenteditable="true"]');
        const box = await targetEditable.boundingBox();
        if (!box) {
            throw new Error("empty drop target is not visible");
        }
        const point = {
            clientX: box.x + Math.min(8, box.width / 2),
            clientY: box.y + box.height / 2,
        };
        await targetEditable.dispatchEvent("dragover", {
            altKey: true,
            dataTransfer: session.dataTransfer,
            ...point,
        });
        await expect.poll(() => isReferenceCaretVisible(page)).toBe(true);
        await expect(page.locator('[class*="dragover__"]')).toHaveCount(0);

        const transaction = page.waitForResponse(response =>
            new URL(response.url()).pathname === "/api/transactions", {timeout: 30000});
        await targetEditable.dispatchEvent("drop", {
            altKey: true,
            dataTransfer: session.dataTransfer,
            ...point,
        });
        await transaction;
        await finishDrag(session);
        await expect.poll(() => isReferenceCaretVisible(page)).toBe(false);

        let reference = target.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`);
        await expect(reference).toHaveText(sourceText);
        await expect(reference).toHaveAttribute("data-subtype", "d");
        await expect.poll(() => getPersistedReferenceState(siyuanAPI, docID, sourceID!),
            {timeout: 30000}).toEqual([{
            id: sourceID,
            subtype: "d",
            text: sourceText,
            type: "NodeTextMark",
        }]);

        await requestHistoryAction(page, editor, UNDO_SHORTCUT, "undo");
        await expect(target.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`)).toHaveCount(0);
        await requestHistoryAction(page, editor, REDO_SHORTCUT, "redo");
        reference = target.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`);
        await expect(reference).toHaveText(sourceText);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        await expect(reloadedEditor.locator(`[data-type~="block-ref"][data-id="${sourceID}"]`))
            .toHaveText(sourceText);
    });
});
