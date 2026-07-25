import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openBlockMenu} from "./helpers/blockMenu";
import {PRIMARY_MODIFIER, REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {assertValidListDOM, assertValidSyListTree} from "./helpers/listAssertions";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface IListData {
    Typ?: number;
}

interface ISyNode {
    ID?: string;
    Data?: string;
    HeadingLevel?: number;
    ListData?: IListData;
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

const omitRootUpdated = (document: ISyNode) => ({
    ...document,
    Properties: document.Properties && Object.fromEntries(
        Object.entries(document.Properties).filter(([key]) => key !== "updated"),
    ),
});

const omitUpdated = (node: ISyNode): ISyNode => ({
    ...node,
    Properties: node.Properties && Object.fromEntries(
        Object.entries(node.Properties).filter(([key]) => key !== "updated"),
    ),
    Children: node.Children?.map(omitUpdated),
});

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

const selectContiguousBlocks = async (blocks: Locator, editor: Locator, start: number, end: number) => {
    await blocks.nth(start).locator('[contenteditable="true"]').click();
    await blocks.nth(end).click({modifiers: ["Shift"]});
    await expect(editor.locator(":scope > .protyle-wysiwyg--select")).toHaveCount(end - start + 1);
};

const selectSeparateBlocks = async (blocks: Locator, editor: Locator, indexes: number[]) => {
    const expectedIDs = await Promise.all(indexes.map(index => blocks.nth(index).getAttribute("data-node-id")));
    for (const index of indexes) {
        await blocks.nth(index).click({modifiers: [PRIMARY_MODIFIER]});
    }
    await expect.poll(() => editor.locator(":scope > .protyle-wysiwyg--select").evaluateAll(elements =>
        elements.map(element => element.getAttribute("data-node-id")))).toEqual(expectedIDs);
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
    await focusAtEnd(editor.locator('[data-type="NodeParagraph"], [data-type="NodeHeading"]').first());
    await page.keyboard.press(shortcut);
    await response;
};

const chooseTurnInto = async (page: Page, block: Locator, optionID: string) => {
    const menu = await openBlockMenu(page, block);
    const turnInto = menu.locator('[data-id="turnInto"]').first();
    await turnInto.hover();
    const option = turnInto.locator(`.b3-menu__submenu [data-id="${optionID}"]`).first();
    await expect(option).toBeVisible();
    await requestTransaction(page, () => option.click());
};

const chooseSelectedTurnInto = async (page: Page, editor: Locator, block: Locator, optionID: string) => {
    const editable = block.locator('[contenteditable="true"]').first();
    await editable.click();
    await expect(editor.locator(":scope > .protyle-wysiwyg--select")).toHaveCount(0);
    await editable.click({modifiers: [PRIMARY_MODIFIER]});
    await expect(block).toHaveClass(/protyle-wysiwyg--select/);
    const menu = await openBlockMenu(page, block);
    const turnInto = menu.locator('[data-id="turnInto"]').first();
    await turnInto.hover();
    const option = turnInto.locator(`.b3-menu__submenu [data-id="${optionID}"]`).first();
    await expect(option).toBeVisible();
    await requestTransaction(page, () => option.click());
};

const getTopDOMState = async (editor: Locator) => editor.locator(":scope > [data-node-id]").evaluateAll(elements =>
    elements.map(element => ({
        id: element.getAttribute("data-node-id") || "",
        subtype: element.getAttribute("data-subtype") || "",
        text: element.textContent || "",
        type: element.getAttribute("data-type") || "",
    })));

test.describe("block transformations and indentation", () => {
    test.describe.configure({mode: "parallel"});

    test("converts multiple paragraphs to headings and restores them with undo and redo", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Multiple Heading Transform E2E",
            "Before\n\nHeading first\n\nHeading second\n\nAfter",
        );
        const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
        const initialState = await getTopDOMState(editor);
        await selectContiguousBlocks(paragraphs, editor, 1, 2);

        await requestTransaction(page, () => page.keyboard.press("ControlOrMeta+Alt+2"));
        const headingState = await getTopDOMState(editor);
        expect(headingState.map(item => ({id: item.id, subtype: item.subtype, type: item.type}))).toEqual([
            {id: initialState[0].id, subtype: "", type: "NodeParagraph"},
            {id: initialState[1].id, subtype: "h2", type: "NodeHeading"},
            {id: initialState[2].id, subtype: "h2", type: "NodeHeading"},
            {id: initialState[3].id, subtype: "", type: "NodeParagraph"},
        ]);
        await expect.poll(async () => {
            const document = await readValidDocument(siyuanAPI, docID);
            return (document.Children || []).map(node => ({
                id: node.ID || "",
                level: node.HeadingLevel || 0,
                type: node.Type || "",
            }));
        }).toEqual([
            {id: initialState[0].id, level: 0, type: "NodeParagraph"},
            {id: initialState[1].id, level: 2, type: "NodeHeading"},
            {id: initialState[2].id, level: 2, type: "NodeHeading"},
            {id: initialState[3].id, level: 0, type: "NodeParagraph"},
        ]);

        await requestHistoryAction(page, editor, UNDO_SHORTCUT, "undo");
        await expect.poll(() => getTopDOMState(editor)).toEqual(initialState);

        await requestHistoryAction(page, editor, REDO_SHORTCUT, "redo");
        await expect.poll(() => getTopDOMState(editor)).toEqual(headingState);

        const headings = editor.locator(':scope > [data-type="NodeHeading"]');
        await selectContiguousBlocks(headings, editor, 0, 1);
        await requestTransaction(page, () => page.keyboard.press("ControlOrMeta+Alt+0"));
        await expect.poll(() => getTopDOMState(editor)).toEqual(initialState);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        await expect.poll(() => getTopDOMState(reloadedEditor)).toEqual(initialState);
    });

    test("converts paragraphs through unordered, ordered, and task lists and back", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "List Type Transform E2E",
            "List item",
        );
        const initialState = await getTopDOMState(editor);
        const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');

        await chooseTurnInto(page, paragraphs.nth(0), "list");
        const list = editor.locator(':scope > [data-type="NodeList"]');
        await expect(list).toHaveAttribute("data-subtype", "u");
        await expect(list.locator(':scope > [data-type="NodeListItem"]')).toHaveCount(1);

        await chooseSelectedTurnInto(page, editor, list, "orderedList");
        await expect(list).toHaveAttribute("data-subtype", "o");

        await chooseSelectedTurnInto(page, editor, list, "check");
        await expect(list).toHaveAttribute("data-subtype", "t");
        await expect(list.locator(':scope > [data-type="NodeListItem"][data-subtype="t"]')).toHaveCount(1);
        await expect.poll(async () => {
            const document = await readValidDocument(siyuanAPI, docID);
            const top = (document.Children || [])[0];
            return {
                childTypes: (top.Children || []).map(node => node.Type),
                itemTypes: (top.Children || []).map(node => node.ListData?.Typ || 0),
                texts: (top.Children || []).map(getNodeText),
                topType: top.Type,
                type: top.ListData?.Typ || 0,
            };
        }).toEqual({
            childTypes: ["NodeListItem"],
            itemTypes: [3],
            texts: ["List item"],
            topType: "NodeList",
            type: 3,
        });

        await chooseSelectedTurnInto(page, editor, list, "paragraph");
        await expect.poll(() => getTopDOMState(editor)).toEqual(initialState);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        await expect.poll(() => getTopDOMState(reloadedEditor)).toEqual(initialState);
    });

    test("indents and outdents a list item while preserving its hierarchy and ID", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "List Indent Outdent E2E",
            "- First item\n- Nested item\n- Third item",
        );
        const list = editor.locator(':scope > [data-type="NodeList"]');
        const items = list.locator(':scope > [data-type="NodeListItem"]');
        await expect(items).toHaveCount(3);
        const initialIDs = await items.evaluateAll(elements =>
            elements.map(element => element.getAttribute("data-node-id") || ""));
        const initialDocument = omitRootUpdated(await readValidDocument(siyuanAPI, docID));

        await focusAtEnd(items.nth(1));
        await requestTransaction(page, () => page.keyboard.press("Tab"));
        const nestedList = items.nth(0).locator(':scope > [data-type="NodeList"]');
        await expect(nestedList).toHaveCount(1);
        await expect(nestedList.locator(`:scope > [data-node-id="${initialIDs[1]}"]`)).toHaveCount(1);
        await expect(items).toHaveCount(2);
        await expect.poll(async () => {
            const document = await readValidDocument(siyuanAPI, docID);
            const topList = (document.Children || [])[0];
            const firstItem = (topList.Children || [])[0];
            const childList = (firstItem.Children || []).find(node => node.Type === "NodeList");
            return {
                nestedIDs: (childList?.Children || []).map(node => node.ID),
                topIDs: (topList.Children || []).map(node => node.ID),
            };
        }).toEqual({
            nestedIDs: [initialIDs[1]],
            topIDs: [initialIDs[0], initialIDs[2]],
        });

        await focusAtEnd(nestedList.locator(`:scope > [data-node-id="${initialIDs[1]}"]`));
        await requestTransaction(page, () => page.keyboard.press("Shift+Tab"));
        await expect(items).toHaveCount(3);
        await expect(items.evaluateAll(elements =>
            elements.map(element => element.getAttribute("data-node-id") || ""))).resolves.toEqual(initialIDs);
        await expect.poll(async () => omitRootUpdated(await readValidDocument(siyuanAPI, docID)))
            .toEqual(initialDocument);
    });

    test("wraps multiple paragraphs in a blockquote and restores the structure", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Blockquote Transform E2E",
            "Before\n\nQuote first\n\nQuote second\n\nAfter",
        );
        const initialState = await getTopDOMState(editor);
        const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
        await selectContiguousBlocks(paragraphs, editor, 1, 2);
        await chooseTurnInto(page, paragraphs.nth(1), "quote");

        const quote = editor.locator(':scope > [data-type="NodeBlockquote"]');
        await expect(quote).toHaveCount(1);
        const quotedParagraphs = quote.locator(':scope > [data-type="NodeParagraph"]');
        await expect(quotedParagraphs).toHaveCount(2);
        await expect(quotedParagraphs.evaluateAll(elements =>
            elements.map(element => element.getAttribute("data-node-id") || ""))).resolves.toEqual([
            initialState[1].id,
            initialState[2].id,
        ]);
        await expect.poll(async () => {
            const document = await readValidDocument(siyuanAPI, docID);
            const top = document.Children || [];
            const blockquote = top[1];
            return {
                childIDs: (blockquote.Children || []).filter(node => node.ID).map(node => node.ID),
                topTypes: top.map(node => node.Type),
            };
        }).toEqual({
            childIDs: [initialState[1].id, initialState[2].id],
            topTypes: ["NodeParagraph", "NodeBlockquote", "NodeParagraph"],
        });

        await requestHistoryAction(page, editor, UNDO_SHORTCUT, "undo");
        await expect.poll(() => getTopDOMState(editor)).toEqual(initialState);

        await requestHistoryAction(page, editor, REDO_SHORTCUT, "redo");
        await expect(quote).toHaveCount(1);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        await expect(reloadedEditor.locator(':scope > [data-type="NodeBlockquote"]')).toHaveCount(1);
    });

    test("converts non-contiguous paragraphs into independent lists and restores the transaction", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Non-contiguous Block Conversion E2E",
            "Selected first\n\nUntouched middle\n\nSelected second\n\nUntouched end",
        );
        const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
        await expect(paragraphs).toHaveCount(4);
        const initialDocument = omitUpdated(await readValidDocument(siyuanAPI, docID));

        await selectSeparateBlocks(paragraphs, editor, [0, 2]);
        await chooseTurnInto(page, paragraphs.nth(0), "list");

        await expect.poll(() => getTopDOMState(editor)).toEqual([
            expect.objectContaining({text: expect.stringContaining("Selected first"), type: "NodeList"}),
            expect.objectContaining({text: expect.stringContaining("Untouched middle"), type: "NodeParagraph"}),
            expect.objectContaining({text: expect.stringContaining("Selected second"), type: "NodeList"}),
            expect.objectContaining({text: expect.stringContaining("Untouched end"), type: "NodeParagraph"}),
        ]);
        const lists = editor.locator(':scope > [data-type="NodeList"]');
        await expect(lists).toHaveCount(2);
        await expect(lists.nth(0).locator(':scope > [data-type="NodeListItem"]')).toHaveCount(1);
        await expect(lists.nth(1).locator(':scope > [data-type="NodeListItem"]')).toHaveCount(1);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);

        await requestHistoryAction(page, editor, UNDO_SHORTCUT, "undo");
        await expect.poll(async () => omitUpdated(await readValidDocument(siyuanAPI, docID)))
            .toEqual(initialDocument);
        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(4);

        await requestHistoryAction(page, editor, REDO_SHORTCUT, "redo");
        await expect(editor.locator(':scope > [data-type="NodeList"]')).toHaveCount(2);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        await expect(reloadedEditor.locator(':scope > [data-type="NodeList"]')).toHaveCount(2);
        await expect(reloadedEditor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(2);
        await assertValidListDOM(reloadedEditor);
        await assertValidSyListTree(siyuanAPI, docID, reloadedEditor);
    });
});
