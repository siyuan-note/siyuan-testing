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

interface IListTreeItem {
    children: IListTreeItem[];
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

const getDOMListTree = async (editor: Locator): Promise<IListTreeItem[]> => editor.evaluate(element => {
    const visit = (item: Element): IListTreeItem => {
        const paragraph = Array.from(item.children).find(child => child.getAttribute("data-type") === "NodeParagraph");
        const list = Array.from(item.children).find(child => child.getAttribute("data-type") === "NodeList");
        return {
            children: list ? Array.from(list.children)
                .filter(child => child.getAttribute("data-type") === "NodeListItem")
                .map(visit) : [],
            text: paragraph?.querySelector('[contenteditable="true"]')?.textContent || "",
        };
    };
    const list = Array.from(element.children).find(child => child.getAttribute("data-type") === "NodeList");
    return list ? Array.from(list.children)
        .filter(child => child.getAttribute("data-type") === "NodeListItem")
        .map(visit) : [];
});

const getPersistedListTree = async (api: SiyuanAPI, docID: string): Promise<IListTreeItem[]> => {
    const document = await api.readDocument<ISyNode>(docID);
    const visit = (item: ISyNode): IListTreeItem => {
        const paragraph = item.Children?.find(child => child.Type === "NodeParagraph");
        const list = item.Children?.find(child => child.Type === "NodeList");
        return {
            children: list?.Children?.filter(child => child.Type === "NodeListItem").map(visit) || [],
            text: paragraph ? getNodeText(paragraph) : "",
        };
    };
    const list = document.Children?.find(child => child.Type === "NodeList");
    return list?.Children?.filter(child => child.Type === "NodeListItem").map(visit) || [];
};

const expectListTree = async (api: SiyuanAPI, docID: string, editor: Locator, tree: IListTreeItem[]) => {
    await expect.poll(() => getDOMListTree(editor)).toEqual(tree);
    await assertValidListDOM(editor);
    await assertValidSyListTree(api, docID, editor);
    await expect.poll(() => getPersistedListTree(api, docID)).toEqual(tree);
};

const getSelectionState = async (editor: Locator) => editor.evaluate(element => {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0) {
        return {collapsed: true, endID: "", startID: "", text: ""};
    }
    const range = selection.getRangeAt(0);
    const getBlockID = (node: Node) => {
        const target = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
        return target?.closest("[data-node-id]")?.getAttribute("data-node-id") || "";
    };
    return {
        collapsed: range.collapsed,
        endID: getBlockID(range.endContainer),
        startID: getBlockID(range.startContainer),
        text: selection.toString().replace(/[\s\u200b]/g, ""),
    };
});

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

