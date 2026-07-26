import {BrowserContext, Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openBlockMenu} from "./helpers/blockMenu";
import {PRIMARY_MODIFIER, REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {assertValidListDOM, assertValidSyListTree} from "./helpers/listAssertions";
import {getDocumentEditor} from "./helpers/testNotebook";
import {openWorkspace} from "./helpers/runtime";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface ISyNode {
    ID?: string;
    Data?: string;
    Type?: string;
    Properties?: Record<string, string>;
    TextMarkAHref?: string;
    TextMarkBlockRefID?: string;
    TextMarkTextContent?: string;
    TextMarkType?: string;
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
    (node.Data || node.TextMarkTextContent || "") + (node.Children || []).map(getNodeText).join("");

const allowClipboard = async (context: BrowserContext, baseURL: string | undefined) => {
    if (!baseURL) {
        throw new Error("playwright.config.ts must define use.baseURL");
    }
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(baseURL).origin,
    });
};

const expectClipboardText = async (page: Page, expectedParts: string[]) => {
    await expect.poll(async () => {
        const text = await page.evaluate(() => navigator.clipboard.readText());
        return expectedParts.filter(part => !text.includes(part));
    }).toEqual([]);
};

const pasteBlocks = async (page: Page) => {
    const existenceCheck = page.waitForResponse(response =>
        new URL(response.url()).pathname === "/api/block/checkBlocksExist", {timeout: 30000});
    await page.keyboard.press("ControlOrMeta+V");
    const response = await existenceCheck;
    const result = await response.json() as {code: number; msg: string};
    expect(result.code, result.msg).toBe(0);
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
    await expect.poll(() => getDOMState(editor), {timeout: 30000}).toEqual({
        duplicateIDs: 0,
        paragraphs,
    });
    await expect.poll(() => getPersistedState(api, docID), {timeout: 30000}).toEqual({
        duplicateIDs: 0,
        mismatchedPropertyIDs: 0,
        paragraphs,
    });
};

const focusAtEnd = async (block: Locator) => {
    const editable = block.locator('[contenteditable="true"]').first();
    await editable.evaluate(element => {
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
    return editable;
};

interface IDOMBlockTree {
    type: string;
    subtype: string;
    text: string;
    children: IDOMBlockTree[];
}

const getBlockTree = (block: Locator) => block.evaluate((element): IDOMBlockTree => {
    const visit = (node: Element): IDOMBlockTree => ({
        type: node.getAttribute("data-type") || "",
        subtype: node.getAttribute("data-subtype") || "",
        text: node.querySelector(":scope > [contenteditable=\"true\"]")?.textContent?.trim() || "",
        children: Array.from(node.children)
            .filter(child => child.hasAttribute("data-node-id"))
            .map(visit),
    });
    return visit(element);
});

const getBlockIDs = (block: Locator) => block.evaluate(element => [
    element,
    ...Array.from(element.querySelectorAll("[data-node-id]")),
].map(node => node.getAttribute("data-node-id") || "").filter(Boolean));

const useBlockClipboardAction = async (page: Page, block: Locator, action: "copy" | "cut") => {
    const menu = await openBlockMenu(page, block, block.locator('[contenteditable="true"]').first());
    if (action === "cut") {
        await menu.locator('[data-id="cut"]').first().click();
        return;
    }
    const copy = menu.locator('[data-id="copy"]').first();
    await copy.hover();
    const copyContent = copy.locator('.b3-menu__submenu [data-id="copy"]').first();
    await expect(copyContent).toBeVisible();
    await copyContent.click();
};

const requestHistoryAction = async (page: Page, editor: Locator, shortcut: string,
                                    action: "undo" | "redo") => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === `/api/transactions/${action}`, {timeout: 30000});
    const editable = editor.locator('[contenteditable="true"]').last();
    await editable.focus();
    await page.keyboard.press(shortcut);
    expect((await response).ok()).toBe(true);
};

