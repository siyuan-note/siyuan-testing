import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
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

const requestHistoryAction = async (page: Page, editable: Locator, shortcut: "Control+Z" | "Control+Y",
                                    action: "undo" | "redo") => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === `/api/transactions/${action}`);
    await editable.press(shortcut);
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

        await page.keyboard.press("Enter");
        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(2);
        const splitState = (await getDOMState(editor)).paragraphs;
        expect(splitState.map(item => item.text)).toEqual(["Alpha", "Beta"]);
        expect(splitState.filter(item => item.id === initialID)).toHaveLength(1);
        expect(new Set(splitState.map(item => item.id)).size).toBe(2);
        await expectDocumentState(siyuanAPI, docID, editor, splitState);

        await requestHistoryAction(page,
            editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]').first(),
            "Control+Z", "undo");
        await expectDocumentState(siyuanAPI, docID, editor, [{id: initialID, text: "AlphaBeta"}]);

        await requestHistoryAction(page,
            editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]').first(),
            "Control+Y", "redo");
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

            await page.keyboard.press(key);
            await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(1);
            const mergedState = (await getDOMState(editor)).paragraphs;
            expect(mergedState.map(item => item.text)).toEqual(["FirstSecond"]);
            expect(initialParagraphs.map(item => item.id)).toContain(mergedState[0].id);
            await expectDocumentState(siyuanAPI, docID, editor, mergedState);

            await requestHistoryAction(page,
                editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]').first(),
                "Control+Z", "undo");
            await expectDocumentState(siyuanAPI, docID, editor, initialParagraphs);

            await requestHistoryAction(page,
                editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]').first(),
                "Control+Y", "redo");
            await expectDocumentState(siyuanAPI, docID, editor, mergedState);

            await page.reload();
            await expectDocumentState(siyuanAPI, docID, await getDocumentEditor(page, docID), mergedState);
        });
    });
});
