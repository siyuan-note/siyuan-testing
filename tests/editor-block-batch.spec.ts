import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {PRIMARY_MODIFIER, REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {selectTextRange} from "./helpers/selection";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

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

const expectSelectedIDs = async (editor: Locator, expectedIDs: string[]) => {
    await expect.poll(() => editor.locator(":scope > .protyle-wysiwyg--select").evaluateAll(elements =>
        elements.map(element => element.getAttribute("data-node-id") || ""))).toEqual(expectedIDs);
};

const selectContiguousBlocks = async (blocks: Locator, editor: Locator, start: number, end: number,
                                      expectedIDs: string[]) => {
    await blocks.nth(start).locator('[contenteditable="true"]').click();
    await blocks.nth(end).click({modifiers: ["Shift"]});
    await expectSelectedIDs(editor, expectedIDs);
};

const selectSeparateBlocks = async (blocks: Locator, editor: Locator, indexes: number[], expectedIDs: string[]) => {
    for (const index of indexes) {
        await blocks.nth(index).click({modifiers: [PRIMARY_MODIFIER]});
    }
    await expectSelectedIDs(editor, expectedIDs);
};

const requestHistoryAction = async (page: Page, editor: Locator, shortcut: string,
                                     action: "undo" | "redo") => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === `/api/transactions/${action}`, {timeout: 30000});
    const paragraph = editor.locator(':scope > [data-type="NodeParagraph"]').first();
    await focusAtEnd(paragraph);
    await page.keyboard.press(shortcut);
    await response;
};

const requestTransaction = async (page: Page, action: () => Promise<void>) => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === "/api/transactions", {timeout: 15000});
    await action();
    await response;
};

