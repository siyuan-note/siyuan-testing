import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {PRIMARY_MODIFIER, REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";
import {assertValidListDOM, assertValidSyListTree} from "./helpers/listAssertions";

interface ISyNode {
    ID?: string;
    Data?: string;
    Type?: string;
    Properties?: Record<string, string>;
    TextMarkTextContent?: string;
    TextMarkType?: string;
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
    (node.Data || node.TextMarkTextContent || "") + (node.Children || []).map(getNodeText).join("");

const getPersistedTextMarks = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    return flattenNodes(document).filter(node => node.Type === "NodeTextMark").map(node => ({
        text: node.TextMarkTextContent || "",
        type: node.TextMarkType || "",
    }));
};

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
    return Array.from(element.children).filter(child => child.getAttribute("data-type") === "NodeList")
        .flatMap(list => Array.from(list.children)
            .filter(child => child.getAttribute("data-type") === "NodeListItem")
            .map(visit));
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
    return document.Children?.filter(child => child.Type === "NodeList").flatMap(list =>
        list.Children?.filter(child => child.Type === "NodeListItem").map(visit) || []) || [];
};

const expectListTree = async (api: SiyuanAPI, docID: string, editor: Locator, tree: IListTreeItem[]) => {
    await expect.poll(() => getDOMListTree(editor)).toEqual(tree);
    await assertValidListDOM(editor);
    await assertValidSyListTree(api, docID, editor);
    await expect.poll(() => getPersistedListTree(api, docID)).toEqual(tree);
};

const getSiblingNestedListMarkdown = (subtype: "t" | "u") => {
    const marker = () => subtype === "t" ? "* [ ]" : "*";
    return ["1", "2", "3"].flatMap(outer => [
        `${marker()} ${outer}`,
        ...["1", "2", "3"].map(inner => `    ${marker()} ${inner}`),
    ]).join("\n");
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
    const pageErrors: string[] = [];
    const pageErrorListener = (error: Error) => pageErrors.push(error.message);
    page.on("pageerror", pageErrorListener);
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === "/api/transactions", {timeout: 15000});
    try {
        await action();
        await response;
    } finally {
        page.off("pageerror", pageErrorListener);
    }
    expect(pageErrors).toEqual([]);
};

