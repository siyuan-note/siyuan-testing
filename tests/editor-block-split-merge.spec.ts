import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";
import {assertValidListDOM, assertValidSyListTree} from "./helpers/listAssertions";

interface ISyNode {
    ID?: string;
    Data?: string;
    Type?: string;
    Properties?: Record<string, string>;
    Children?: ISyNode[];
}

interface IParagraphState {
    id: string;
    text: string;
}

interface IListState {
    items: number;
    lists: number;
    paragraphs: string[];
}

const flattenNodes = (node: ISyNode): ISyNode[] => [
    node,
    ...(node.Children || []).flatMap(flattenNodes),
];

const getNodeText = (node: ISyNode): string =>
    (node.Data || "") + (node.Children || []).map(getNodeText).join("");

const getDOMState = async (editor: Locator) => {
    const paragraphs = await editor.locator(':scope > [data-type="NodeParagraph"]').evaluateAll(elements =>
        elements.map(element => ({
            id: element.getAttribute("data-node-id") || "",
            text: element.querySelector('[contenteditable="true"]')?.textContent || "",
        })));
    const ids = await editor.locator("[data-node-id]").evaluateAll(elements =>
        elements.map(element => element.getAttribute("data-node-id") || "").filter(Boolean));
    return {
        duplicateIDs: ids.length - new Set(ids).size,
        paragraphs,
    };
};

const getPersistedState = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    const nodes = flattenNodes(document);
    const ids = nodes.flatMap(node => node.ID ? [node.ID] : []);
    return {
        duplicateIDs: ids.length - new Set(ids).size,
        mismatchedPropertyIDs: nodes.filter(node =>
            node.ID && node.Properties?.id && node.ID !== node.Properties.id).length,
        paragraphs: (document.Children || [])
            .filter(node => node.Type === "NodeParagraph")
            .map(node => ({id: node.ID || "", text: getNodeText(node)})),
    };
};

const expectDocumentState = async (api: SiyuanAPI, docID: string, editor: Locator,
                                   paragraphs: IParagraphState[]) => {
    await expect.poll(() => getDOMState(editor)).toEqual({
        duplicateIDs: 0,
        paragraphs,
    });
    await expect.poll(() => getPersistedState(api, docID)).toEqual({
        duplicateIDs: 0,
        mismatchedPropertyIDs: 0,
        paragraphs,
    });
};

const getDOMListState = async (editor: Locator): Promise<IListState> => editor.evaluate(element => ({
    items: element.querySelectorAll('[data-type="NodeListItem"]').length,
    lists: element.querySelectorAll('[data-type="NodeList"]').length,
    paragraphs: Array.from(element.querySelectorAll<HTMLElement>('[data-type="NodeParagraph"]'))
        .map(item => item.querySelector('[contenteditable="true"]')?.textContent || ""),
}));

const getPersistedListState = async (api: SiyuanAPI, docID: string): Promise<IListState> => {
    const document = await api.readDocument<ISyNode>(docID);
    const nodes = flattenNodes(document);
    return {
        items: nodes.filter(node => node.Type === "NodeListItem").length,
        lists: nodes.filter(node => node.Type === "NodeList").length,
        paragraphs: nodes.filter(node => node.Type === "NodeParagraph").map(getNodeText),
    };
};

const expectListState = async (api: SiyuanAPI, docID: string, editor: Locator, state: IListState) => {
    await expect.poll(() => getDOMListState(editor)).toEqual(state);
    await assertValidListDOM(editor);
    await assertValidSyListTree(api, docID, editor);
    await expect.poll(() => getPersistedListState(api, docID)).toEqual(state);
};

const setCaretOffset = async (editable: Locator, offset: number) => {
    const result = await editable.evaluate((element, requestedOffset) => {
        element.focus();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let remaining = requestedOffset;
        let textNode = walker.nextNode();
        while (textNode && remaining > (textNode.textContent || "").length) {
            remaining -= (textNode.textContent || "").length;
            textNode = walker.nextNode();
        }
        if (!textNode) {
            throw new Error(`cannot place caret at offset ${requestedOffset}`);
        }
        const range = document.createRange();
        range.setStart(textNode, remaining);
        range.collapse(true);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
        return {
            selected: element.contains(selection.anchorNode),
            text: element.textContent || "",
        };
    }, offset);
    expect(result.selected).toBe(true);
    return result.text;
};

const setCrossBlockRange = async (startEditable: Locator, startOffset: number,
                                  endEditable: Locator, endOffset: number) => {
    const endElement = await endEditable.elementHandle();
    if (!endElement) {
        throw new Error("cross-block range end is unavailable");
    }
    try {
        return await startEditable.evaluate((startElement, options) => {
            const getTextPoint = (element: Element, requestedOffset: number) => {
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                let remaining = requestedOffset;
                let textNode = walker.nextNode();
                while (textNode && remaining > (textNode.textContent || "").length) {
                    remaining -= (textNode.textContent || "").length;
                    textNode = walker.nextNode();
                }
                if (!textNode) {
                    throw new Error(`cannot place selection at offset ${requestedOffset}`);
                }
                return {node: textNode, offset: remaining};
            };
            startElement.focus();
            const start = getTextPoint(startElement, options.startOffset);
            const end = getTextPoint(options.endElement, options.endOffset);
            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            const selection = getSelection();
            if (!selection) {
                throw new Error("selection is unavailable");
            }
            selection.removeAllRanges();
            selection.addRange(range);
            return selection.toString();
        }, {endElement, endOffset, startOffset});
    } finally {
        await endElement.dispose();
    }
};

