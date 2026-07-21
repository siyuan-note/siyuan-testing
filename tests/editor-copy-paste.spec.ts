import {BrowserContext, Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
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
        return expectedParts.every(part => text.includes(part));
    }).toBe(true);
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
        await page.keyboard.press("Control+C");
        await expectClipboardText(page, ["Copy source"]);
        await focusAtEnd(anchor);
        await page.keyboard.press("Enter");
        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(3);
        await focusAtEnd(editor.locator(':scope > [data-type="NodeParagraph"]').last());
        await page.keyboard.press("Control+V");

        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(3);
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
        await page.keyboard.press("Control+X");
        await expectClipboardText(page, ["Cut source"]);
        await expectDocumentState(siyuanAPI, docID, editor, [initialState.paragraphs[1]]);

        await focusAtEnd(anchor);
        await page.keyboard.press("Enter");
        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(2);
        await focusAtEnd(editor.locator(':scope > [data-type="NodeParagraph"]').last());
        await page.keyboard.press("Control+V");

        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(2);
        const pastedState = (await getDOMState(editor)).paragraphs;
        expect(pastedState.map(item => item.text)).toEqual(["Paste anchor", "Cut source"]);
        expect(pastedState[1].id).toBe(sourceID);
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

        await blocks.nth(0).click({modifiers: ["Control"]});
        await blocks.nth(1).click({modifiers: ["Control"]});
        await expect(editor.locator(":scope > .protyle-wysiwyg--select")).toHaveCount(2);
        await page.keyboard.press("Control+C");
        await expectClipboardText(page, ["First selected", "Second selected"]);

        await blocks.nth(2).click();
        await expect(editor.locator(":scope > .protyle-wysiwyg--select")).toHaveCount(0);
        await focusAtEnd(blocks.nth(2));
        await page.keyboard.press("Enter");
        await expect(blocks).toHaveCount(4);
        await focusAtEnd(blocks.last());
        await page.keyboard.press("Control+V");

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
            await sourcePage.keyboard.press("Control+C");
            await expectClipboardText(sourcePage, ["Bold source", "SiYuan", "Destination ref"]);
            const destinationAnchor = destination.editor.locator(':scope > [data-type="NodeParagraph"]');
            await focusAtEnd(destinationAnchor);
            await page.keyboard.press("Enter");
            const destinationBlocks = destination.editor.locator(':scope > [data-type="NodeParagraph"]');
            await expect(destinationBlocks).toHaveCount(2);
            await focusAtEnd(destinationBlocks.last());
            await page.keyboard.press("Control+V");

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