test.describe("multi-block keyboard operations", () => {
    test.describe.configure({mode: "parallel"});

    test("selects container list items from a cross-block text range like shift-click", async ({
        createTestDocument,
        page,
    }) => {
        const {editor} = await createTestDocument(
            "Container List Item Range Selection E2E",
            [
                "* First item",
                "    * First child",
                "* Second item",
                "    * Second child",
            ].join("\n"),
        );
        const listItems = editor.locator(
            ':scope > [data-type="NodeList"] > [data-type="NodeListItem"]',
        );
        await expect(listItems).toHaveCount(2);
        const expectedIDs = await listItems.evaluateAll(elements =>
            elements.map(element => element.getAttribute("data-node-id") || ""));
        const startEditable = listItems.nth(0).locator(
            ':scope > [data-type="NodeParagraph"] > [contenteditable="true"]',
        );
        const endEditable = listItems.nth(1).locator(
            ':scope > [data-type="NodeParagraph"] > [contenteditable="true"]',
        );
        await selectTextRange(startEditable, endEditable, 1, Math.max(1, (await endEditable.textContent() || "").length - 1));

        await page.keyboard.press("Escape");
        const selectedBlocks = editor.locator(".protyle-wysiwyg--select");
        await expect.poll(() => selectedBlocks.evaluateAll(elements => elements.map(element => ({
            id: element.getAttribute("data-node-id") || "",
            type: element.getAttribute("data-type") || "",
        })))).toEqual(expectedIDs.map(id => ({id, type: "NodeListItem"})));

        await selectedBlocks.evaluateAll(elements => elements.forEach(element =>
            element.classList.remove("protyle-wysiwyg--select")));
        await startEditable.click();
        await endEditable.click({modifiers: ["Shift"]});
        await expect.poll(() => selectedBlocks.evaluateAll(elements =>
            elements.map(element => element.getAttribute("data-node-id") || ""))).toEqual(expectedIDs);
    });

    test("deletes a contiguous block selection and restores it with undo and redo", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Contiguous Block Delete E2E",
            "First\n\nSecond\n\nThird\n\nFourth\n\nFifth",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        expect(initialState.map(item => item.text)).toEqual(["First", "Second", "Third", "Fourth", "Fifth"]);
        const blocks = editor.locator(':scope > [data-type="NodeParagraph"]');
        await selectContiguousBlocks(
            blocks,
            editor,
            1,
            3,
            initialState.slice(1, 4).map(item => item.id),
        );

        await requestTransaction(page, () => page.keyboard.press("Backspace"));
        const deletedState = [initialState[0], initialState[4]];
        await expectDocumentState(siyuanAPI, docID, editor, deletedState);

        await requestHistoryAction(page, editor, UNDO_SHORTCUT, "undo");
        await expectDocumentState(siyuanAPI, docID, editor, initialState);

        await requestHistoryAction(page, editor, REDO_SHORTCUT, "redo");
        await expectDocumentState(siyuanAPI, docID, editor, deletedState);

        await page.reload();
        await expectDocumentState(siyuanAPI, docID, await getDocumentEditor(page, docID), deletedState);
    });

    test("deletes a non-contiguous block selection without removing blocks between it", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Noncontiguous Block Delete E2E",
            "Keep first\n\nDelete second\n\nKeep third\n\nDelete fourth\n\nKeep fifth",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        const blocks = editor.locator(':scope > [data-type="NodeParagraph"]');
        await selectSeparateBlocks(
            blocks,
            editor,
            [1, 3],
            [initialState[1].id, initialState[3].id],
        );

        await requestTransaction(page, () => page.keyboard.press("Delete"));
        const deletedState = [initialState[0], initialState[2], initialState[4]];
        await expectDocumentState(siyuanAPI, docID, editor, deletedState);

        await requestHistoryAction(page, editor, UNDO_SHORTCUT, "undo");
        await expectDocumentState(siyuanAPI, docID, editor, initialState);

        await requestHistoryAction(page, editor, REDO_SHORTCUT, "redo");
        await expectDocumentState(siyuanAPI, docID, editor, deletedState);
    });

    test("duplicates selected blocks with new IDs and restores the transaction", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Multiple Block Duplicate E2E",
            "Before\n\nDuplicate first\n\nDuplicate second\n\nAfter",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        const blocks = editor.locator(':scope > [data-type="NodeParagraph"]');
        await selectContiguousBlocks(
            blocks,
            editor,
            1,
            2,
            initialState.slice(1, 3).map(item => item.id),
        );

        await requestTransaction(page, () => page.keyboard.press("ControlOrMeta+D"));
        await expect(blocks).toHaveCount(6);
        const duplicatedState = (await getDOMState(editor)).paragraphs;
        expect(duplicatedState.map(item => item.text)).toEqual([
            "Before",
            "Duplicate first",
            "Duplicate second",
            "Duplicate first",
            "Duplicate second",
            "After",
        ]);
        expect(duplicatedState.slice(3, 5).map(item => item.id)).not.toEqual(
            initialState.slice(1, 3).map(item => item.id),
        );
        expect(new Set(duplicatedState.map(item => item.id)).size).toBe(6);
        await expectDocumentState(siyuanAPI, docID, editor, duplicatedState);

        await requestHistoryAction(page, editor, UNDO_SHORTCUT, "undo");
        await expectDocumentState(siyuanAPI, docID, editor, initialState);

        await requestHistoryAction(page, editor, REDO_SHORTCUT, "redo");
        await expectDocumentState(siyuanAPI, docID, editor, duplicatedState);

        await page.reload();
        await expectDocumentState(siyuanAPI, docID, await getDocumentEditor(page, docID), duplicatedState);
    });

    test("duplicates every block covered by a cross-block text range", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Cross-block Text Range Duplicate E2E",
            "Before\n\nDuplicate first\n\nDuplicate second\n\nAfter",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        const blocks = editor.locator(':scope > [data-type="NodeParagraph"]');
        await selectTextRange(
            blocks.nth(1).locator('[contenteditable="true"]'),
            blocks.nth(2).locator('[contenteditable="true"]'),
            3,
            6,
        );

        await requestTransaction(page, () => page.keyboard.press("ControlOrMeta+D"));
        await expect(blocks).toHaveCount(6);
        const duplicatedState = (await getDOMState(editor)).paragraphs;
        expect(duplicatedState.map(item => item.text)).toEqual([
            "Before",
            "Duplicate first",
            "Duplicate second",
            "Duplicate first",
            "Duplicate second",
            "After",
        ]);
        expect(duplicatedState.slice(3, 5).map(item => item.id)).not.toEqual(
            initialState.slice(1, 3).map(item => item.id),
        );
        await expectDocumentState(siyuanAPI, docID, editor, duplicatedState);

        await requestHistoryAction(page, editor, UNDO_SHORTCUT, "undo");
        await expectDocumentState(siyuanAPI, docID, editor, initialState);

        await requestHistoryAction(page, editor, REDO_SHORTCUT, "redo");
        await expectDocumentState(siyuanAPI, docID, editor, duplicatedState);
    });

    test("moves selected blocks down and up while preserving their order and IDs", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Multiple Block Move E2E",
            "First\n\nMove first\n\nMove second\n\nCrossed block\n\nLast",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        const blocks = editor.locator(':scope > [data-type="NodeParagraph"]');
        const selectedIDs = initialState.slice(1, 3).map(item => item.id);
        await selectContiguousBlocks(blocks, editor, 1, 2, selectedIDs);

        await requestTransaction(page, () => page.keyboard.press("ControlOrMeta+Shift+ArrowDown"));
        const movedState = [initialState[0], initialState[3], initialState[1], initialState[2], initialState[4]];
        await expectDocumentState(siyuanAPI, docID, editor, movedState);
        await expectSelectedIDs(editor, selectedIDs);

        await requestHistoryAction(page, editor, UNDO_SHORTCUT, "undo");
        await expectDocumentState(siyuanAPI, docID, editor, initialState);

        await requestHistoryAction(page, editor, REDO_SHORTCUT, "redo");
        await expectDocumentState(siyuanAPI, docID, editor, movedState);

        await requestTransaction(page, () => page.keyboard.press("ControlOrMeta+Shift+ArrowUp"));
        await expectDocumentState(siyuanAPI, docID, editor, initialState);

        await page.reload();
        await expectDocumentState(siyuanAPI, docID, await getDocumentEditor(page, docID), initialState);
    });

    test("does not move selected blocks beyond document boundaries", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Multiple Block Move Boundary E2E",
            "First\n\nSecond\n\nThird\n\nFourth",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        const blocks = editor.locator(':scope > [data-type="NodeParagraph"]');

        await selectContiguousBlocks(blocks, editor, 0, 1, initialState.slice(0, 2).map(item => item.id));
        await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
        await expectDocumentState(siyuanAPI, docID, editor, initialState);

        await blocks.nth(0).click();
        await expectSelectedIDs(editor, []);
        await selectContiguousBlocks(blocks, editor, 2, 3, initialState.slice(2, 4).map(item => item.id));
        await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");
        await expectDocumentState(siyuanAPI, docID, editor, initialState);
    });
});