const requestTransaction = async (page: Page, action: () => Promise<void>) => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === "/api/transactions", {timeout: 15000});
    await action();
    await response;
};

const requestHistoryAction = async (page: Page, editable: Locator, shortcut: string,
                                     action: "undo" | "redo") => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === `/api/transactions/${action}`, {timeout: 15000});
    const text = await editable.textContent();
    await setCaretOffset(editable, text?.length || 0);
    await page.keyboard.press(shortcut);
    await response;
};

test.describe("paragraph splitting and merging", () => {
    test.describe.configure({mode: "parallel"});

    test("splits a paragraph at the caret and restores it with undo and redo", async ({
        page,
        createTestDocument,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument("Paragraph Split E2E", "AlphaBeta");
        const initialState = await getDOMState(editor);
        expect(initialState.paragraphs).toHaveLength(1);
        const initialID = initialState.paragraphs[0].id;
        const editable = editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]').first();
        expect(await setCaretOffset(editable, 5)).toBe("AlphaBeta");

        await requestTransaction(page, () => page.keyboard.press("Enter"));
        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(2);
        const splitState = (await getDOMState(editor)).paragraphs;
        expect(splitState.map(item => item.text)).toEqual(["Alpha", "Beta"]);
        expect(splitState.filter(item => item.id === initialID)).toHaveLength(1);
        expect(new Set(splitState.map(item => item.id)).size).toBe(2);
        await expectDocumentState(siyuanAPI, docID, editor, splitState);

        await requestHistoryAction(page,
            editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]').first(),
            UNDO_SHORTCUT, "undo");
        await expectDocumentState(siyuanAPI, docID, editor, [{id: initialID, text: "AlphaBeta"}]);

        await requestHistoryAction(page,
            editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]').first(),
            REDO_SHORTCUT, "redo");
        await expectDocumentState(siyuanAPI, docID, editor, splitState);

        await page.reload();
        await expectDocumentState(siyuanAPI, docID, await getDocumentEditor(page, docID), splitState);
    });

    [
        {key: "Backspace" as const, name: "backspace at the start of the second paragraph", offset: 0},
        {key: "Delete" as const, name: "delete at the end of the first paragraph", offset: 5},
    ].forEach(({key, name, offset}) => {
        test(`merges paragraphs with ${name} and restores them with undo and redo`, async ({
            page,
            createTestDocument,
            siyuanAPI,
        }) => {
            const {docID, editor} = await createTestDocument(`Paragraph Merge ${key} E2E`, "First\n\nSecond");
            const initialParagraphs = (await getDOMState(editor)).paragraphs;
            expect(initialParagraphs.map(item => item.text)).toEqual(["First", "Second"]);
            const editables = editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]');
            const editable = key === "Backspace" ? editables.nth(1) : editables.nth(0);
            expect(await setCaretOffset(editable, offset)).toBe(key === "Backspace" ? "Second" : "First");

            await requestTransaction(page, () => page.keyboard.press(key));
            await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(1);
            const mergedState = (await getDOMState(editor)).paragraphs;
            expect(mergedState.map(item => item.text)).toEqual(["FirstSecond"]);
            expect(initialParagraphs.map(item => item.id)).toContain(mergedState[0].id);
            await expectDocumentState(siyuanAPI, docID, editor, mergedState);

            await requestHistoryAction(page,
                editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]').first(),
                UNDO_SHORTCUT, "undo");
            await expectDocumentState(siyuanAPI, docID, editor, initialParagraphs);

            await requestHistoryAction(page,
                editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]').first(),
                REDO_SHORTCUT, "redo");
            await expectDocumentState(siyuanAPI, docID, editor, mergedState);

            await page.reload();
            await expectDocumentState(siyuanAPI, docID, await getDocumentEditor(page, docID), mergedState);
        });
    });

    test("deletes a cross-block range across nested list levels without leaving empty containers", async ({
        page,
        createTestDocument,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Nested List Cross Block Delete E2E",
            "* a1\n    * 2\n        * 3\n            * 4b",
        );
        const initialState = {
            items: 4,
            lists: 4,
            paragraphs: ["a1", "2", "3", "4b"],
        };
        const mergedState = {
            items: 1,
            lists: 1,
            paragraphs: ["ab"],
        };
        await expectListState(siyuanAPI, docID, editor, initialState);

        const editables = editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]');
        await expect(editables).toHaveCount(4);
        const selectedText = await setCrossBlockRange(editables.first(), 1, editables.last(), 1);
        expect(selectedText.replace(/[\s\u200b]/g, "")).toBe("1234");

        await requestTransaction(page, () => page.keyboard.press("Backspace"));
        await expectListState(siyuanAPI, docID, editor, mergedState);

        await requestHistoryAction(page,
            editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]').first(),
            UNDO_SHORTCUT, "undo");
        await expectListState(siyuanAPI, docID, editor, initialState);

        await requestHistoryAction(page,
            editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]').first(),
            REDO_SHORTCUT, "redo");
        await expectListState(siyuanAPI, docID, editor, mergedState);

        await page.reload();
        await expectListState(siyuanAPI, docID, await getDocumentEditor(page, docID), mergedState);
    });
});