const setCrossBlockRangeFromListItem = async (startEditable: Locator, endEditable: Locator, endOffset: number) => {
    const endElement = await endEditable.elementHandle();
    if (!endElement) {
        throw new Error("cross-block range end is unavailable");
    }
    try {
        return await startEditable.evaluate((startElement, options) => {
            const startListItem = startElement.closest('[data-type="NodeListItem"]');
            const endText = options.endElement.firstChild;
            if (!startListItem || !endText) {
                throw new Error("list-item range boundary is unavailable");
            }
            const range = document.createRange();
            range.setStartBefore(startListItem);
            range.setEnd(endText, options.endOffset);
            const selection = getSelection();
            if (!selection) {
                throw new Error("selection is unavailable");
            }
            selection.removeAllRanges();
            selection.addRange(range);
            return selection.toString();
        }, {endElement, endOffset});
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

    [
        {children: ["1", "2", "", "2", "3"], endIndex: 9, key: "Delete", selectedText: "331", startIndex: 7,
            title: "deletes"},
        {children: ["1", "2", "1", "2", "3"], endIndex: 9, key: "1", selectedText: "331", startIndex: 7,
            title: "replaces"},
        {children: ["1", "3"], endIndex: 10, key: "Delete", selectedText: "23312", startIndex: 6,
            title: "deletes a range with trailing start items from"},
        {children: ["1", "3"], endIndex: 10, key: "Backspace", selectedText: "23312", startIndex: 6,
            title: "backspaces a range with trailing start items from"},
        {children: ["1", "3"], endIndex: 10, key: "Delete", listItemBoundary: true, selectedText: "23312",
            startIndex: 6, title: "deletes a list-item-boundary range with trailing start items from"},
        {children: ["1", "1", "3"], endIndex: 10, key: "1", selectedText: "23312", startIndex: 6,
            title: "replaces a range with trailing start items in"},
        {children: ["1", "3"], endIndex: 10, key: "1", mergeIntoFirst: true, selectedText: "2123312",
            startIndex: 4, title: "replaces a fully selected outer list item in"},
    ].forEach(({children, endIndex, key, listItemBoundary, mergeIntoFirst, selectedText: expectedSelectedText,
                  startIndex, title}) => {
        test(`${title} a cross-block range between sibling nested lists and restores it on undo`, async ({
            page,
            createTestDocument,
            siyuanAPI,
        }) => {
            const {docID, editor} = await createTestDocument(
                `Sibling Nested List Cross Block ${title} E2E`,
                [
                    "* 1",
                    "    * 1",
                    "    * 2",
                    "    * 3",
                    "* 2",
                    "    * 1",
                    "    * 2",
                    "    * 3",
                    "* 3",
                    "    * 1",
                    "    * 2",
                    "    * 3",
                ].join("\n"),
            );
            const child = (text: string): IListTreeItem => ({children: [], text});
            const initialTree: IListTreeItem[] = [
                {children: [child("1"), child("2"), child("3")], text: "1"},
                {children: [child("1"), child("2"), child("3")], text: "2"},
                {children: [child("1"), child("2"), child("3")], text: "3"},
            ];
            const changedTree: IListTreeItem[] = mergeIntoFirst ? [{
                children: initialTree[0].children.concat(children.map(child)),
                text: "1",
            }] : [initialTree[0], {children: children.map(child), text: "2"}];
            await expectListTree(siyuanAPI, docID, editor, initialTree);

            const editables = editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]');
            const startEditable = editables.nth(startIndex);
            const endEditable = editables.nth(endIndex);
            const startID = await startEditable.locator("..").getAttribute("data-node-id");
            const endID = await endEditable.locator("..").getAttribute("data-node-id");
            const selectedText = listItemBoundary ?
                await setCrossBlockRangeFromListItem(startEditable, endEditable, 1) :
                await setCrossBlockRange(startEditable, 0, endEditable, 1);
            expect(selectedText.replace(/[\s\u200b]/g, "")).toBe(expectedSelectedText);

            await requestTransaction(page, () => page.keyboard.press(key));
            await expectListTree(siyuanAPI, docID, editor, changedTree);
            if (mergeIntoFirst) {
                await expect.poll(() => editor.evaluate(element => {
                    const range = getSelection()?.getRangeAt(0);
                    const container = range?.startContainer;
                    const target = container?.nodeType === Node.ELEMENT_NODE ? container as Element : container?.parentElement;
                    return {
                        collapsed: range?.collapsed || false,
                        id: target?.closest("[data-node-id]")?.getAttribute("data-node-id"),
                        offset: range?.startOffset,
                        text: container?.textContent,
                        withinEditor: !!container && element.contains(container),
                    };
                })).toEqual({
                    collapsed: true,
                    id: startID,
                    offset: 1,
                    text: "1",
                    withinEditor: true,
                });
            }

            await requestHistoryAction(page,
                editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]').first(),
                UNDO_SHORTCUT, "undo");
            await expectListTree(siyuanAPI, docID, editor, initialTree);
            await expect.poll(() => getSelectionState(editor)).toEqual({
                collapsed: false,
                endID,
                startID,
                text: expectedSelectedText,
            });
        });
    });
});