test.describe("block copy, cut, and paste", () => {
    // 系统剪贴板由同一台测试机共享，这组用例需要串行执行，避免互相覆盖剪贴板内容。
    test.describe.configure({mode: "serial"});

    test("copies a block in the same document with a new ID", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const {docID, editor} = await createTestDocument(
            "Block Copy Same Document E2E",
            "Copy source\n\nPaste anchor",
        );
        const initialState = await getDOMState(editor);
        expect(initialState.paragraphs.map(item => item.text)).toEqual(["Copy source", "Paste anchor"]);
        const source = editor.locator(':scope > [data-type="NodeParagraph"]').nth(0);
        const anchor = editor.locator(':scope > [data-type="NodeParagraph"]').nth(1);

        await focusAtEnd(source);
        await page.keyboard.press("ControlOrMeta+C");
        await expectClipboardText(page, ["Copy source"]);
        await focusAtEnd(anchor);
        await page.keyboard.press("Enter");
        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(3);
        await focusAtEnd(editor.locator(':scope > [data-type="NodeParagraph"]').last());
        await pasteBlocks(page);

        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(3);
        await expect(editor.locator(':scope > [data-type="NodeParagraph"] [contenteditable="true"]').last())
            .toHaveText("Copy source");
        const copiedState = (await getDOMState(editor)).paragraphs;
        expect(copiedState.map(item => item.text)).toEqual(["Copy source", "Paste anchor", "Copy source"]);
        expect(copiedState[2].id).not.toBe(copiedState[0].id);
        await expectDocumentState(siyuanAPI, docID, editor, copiedState);

        await page.reload();
        await expectDocumentState(siyuanAPI, docID, await getDocumentEditor(page, docID), copiedState);
    });

    test("cuts and pastes a block in the same document without changing its ID", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const {docID, editor} = await createTestDocument(
            "Block Cut Same Document E2E",
            "Cut source\n\nPaste anchor",
        );
        const initialState = await getDOMState(editor);
        expect(initialState.paragraphs.map(item => item.text)).toEqual(["Cut source", "Paste anchor"]);
        const sourceID = initialState.paragraphs[0].id;
        const anchor = editor.locator(`:scope > [data-node-id="${initialState.paragraphs[1].id}"]`);

        await focusAtEnd(editor.locator(':scope > [data-type="NodeParagraph"]').nth(0));
        await page.keyboard.press("ControlOrMeta+X");
        await expectClipboardText(page, ["Cut source"]);
        await expectDocumentState(siyuanAPI, docID, editor, [initialState.paragraphs[1]]);

        await focusAtEnd(anchor);
        await page.keyboard.press("Enter");
        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(2);
        await focusAtEnd(editor.locator(':scope > [data-type="NodeParagraph"]').last());
        await pasteBlocks(page);

        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(2);
        const pastedState = [
            initialState.paragraphs[1],
            {id: sourceID, text: "Cut source"},
        ];
        await expectDocumentState(siyuanAPI, docID, editor, pastedState);

        await page.reload();
        await expectDocumentState(siyuanAPI, docID, await getDocumentEditor(page, docID), pastedState);
    });

    test("copies multiple selected blocks in their original order with new IDs", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const {docID, editor} = await createTestDocument(
            "Multiple Block Copy E2E",
            "First selected\n\nSecond selected\n\nPaste anchor",
        );
        const initialState = await getDOMState(editor);
        expect(initialState.paragraphs.map(item => item.text)).toEqual([
            "First selected",
            "Second selected",
            "Paste anchor",
        ]);
        const blocks = editor.locator(':scope > [data-type="NodeParagraph"]');

        await blocks.nth(0).click({modifiers: [PRIMARY_MODIFIER]});
        await blocks.nth(1).click({modifiers: [PRIMARY_MODIFIER]});
        await expect(editor.locator(":scope > .protyle-wysiwyg--select")).toHaveCount(2);
        await page.keyboard.press("ControlOrMeta+C");
        await expectClipboardText(page, ["First selected", "Second selected"]);

        await blocks.nth(2).click();
        await expect(editor.locator(":scope > .protyle-wysiwyg--select")).toHaveCount(0);
        await focusAtEnd(blocks.nth(2));
        await page.keyboard.press("Enter");
        await expect(blocks).toHaveCount(4);
        await focusAtEnd(blocks.last());
        await pasteBlocks(page);

        await expect(blocks).toHaveCount(5);
        const copiedState = (await getDOMState(editor)).paragraphs;
        expect(copiedState.map(item => item.text)).toEqual([
            "First selected",
            "Second selected",
            "Paste anchor",
            "First selected",
            "Second selected",
        ]);
        expect(copiedState.slice(3).map(item => item.id)).not.toEqual(
            initialState.paragraphs.slice(0, 2).map(item => item.id),
        );
        expect(new Set(copiedState.map(item => item.id)).size).toBe(5);
        await expectDocumentState(siyuanAPI, docID, editor, copiedState);

        await page.reload();
        await expectDocumentState(siyuanAPI, docID, await getDocumentEditor(page, docID), copiedState);
    });

    test("copies a nested list across documents with an independent valid subtree", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
        trackTestDocument,
    }) => {
        await allowClipboard(context, baseURL);
        const destination = await createTestDocument(
            "Nested List Copy Destination E2E",
            "Destination anchor",
        );
        const sourceTitle = `Nested List Copy Source E2E ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const sourceID = await siyuanAPI.createDocument(destination.notebookID, sourceTitle, [
            "* Parent item",
            "  * Nested child",
            "    * Deep child",
            "* Sibling item",
        ].join("\n"));
        trackTestDocument({id: sourceID, notebookID: destination.notebookID, title: sourceTitle});

        const sourcePage = await context.newPage();
        try {
            await openWorkspace(sourcePage, `/?id=${sourceID}`);
            const sourceEditor = await getDocumentEditor(sourcePage, sourceID);
            const sourceList = sourceEditor.locator(':scope > [data-type="NodeList"]');
            await expect(sourceList).toHaveCount(1);
            const sourceTree = await getBlockTree(sourceList);
            const sourceIDs = await getBlockIDs(sourceList);
            expect(sourceIDs.length).toBeGreaterThan(6);
            await assertValidListDOM(sourceEditor);
            await assertValidSyListTree(siyuanAPI, sourceID, sourceEditor);

            await useBlockClipboardAction(sourcePage, sourceList, "copy");
            await expectClipboardText(sourcePage, ["Parent item", "Nested child", "Deep child", "Sibling item"]);

            const anchor = destination.editor.locator(':scope > [data-type="NodeParagraph"]');
            await focusAtEnd(anchor);
            await page.keyboard.press("Enter");
            await expect(destination.editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(2);
            await focusAtEnd(destination.editor.locator(':scope > [data-type="NodeParagraph"]').last());
            await pasteBlocks(page);

            const copiedList = destination.editor.locator(':scope > [data-type="NodeList"]');
            await expect(copiedList).toHaveCount(1);
            await expect.poll(() => getBlockTree(copiedList)).toEqual(sourceTree);
            const copiedIDs = await getBlockIDs(copiedList);
            expect(copiedIDs).toHaveLength(sourceIDs.length);
            expect(copiedIDs.some(id => sourceIDs.includes(id))).toBe(false);
            expect(new Set([...sourceIDs, ...copiedIDs]).size).toBe(sourceIDs.length + copiedIDs.length);
            await assertValidListDOM(destination.editor);
            await assertValidSyListTree(siyuanAPI, destination.docID, destination.editor);

            await page.reload();
            const reloadedEditor = await getDocumentEditor(page, destination.docID);
            const reloadedList = reloadedEditor.locator(':scope > [data-type="NodeList"]');
            await expect.poll(() => getBlockTree(reloadedList)).toEqual(sourceTree);
            await expect.poll(() => getBlockIDs(reloadedList)).toEqual(copiedIDs);
            await assertValidListDOM(reloadedEditor);
            await assertValidSyListTree(siyuanAPI, destination.docID, reloadedEditor);
        } finally {
            await sourcePage.close();
        }
    });

    test("cuts and pastes a nested list while preserving subtree IDs through undo and redo", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const document = await createTestDocument("Nested List Cut Undo E2E", [
            "* Parent item",
            "  * Nested child",
            "* Sibling item",
            "",
            "Paste anchor",
        ].join("\n"));
        const list = document.editor.locator(':scope > [data-type="NodeList"]');
        const anchor = document.editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "Paste anchor"});
        const originalTree = await getBlockTree(list);
        const originalIDs = await getBlockIDs(list);
        const anchorID = await anchor.getAttribute("data-node-id");
        expect(anchorID).toBeTruthy();

        await useBlockClipboardAction(page, list, "cut");
        await expectClipboardText(page, ["Parent item", "Nested child", "Sibling item"]);
        await expect(document.editor.locator(':scope > [data-type="NodeList"]')).toHaveCount(0);
        await focusAtEnd(anchor);
        await page.keyboard.press("Enter");
        await focusAtEnd(document.editor.locator(':scope > [data-type="NodeParagraph"]').last());
        await pasteBlocks(page);

        let movedList = document.editor.locator(':scope > [data-type="NodeList"]');
        await expect.poll(() => getBlockTree(movedList)).toEqual(originalTree);
        await expect.poll(() => getBlockIDs(movedList)).toEqual(originalIDs);
        await assertValidListDOM(document.editor);
        await assertValidSyListTree(siyuanAPI, document.docID, document.editor);

        await requestHistoryAction(page, document.editor, UNDO_SHORTCUT, "undo");
        await expect(document.editor.locator(':scope > [data-type="NodeList"]')).toHaveCount(0);
        await requestHistoryAction(page, document.editor, UNDO_SHORTCUT, "undo");
        await expect(document.editor.locator(':scope > [data-type="NodeList"]')).toHaveCount(0);
        await requestHistoryAction(page, document.editor, UNDO_SHORTCUT, "undo");
        movedList = document.editor.locator(':scope > [data-type="NodeList"]');
        await expect.poll(() => getBlockTree(movedList)).toEqual(originalTree);
        await expect.poll(() => getBlockIDs(movedList)).toEqual(originalIDs);
        await expect.poll(() => document.editor.locator(":scope > [data-node-id]").evaluateAll(elements =>
            elements.map(element => element.getAttribute("data-node-id")))).toEqual([originalIDs[0], anchorID]);

        await requestHistoryAction(page, document.editor, REDO_SHORTCUT, "redo");
        await expect(document.editor.locator(':scope > [data-type="NodeList"]')).toHaveCount(0);
        await requestHistoryAction(page, document.editor, REDO_SHORTCUT, "redo");
        await expect(document.editor.locator(':scope > [data-type="NodeList"]')).toHaveCount(0);
        await requestHistoryAction(page, document.editor, REDO_SHORTCUT, "redo");
        movedList = document.editor.locator(':scope > [data-type="NodeList"]');
        await expect.poll(() => getBlockTree(movedList)).toEqual(originalTree);
        await expect.poll(() => getBlockIDs(movedList)).toEqual(originalIDs);
        await assertValidListDOM(document.editor);
        await assertValidSyListTree(siyuanAPI, document.docID, document.editor);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        await expect.poll(() => getBlockIDs(reloadedEditor.locator(':scope > [data-type="NodeList"]')))
            .toEqual(originalIDs);
        await assertValidListDOM(reloadedEditor);
        await assertValidSyListTree(siyuanAPI, document.docID, reloadedEditor);
    });

    test("copies rich text across documents while preserving inline semantics", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
        trackTestDocument,
    }) => {
        await allowClipboard(context, baseURL);
        const destination = await createTestDocument(
            "Cross Document Rich Paste Destination E2E",
            "Destination anchor",
        );
        const sourceTitle = `Cross Document Rich Paste Source E2E ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const sourceID = await siyuanAPI.createDocument(
            destination.notebookID,
            sourceTitle,
            `**Bold source** and [SiYuan](https://b3log.org/siyuan/) with ((${destination.docID} "Destination ref"))`,
        );
        trackTestDocument({id: sourceID, notebookID: destination.notebookID, title: sourceTitle});

        const sourcePage = await context.newPage();
        try {
            await openWorkspace(sourcePage, `/?id=${sourceID}`);
            const sourceEditor = await getDocumentEditor(sourcePage, sourceID);
            const sourceBlock = sourceEditor.locator(':scope > [data-type="NodeParagraph"]');
            await expect(sourceBlock).toHaveCount(1);
            const sourceBlockID = await sourceBlock.getAttribute("data-node-id");
            expect(sourceBlockID).toBeTruthy();

            await focusAtEnd(sourceBlock);
            await sourcePage.keyboard.press("ControlOrMeta+C");
            await expectClipboardText(sourcePage, ["Bold source", "SiYuan", "Destination ref"]);
            const destinationAnchor = destination.editor.locator(':scope > [data-type="NodeParagraph"]');
            await focusAtEnd(destinationAnchor);
            await page.keyboard.press("Enter");
            const destinationBlocks = destination.editor.locator(':scope > [data-type="NodeParagraph"]');
            await expect(destinationBlocks).toHaveCount(2);
            await focusAtEnd(destinationBlocks.last());
            await pasteBlocks(page);

            await expect(destinationBlocks).toHaveCount(2);
            const copiedBlock = destinationBlocks.nth(1);
            await expect(copiedBlock).toContainText("Bold source and SiYuan with Destination ref");
            const copiedBlockID = await copiedBlock.getAttribute("data-node-id");
            expect(copiedBlockID).toBeTruthy();
            expect(copiedBlockID).not.toBe(sourceBlockID);
            await expect(copiedBlock.locator('[data-type~="strong"]')).toHaveText("Bold source");
            await expect(copiedBlock.locator('[data-type~="a"]')).toHaveAttribute(
                "data-href",
                "https://b3log.org/siyuan/",
            );
            await expect(copiedBlock.locator(
                `[data-type~="block-ref"][data-id="${destination.docID}"]`,
            )).toHaveText("Destination ref");

            await expect(sourceEditor.locator(`[data-node-id="${sourceBlockID}"]`)).toHaveCount(1);
            await expect.poll(async () => {
                const document = await siyuanAPI.readDocument<ISyNode>(destination.docID);
                const copiedNode = flattenNodes(document).find(node => node.ID === copiedBlockID);
                const marks = copiedNode ? flattenNodes(copiedNode)
                    .filter(node => node.Type === "NodeTextMark")
                    .map(node => ({
                        href: node.TextMarkAHref || "",
                        refID: node.TextMarkBlockRefID || "",
                        text: node.TextMarkTextContent || "",
                        type: node.TextMarkType || "",
                    })) : [];
                return {
                    marks,
                    propertyID: copiedNode?.Properties?.id || "",
                    text: copiedNode ? getNodeText(copiedNode) : "",
                };
            }).toEqual({
                marks: [
                    {href: "", refID: "", text: "Bold source", type: "strong"},
                    {href: "https://b3log.org/siyuan/", refID: "", text: "SiYuan", type: "a"},
                    {href: "", refID: destination.docID, text: "Destination ref", type: "block-ref"},
                ],
                propertyID: copiedBlockID,
                text: "Bold source and SiYuan with Destination ref",
            });

            await page.reload();
            const reloadedEditor = await getDocumentEditor(page, destination.docID);
            await expect(reloadedEditor.locator(`[data-node-id="${copiedBlockID}"]`)).toHaveCount(1);
            await expect(reloadedEditor.locator(
                `[data-node-id="${copiedBlockID}"] [data-type~="block-ref"][data-id="${destination.docID}"]`,
            )).toHaveText("Destination ref");
        } finally {
            await sourcePage.close();
        }
    });
});