const requestHistoryAction = async (page: Page, editable: Locator, shortcut: string,
                                     action: "undo" | "redo") => {
    const pageErrors: string[] = [];
    const pageErrorListener = (error: Error) => pageErrors.push(error.message);
    page.on("pageerror", pageErrorListener);
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === `/api/transactions/${action}`, {timeout: 15000});
    try {
        const text = await editable.textContent();
        await setCaretOffset(editable, text?.length || 0);
        await page.keyboard.press(shortcut);
        await response;
    } finally {
        page.off("pageerror", pageErrorListener);
    }
    expect(pageErrors).toEqual([]);
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
        {changedText: "13", focusOffset: 1, key: "Delete", title: "deletes"},
        {changedText: "103", focusOffset: 2, key: "0", title: "replaces"},
    ].forEach(({changedText, focusOffset, key, title}) => {
        test(`${title} a cross-block range between list items while preserving the trailing child list`, async ({
            page,
            createTestDocument,
            siyuanAPI,
        }) => {
            const {docID} = await createTestDocument(
                `Sibling List Item Child Preservation ${title} E2E`,
                "* 111\n    * 2222",
            );
            await siyuanAPI.post<unknown>("/api/block/appendBlock", {
                data: "* 333\n    * 444",
                dataType: "markdown",
                parentID: docID,
            });
            await page.reload();
            const editor = await getDocumentEditor(page, docID);
            const child = (text: string): IListTreeItem => ({children: [], text});
            const initialTree: IListTreeItem[] = [
                {children: [child("2222")], text: "111"},
                {children: [child("444")], text: "333"},
            ];
            const changedTree: IListTreeItem[] = [{
                children: [child("444")],
                text: changedText,
            }];
            await expectListTree(siyuanAPI, docID, editor, initialTree);

            const editables = editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]');
            const startEditable = editables.nth(0);
            const endEditable = editables.nth(2);
            const startID = await startEditable.locator("..").getAttribute("data-node-id");
            const endID = await endEditable.locator("..").getAttribute("data-node-id");
            const selectedText = await setCrossBlockRange(startEditable, 1, endEditable, 2);
            expect(selectedText.replace(/[\s\u200b]/g, "")).toBe("11222233");

            await requestTransaction(page, () => page.keyboard.press(key));
            await expectListTree(siyuanAPI, docID, editor, changedTree);
            await expect.poll(() => editor.evaluate(element => {
                const range = getSelection()?.getRangeAt(0);
                const target = range?.startContainer.nodeType === Node.ELEMENT_NODE ?
                    range.startContainer as Element : range?.startContainer.parentElement;
                const editable = target?.closest('[contenteditable="true"]');
                const offsetRange = document.createRange();
                if (range && editable) {
                    offsetRange.selectNodeContents(editable);
                    offsetRange.setEnd(range.startContainer, range.startOffset);
                }
                return {
                    collapsed: range?.collapsed || false,
                    offset: offsetRange.toString().replace(/\u200b/g, "").length,
                    text: editable?.textContent,
                    withinEditor: !!range && element.contains(range.startContainer),
                };
            })).toEqual({
                collapsed: true,
                offset: focusOffset,
                text: changedText,
                withinEditor: true,
            });

            await requestHistoryAction(page, startEditable, UNDO_SHORTCUT, "undo");
            await expectListTree(siyuanAPI, docID, editor, initialTree);
            await expect.poll(() => getSelectionState(editor)).toEqual({
                collapsed: false,
                endID,
                startID,
                text: "11222233",
            });

            await requestHistoryAction(page,
                editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]').first(),
                REDO_SHORTCUT, "redo");
            await expectListTree(siyuanAPI, docID, editor, changedTree);

            await page.reload();
            await expectListTree(siyuanAPI, docID, await getDocumentEditor(page, docID), changedTree);
        });
    });

    test("merges identical inline marks after deleting a cross-block range", async ({
        page,
        createTestDocument,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Cross Block Inline Mark Merge E2E",
            "**ab**\n\n**cd**",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        expect(initialState.map(item => item.text)).toEqual(["ab", "cd"]);
        await expect(editor.locator('[data-type="NodeParagraph"] [data-type~="strong"]')).toHaveText(["ab", "cd"]);

        const editables = editor.locator(':scope > [data-type="NodeParagraph"] > [contenteditable="true"]');
        const endID = await editables.last().locator("..").getAttribute("data-node-id");
        const selectedText = await setCrossBlockRange(editables.first(), 1, editables.last(), 1);
        expect(selectedText.replace(/[\s\u200b]/g, "")).toBe("bc");

        await requestTransaction(page, () => page.keyboard.press("Backspace"));
        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(1);
        const mergedState = (await getDOMState(editor)).paragraphs;
        expect(mergedState.map(item => item.text)).toEqual(["ad"]);
        await expect(editor.locator('[data-type="NodeParagraph"] [data-type~="strong"]')).toHaveText(["ad"]);
        await expect.poll(() => getPersistedTextMarks(siyuanAPI, docID)).toEqual([{text: "ad", type: "strong"}]);
        await expectDocumentState(siyuanAPI, docID, editor, mergedState);

        await requestHistoryAction(page,
            editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]').first(),
            UNDO_SHORTCUT, "undo");
        await expectDocumentState(siyuanAPI, docID, editor, initialState);
        await expect(editor.locator('[data-type="NodeParagraph"] [data-type~="strong"]')).toHaveText(["ab", "cd"]);
        await expect.poll(() => getSelectionState(editor)).toEqual({
            collapsed: true,
            endID,
            startID: endID,
            text: "",
        });

        await requestHistoryAction(page,
            editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]').first(),
            REDO_SHORTCUT, "redo");
        await expectDocumentState(siyuanAPI, docID, editor, mergedState);
        await expect(editor.locator('[data-type="NodeParagraph"] [data-type~="strong"]')).toHaveText(["ad"]);
    });

    test("toggles a bold mark across blocks without losing the range", async ({
        page,
        createTestDocument,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Cross Block Bold Toggle E2E",
            "ab\n\ncd",
        );
        const editables = editor.locator(':scope > [data-type="NodeParagraph"] > [contenteditable="true"]');
        const startID = await editables.first().locator("..").getAttribute("data-node-id");
        const endID = await editables.last().locator("..").getAttribute("data-node-id");
        const selectedText = await setCrossBlockRange(editables.first(), 1, editables.last(), 1);
        expect(selectedText.replace(/[\s\u200b]/g, "")).toBe("bc");

        await requestTransaction(page, () => page.keyboard.press(`${PRIMARY_MODIFIER}+b`));
        await expect(editor.locator('[data-type="NodeParagraph"] [data-type~="strong"]')).toHaveText(["b", "c"]);
        await expect.poll(() => getPersistedTextMarks(siyuanAPI, docID)).toEqual([
            {text: "b", type: "strong"},
            {text: "c", type: "strong"},
        ]);
        await expect.poll(() => getSelectionState(editor)).toEqual({
            collapsed: false,
            endID,
            startID,
            text: "bc",
        });

        await requestTransaction(page, () => page.keyboard.press(`${PRIMARY_MODIFIER}+b`));
        await expect(editor.locator('[data-type="NodeParagraph"] [data-type~="strong"]')).toHaveCount(0);
        await expect.poll(() => getPersistedTextMarks(siyuanAPI, docID)).toEqual([]);
        await expect.poll(() => getSelectionState(editor)).toEqual({
            collapsed: false,
            endID,
            startID,
            text: "bc",
        });
    });

    test("keeps a code-block boundary selected while formatting later blocks", async ({
        page,
        createTestDocument,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Code Block Cross Block Bold E2E",
            "```text\ncode\n```\n\ncdef",
        );
        const codeBlock = editor.locator(':scope > [data-type="NodeCodeBlock"]');
        const codeEditable = codeBlock.locator('[contenteditable="true"]').first();
        const paragraph = editor.locator(':scope > [data-type="NodeParagraph"]');
        const paragraphEditable = paragraph.locator('[contenteditable="true"]');
        const startID = await codeBlock.getAttribute("data-node-id");
        const endID = await paragraph.getAttribute("data-node-id");
        const selectedText = await setCrossBlockRange(codeEditable, 0, paragraphEditable, 2);
        expect(selectedText.replace(/[\s\u200b]/g, "")).toBe("codecd");

        await requestTransaction(page, () => page.keyboard.press(`${PRIMARY_MODIFIER}+b`));
        await expect(codeBlock.locator('[data-type~="strong"]')).toHaveCount(0);
        await expect(paragraph.locator('[data-type~="strong"]')).toHaveText("cd");
        await expect.poll(() => getPersistedTextMarks(siyuanAPI, docID)).toEqual([
            {text: "cd", type: "strong"},
        ]);
        await expect.poll(() => getSelectionState(editor)).toEqual({
            collapsed: false,
            endID,
            startID,
            text: "codecd",
        });
    });

    test("formats table content within a surrounding cross-block range", async ({
        page,
        createTestDocument,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Table Cross Block Bold E2E",
            "ab\n\n| h |\n| --- |\n| t |\n\ncd",
        );
        const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
        const startParagraph = paragraphs.first();
        const endParagraph = paragraphs.last();
        const startEditable = startParagraph.locator('[contenteditable="true"]');
        const endEditable = endParagraph.locator('[contenteditable="true"]');
        const startID = await startParagraph.getAttribute("data-node-id");
        const endID = await endParagraph.getAttribute("data-node-id");
        const selectedText = await setCrossBlockRange(startEditable, 1, endEditable, 1);
        expect(selectedText.replace(/[\s\u200b]/g, "")).toContain("bhtc");

        await requestTransaction(page, () => page.keyboard.press(`${PRIMARY_MODIFIER}+b`));
        await expect(startParagraph.locator('[data-type~="strong"]')).toHaveText("b");
        await expect(endParagraph.locator('[data-type~="strong"]')).toHaveText("c");
        await expect(editor.locator(':scope > [data-type="NodeTable"] [data-type~="strong"]')).toHaveText(["h", "t"]);
        await expect.poll(() => getPersistedTextMarks(siyuanAPI, docID)).toEqual([
            {text: "b", type: "strong"},
            {text: "h", type: "strong"},
            {text: "t", type: "strong"},
            {text: "c", type: "strong"},
        ]);
        await expect.poll(() => getSelectionState(editor)).toEqual({
            collapsed: false,
            endID,
            startID,
            text: selectedText.replace(/[\s\u200b]/g, ""),
        });
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
        {children: ["1", "3"], endIndex: 10, key: "ControlOrMeta+X", selectedText: "23312", startIndex: 6,
            title: "cuts a range with trailing start items from"},
        {children: ["1", "3"], endIndex: 10, key: "Delete", listItemBoundary: true, selectedText: "23312",
            startIndex: 6, title: "deletes a list-item-boundary range with trailing start items from"},
        {children: ["1", "1", "3"], endIndex: 10, key: "1", selectedText: "23312", startIndex: 6,
            title: "replaces a range with trailing start items in"},
        {children: ["1", "1", "3"], endIndex: 10, key: "1", mergeAcrossOuterItems: true,
            selectedText: "232123312", startIndex: 2, title: "replaces a range across nonadjacent outer items in"},
        {children: ["1", "3"], endIndex: 10, key: "1", mergeIntoFirst: true, selectedText: "2123312",
            startIndex: 4, title: "replaces a fully selected outer list item in"},
        {children: ["1", "3"], endIndex: 10, key: "Delete", listSubtype: "t" as const,
            selectedText: "23312", startIndex: 6, title: "deletes a range with trailing start items from task"},
    ].forEach(({children, endIndex, key, listItemBoundary, mergeIntoFirst, selectedText: expectedSelectedText,
                  startIndex, title, listSubtype = "u", mergeAcrossOuterItems}) => {
        test(`${title} a cross-block range between sibling nested lists and restores it with undo and redo`, async ({
            page,
            createTestDocument,
            siyuanAPI,
        }) => {
            const {docID, editor} = await createTestDocument(
                `Sibling Nested List Cross Block ${title} E2E`,
                getSiblingNestedListMarkdown(listSubtype as "t" | "u"),
            );
            const child = (text: string): IListTreeItem => ({children: [], text});
            const initialTree: IListTreeItem[] = [
                {children: [child("1"), child("2"), child("3")], text: "1"},
                {children: [child("1"), child("2"), child("3")], text: "2"},
                {children: [child("1"), child("2"), child("3")], text: "3"},
            ];
            const changedTree: IListTreeItem[] = mergeAcrossOuterItems ? [{
                children: children.map(child),
                text: "1",
            }] : mergeIntoFirst ? [{
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

            await requestHistoryAction(page,
                editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]').first(),
                REDO_SHORTCUT, "redo");
            await expectListTree(siyuanAPI, docID, editor, changedTree);

            await page.reload();
            await expectListTree(siyuanAPI, docID, await getDocumentEditor(page, docID), changedTree);
        });
    });

    [
        {children: ["3"], key: "Backspace", title: "backspacing"},
        {children: ["3"], key: "Delete", title: "deleting"},
        {children: ["0", "3"], key: "0", title: "replacing"},
    ].forEach(({children, key, title}) => {
        test(`merges into a new nested list when ${title} across nested list branches`, async ({
            page,
            createTestDocument,
            siyuanAPI,
        }) => {
            const {docID, editor} = await createTestDocument(
                `Nested List Creation Cross Block ${title} E2E`,
                [
                    "* 1",
                    "* 2",
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
                {children: [], text: "1"},
                {children: [child("1"), child("2"), child("3")], text: "2"},
                {children: [child("1"), child("2"), child("3")], text: "2"},
                {children: [child("1"), child("2"), child("3")], text: "3"},
            ];
            await expectListTree(siyuanAPI, docID, editor, initialTree);

            const editables = editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]');
            const startEditable = editables.nth(1);
            const endEditable = editables.nth(11);
            const startID = await startEditable.locator("..").getAttribute("data-node-id");
            const endID = await endEditable.locator("..").getAttribute("data-node-id");
            const selectedText = await setCrossBlockRange(startEditable, 0, endEditable, 1);
            expect(selectedText.replace(/[\s\u200b]/g, "")).toBe("21232123312");

            await requestTransaction(page, () => page.keyboard.press(key));
            const changedTree: IListTreeItem[] = [{children: children.map(child), text: "1"}];
            await expectListTree(siyuanAPI, docID, editor, changedTree);
            if (key === "0") {
                await expect.poll(() => editor.evaluate(element => {
                    const range = getSelection()?.getRangeAt(0);
                    const container = range?.startContainer;
                    const target = container?.nodeType === Node.ELEMENT_NODE ?
                        container as Element : container?.parentElement;
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
                    text: "0",
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
                text: "21232123312",
            });

            await requestHistoryAction(page,
                editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]').first(),
                REDO_SHORTCUT, "redo");
            await expectListTree(siyuanAPI, docID, editor, changedTree);

            await page.reload();
            await expectListTree(siyuanAPI, docID, await getDocumentEditor(page, docID), changedTree);
        });
    });

    [
        {changedText: "1", key: "Backspace", title: "backspacing"},
        {changedText: "1", key: "Delete", title: "deleting"},
        {changedText: "10", key: "0", title: "replacing"},
    ].forEach(({changedText, key, title}) => {
        test(`removes a nested-list suffix when ${title} and restores the range`, async ({
            page,
            createTestDocument,
            siyuanAPI,
        }) => {
            const {docID, editor} = await createTestDocument(
                `Nested List Suffix Cross Block ${title} E2E`,
                [
                    "222",
                    "",
                    "* 13",
                    "    * 444",
                    "* 13",
                    "    * 444",
                    "* 111",
                    "    * 222",
                    "* 333",
                    "    * 444",
                ].join("\n"),
            );
            const child = (text: string): IListTreeItem => ({children: [], text});
            const initialTree: IListTreeItem[] = [
                {children: [child("444")], text: "13"},
                {children: [child("444")], text: "13"},
                {children: [child("222")], text: "111"},
                {children: [child("444")], text: "333"},
            ];
            await expectListTree(siyuanAPI, docID, editor, initialTree);

            const editables = editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]');
            const startEditable = editables.nth(1);
            const endEditable = editables.nth(8);
            const startID = await startEditable.locator("..").getAttribute("data-node-id");
            const endID = await endEditable.locator("..").getAttribute("data-node-id");
            const selectedText = await setCrossBlockRange(startEditable, 1, endEditable, 3);
            expect(selectedText.replace(/[\s\u200b]/g, "")).toBe("344413444111222333444");

            await requestTransaction(page, () => page.keyboard.press(key));
            const changedTree: IListTreeItem[] = [{children: [], text: changedText}];
            await expectListTree(siyuanAPI, docID, editor, changedTree);
            await expect(editor.locator(':scope > [data-type="NodeParagraph"] > [contenteditable="true"]'))
                .toHaveText("222");

            await requestHistoryAction(page,
                editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]').first(),
                UNDO_SHORTCUT, "undo");
            await expectListTree(siyuanAPI, docID, editor, initialTree);
            await expect.poll(() => getSelectionState(editor)).toEqual({
                collapsed: false,
                endID,
                startID,
                text: "344413444111222333444",
            });

            await requestHistoryAction(page,
                editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]').first(),
                REDO_SHORTCUT, "redo");
            await expectListTree(siyuanAPI, docID, editor, changedTree);

            await page.reload();
            await expectListTree(siyuanAPI, docID, await getDocumentEditor(page, docID), changedTree);
        });
    });
});
