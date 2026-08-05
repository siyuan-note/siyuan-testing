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

interface IListItemState {
    contentID: string;
    id: string;
    marker: string;
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
].map((node: Element) => node.getAttribute("data-node-id") || "").filter(Boolean));

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
    const historyResponse = await response;
    expect(historyResponse.ok()).toBe(true);
    const result = await historyResponse.json() as {
        code: number;
        data?: {failed?: boolean; msg?: string};
        msg: string;
    };
    expect(result.code, result.msg).toBe(0);
    expect(result.data?.failed, result.data?.msg).not.toBe(true);
};

const selectParagraphRange = async (editor: Locator, startIndex: number, endIndex: number) => {
    await editor.evaluate((element, indexes) => {
        const blocks = Array.from(element.querySelectorAll<HTMLElement>(
            ":scope > [data-type=\"NodeParagraph\"]",
        ));
        const startEditable = blocks[indexes.start]?.querySelector<HTMLElement>("[contenteditable=\"true\"]");
        const endEditable = blocks[indexes.end]?.querySelector<HTMLElement>("[contenteditable=\"true\"]");
        if (!startEditable || !endEditable) {
            throw new Error(`paragraph range ${indexes.start}-${indexes.end} is unavailable`);
        }
        const firstText = document.createTreeWalker(startEditable, NodeFilter.SHOW_TEXT).nextNode();
        const endWalker = document.createTreeWalker(endEditable, NodeFilter.SHOW_TEXT);
        let lastText: Node | null = null;
        let current: Node | null;
        while ((current = endWalker.nextNode())) {
            lastText = current;
        }
        if (!firstText || !lastText) {
            throw new Error(`paragraph range ${indexes.start}-${indexes.end} has no text boundary`);
        }
        startEditable.focus();
        const range = document.createRange();
        range.setStart(firstText, 0);
        range.setEnd(lastText, lastText.textContent?.length || 0);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    }, {start: startIndex, end: endIndex});
};

const selectParagraphTextRange = async (editor: Locator, startIndex: number, startOffset: number,
                                        endIndex: number, endOffset: number) => {
    return editor.evaluate((element, options) => {
        const editables = element.querySelectorAll<HTMLElement>(
            ":scope > [data-type=\"NodeParagraph\"] > [contenteditable=\"true\"]",
        );
        const getTextPoint = (editable: HTMLElement, requestedOffset: number) => {
            const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
            let remaining = requestedOffset;
            let textNode = walker.nextNode();
            while (textNode && remaining > (textNode.textContent || "").length) {
                remaining -= (textNode.textContent || "").length;
                textNode = walker.nextNode();
            }
            if (!textNode) {
                throw new Error(`paragraph text offset ${requestedOffset} is unavailable`);
            }
            return {node: textNode, offset: remaining};
        };
        const startEditable = editables[options.startIndex];
        const endEditable = editables[options.endIndex];
        if (!startEditable || !endEditable) {
            throw new Error(`paragraph range ${options.startIndex}-${options.endIndex} is unavailable`);
        }
        const start = getTextPoint(startEditable, options.startOffset);
        const end = getTextPoint(endEditable, options.endOffset);
        startEditable.focus();
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
    }, {endIndex, endOffset, startIndex, startOffset});
};

const selectTopBlockRange = async (editor: Locator, startIndex: number, endIndex: number) => {
    await editor.evaluate((element, indexes) => {
        const blocks = Array.from(element.querySelectorAll<HTMLElement>(":scope > [data-node-id]"));
        const startEditable = blocks[indexes.start]?.querySelector<HTMLElement>("[contenteditable=\"true\"]");
        const endEditable = blocks[indexes.end]?.querySelector<HTMLElement>("[contenteditable=\"true\"]");
        if (!startEditable || !endEditable) {
            throw new Error(`top block range ${indexes.start}-${indexes.end} is unavailable`);
        }
        const startText = document.createTreeWalker(startEditable, NodeFilter.SHOW_TEXT).nextNode();
        const endWalker = document.createTreeWalker(endEditable, NodeFilter.SHOW_TEXT);
        let endText: Node | null = null;
        let current: Node | null;
        while ((current = endWalker.nextNode())) {
            endText = current;
        }
        if (!startText || !endText) {
            throw new Error(`top block range ${indexes.start}-${indexes.end} has no text boundary`);
        }
        startEditable.focus();
        const range = document.createRange();
        range.setStart(startText, 0);
        range.setEnd(endText, endText.textContent?.length || 0);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    }, {start: startIndex, end: endIndex});
};

const getTopBlockIdentity = async (editor: Locator) =>
    editor.locator(":scope > [data-node-id]").evaluateAll(elements => elements.map(item => ({
        id: item.getAttribute("data-node-id") || "",
        type: item.getAttribute("data-type") || "",
    })));

const getPersistedTopBlockIdentity = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    return (document.Children || []).map(item => ({
        id: item.ID || "",
        type: item.Type || "",
    }));
};

const getSelectionBlockIDs = async (editor: Locator) => editor.evaluate(element => {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0) {
        return {collapsed: true, endID: "", startID: ""};
    }
    const range = selection.getRangeAt(0);
    const getBlockID = (node: Node) => {
        let block = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
        while (block && !block.hasAttribute("data-node-id")) {
            block = block.parentElement;
        }
        return block && element.contains(block) ? block.getAttribute("data-node-id") || "" : "";
    };
    return {
        collapsed: range.collapsed,
        endID: getBlockID(range.endContainer),
        startID: getBlockID(range.startContainer),
    };
});

const selectParagraphToFirstListItem = async (editor: Locator) => {
    await editor.evaluate(element => {
        const startEditable = element.querySelector<HTMLElement>(
            ":scope > [data-type=\"NodeParagraph\"] > [contenteditable=\"true\"]",
        );
        const endEditable = element.querySelector<HTMLElement>(
            ":scope > [data-type=\"NodeList\"] > [data-type=\"NodeListItem\"] " +
            "> [data-type=\"NodeParagraph\"] > [contenteditable=\"true\"]",
        );
        const startText = startEditable &&
            document.createTreeWalker(startEditable, NodeFilter.SHOW_TEXT).nextNode();
        const endText = endEditable &&
            document.createTreeWalker(endEditable, NodeFilter.SHOW_TEXT).nextNode();
        if (!startEditable || !endEditable || !startText || !endText) {
            throw new Error("paragraph-to-list selection boundary is unavailable");
        }
        startEditable.focus();
        const range = document.createRange();
        range.setStart(startText, 0);
        range.setEnd(endText, 1);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    });
};

const selectParagraphToNestedListItem = async (editor: Locator) => {
    await editor.evaluate(element => {
        const startEditable = element.querySelector<HTMLElement>(
            ":scope > [data-type=\"NodeParagraph\"] > [contenteditable=\"true\"]",
        );
        const listEditables = element.querySelectorAll<HTMLElement>(
            "[data-type=\"NodeListItem\"] > [data-type=\"NodeParagraph\"] > [contenteditable=\"true\"]",
        );
        const endEditable = listEditables[1];
        const startText = startEditable &&
            document.createTreeWalker(startEditable, NodeFilter.SHOW_TEXT).nextNode();
        const endText = endEditable &&
            document.createTreeWalker(endEditable, NodeFilter.SHOW_TEXT).nextNode();
        if (!startEditable || !endEditable || !startText || !endText) {
            throw new Error("paragraph-to-nested-list selection boundary is unavailable");
        }
        startEditable.focus();
        const range = document.createRange();
        range.setStart(startText, 0);
        range.setEnd(endText, 1);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    });
};

const selectNestedListItemToSibling = async (editor: Locator) => {
    await editor.evaluate(element => {
        const topList = element.querySelector<HTMLElement>(":scope > [data-type=\"NodeList\"]");
        const topItems = topList?.querySelectorAll<HTMLElement>(":scope > [data-type=\"NodeListItem\"]");
        const startEditable = topItems?.[0]?.querySelector<HTMLElement>(
            ":scope > [data-type=\"NodeList\"] > [data-type=\"NodeListItem\"] " +
            "> [data-type=\"NodeParagraph\"] > [contenteditable=\"true\"]",
        );
        const endEditable = topItems?.[1]?.querySelector<HTMLElement>(
            ":scope > [data-type=\"NodeParagraph\"] > [contenteditable=\"true\"]",
        );
        if (!startEditable || !endEditable) {
            throw new Error("nested-list-to-sibling selection boundary is unavailable");
        }
        startEditable.innerHTML = "<span data-type=\"virtual-block-ref\">2</span>";
        endEditable.innerHTML = "<span data-type=\"virtual-block-ref\">3</span>";
        const startText = startEditable.querySelector("[data-type=\"virtual-block-ref\"]")?.firstChild;
        const endText = endEditable.querySelector("[data-type=\"virtual-block-ref\"]")?.firstChild;
        if (!startText || !endText) {
            throw new Error("virtual block reference boundary is unavailable");
        }
        startEditable.focus();
        const range = document.createRange();
        range.setStart(startText, 0);
        range.setEnd(endText, endText.textContent?.length || 0);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    });
};

const getAllParagraphTexts = async (editor: Locator) =>
    editor.locator('[data-type="NodeParagraph"] > [contenteditable="true"]')
        .allTextContents();

const getPersistedParagraphTexts = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    return flattenNodes(document)
        .filter(node => node.Type === "NodeParagraph")
        .map(getNodeText);
};

const pasteInternalInlineHTML = async (editor: Locator, html: string) => {
    await editor.evaluate((element, siyuanHTML) => {
        const selection = getSelection();
        if (!selection || selection.rangeCount === 0) {
            throw new Error("selection is unavailable");
        }
        const target = selection.getRangeAt(0).startContainer.nodeType === Node.ELEMENT_NODE ?
            selection.getRangeAt(0).startContainer as HTMLElement :
            selection.getRangeAt(0).startContainer.parentElement;
        if (!target || !element.contains(target)) {
            throw new Error("paste target is unavailable");
        }
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", siyuanHTML);
        clipboardData.setData("text/siyuan", siyuanHTML);
        target.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
        }));
    }, html);
};

const getDirectListItemState = async (editor: Locator): Promise<IListItemState[]> =>
    editor.locator(":scope > [data-type=\"NodeList\"] > [data-type=\"NodeListItem\"]")
        .evaluateAll(items => items.map(item => {
            const content = item.querySelector<HTMLElement>(
                ":scope > [data-type=\"NodeParagraph\"] > [contenteditable=\"true\"]",
            );
            return {
                contentID: content?.parentElement?.getAttribute("data-node-id") || "",
                id: item.getAttribute("data-node-id") || "",
                marker: item.getAttribute("data-marker") || "",
                text: content?.textContent || "",
            };
        }));

const getPersistedListItemState = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    const list = (document.Children || []).find(node => node.Type === "NodeList");
    return (list?.Children || []).filter(node => node.Type === "NodeListItem").map(item => {
        const content = (item.Children || []).find(node =>
            node.Type === "NodeParagraph" || node.Type === "NodeHeading");
        return {
            contentID: content?.ID || "",
            id: item.ID || "",
            text: content ? getNodeText(content) : "",
        };
    });
};

const getCollapsedSelectionPosition = async (editor: Locator) => editor.evaluate(element => {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0) {
        return {blockID: "", collapsed: false, offset: -1};
    }
    const range = selection.getRangeAt(0);
    let block = range.startContainer.nodeType === Node.ELEMENT_NODE ?
        range.startContainer as Element : range.startContainer.parentElement;
    while (block && !block.hasAttribute("data-node-id")) {
        block = block.parentElement;
    }
    const editable = block?.firstElementChild;
    if (!block || !editable || editable.getAttribute("contenteditable") !== "true" ||
        !element.contains(block) || !editable.contains(range.startContainer)) {
        return {blockID: "", collapsed: range.collapsed, offset: -1};
    }
    const offsetRange = range.cloneRange();
    offsetRange.selectNodeContents(editable);
    offsetRange.setEnd(range.startContainer, range.startOffset);
    return {
        blockID: block.getAttribute("data-node-id") || "",
        collapsed: range.collapsed,
        offset: offsetRange.toString().replace(/\u200B/g, "").length,
    };
});

const selectMathBlockToLastParagraph = async (editor: Locator) => {
    await editor.evaluate(element => {
        const mathBlock = element.querySelector<HTMLElement>(":scope > [data-type=\"NodeMathBlock\"]");
        const paragraphs = element.querySelectorAll<HTMLElement>(":scope > [data-type=\"NodeParagraph\"]");
        const endEditable = paragraphs[paragraphs.length - 1]?.querySelector<HTMLElement>(
            "[contenteditable=\"true\"]",
        );
        const endText = endEditable &&
            document.createTreeWalker(endEditable, NodeFilter.SHOW_TEXT).nextNode();
        if (!mathBlock || !endEditable || !endText) {
            throw new Error("math-to-paragraph selection boundary is unavailable");
        }
        endEditable.focus();
        const range = document.createRange();
        range.setStart(mathBlock, 0);
        range.setEnd(endText, 1);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    });
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

    test("replaces a cross-block text range without empty blocks and restores it on undo", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const {docID, editor} = await createTestDocument(
            "Cross Block Text Paste E2E",
            "a\n\nb\n\nc\n\nd\n\ne\n\nf",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        expect(initialState.map(item => item.text)).toEqual(["a", "b", "c", "d", "e", "f"]);

        await selectParagraphRange(editor, 3, 5);
        await page.keyboard.press("ControlOrMeta+C");
        await expectClipboardText(page, ["d", "e", "f"]);
        await selectParagraphRange(editor, 0, 2);
        await pasteBlocks(page);

        await expect.poll(async () => (await getDOMState(editor)).paragraphs.map(item => item.text))
            .toEqual(["d", "e", "f", "d", "e", "f"]);
        const pastedState = (await getDOMState(editor)).paragraphs;
        expect(pastedState.slice(0, 3).map(item => item.id)).not.toEqual(
            initialState.slice(3).map(item => item.id),
        );
        expect(pastedState.slice(3).map(item => item.id)).toEqual(
            initialState.slice(3).map(item => item.id),
        );
        await expectDocumentState(siyuanAPI, docID, editor, pastedState);

        await page.keyboard.press(UNDO_SHORTCUT);
        await expectDocumentState(siyuanAPI, docID, editor, initialState);
        await expect.poll(() => getSelectionBlockIDs(editor)).toEqual({
            collapsed: true,
            endID: initialState[2].id,
            startID: initialState[2].id,
        });

        await page.keyboard.press(REDO_SHORTCUT);
        await expectDocumentState(siyuanAPI, docID, editor, pastedState);

        await page.reload();
        await expectDocumentState(siyuanAPI, docID, await getDocumentEditor(page, docID), pastedState);
    });

    test("pastes a partial paragraph range repeatedly at its original endpoint", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const {docID, editor} = await createTestDocument(
            "Repeated Partial Paragraph Paste E2E",
            "111\n\n222",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        expect(initialState.map(item => item.text)).toEqual(["111", "222"]);

        await editor.locator(':scope > [data-type="NodeParagraph"] > [contenteditable="true"]').first()
            .evaluate(element => {
                element.innerHTML = '1<span data-type="virtual-block-ref" style="">11</span>';
            });

        expect((await selectParagraphTextRange(editor, 0, 2, 1, 2)).replace(/[\s\u200b]/g, "")).toBe("122");
        await page.keyboard.press("ControlOrMeta+C");
        await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText()))
            .replace(/\u200b/g, "")).toBe("1\n22");
        await page.keyboard.press("ControlOrMeta+V");

        await expectDocumentState(siyuanAPI, docID, editor, initialState);
        await expect.poll(() => getCollapsedSelectionPosition(editor)).toEqual({
            blockID: initialState[1].id,
            collapsed: true,
            offset: 2,
        });

        await pasteBlocks(page);
        await expect.poll(async () => (await getDOMState(editor)).paragraphs.map(item => item.text))
            .toEqual(["111", "221", "222"]);
        const pastedState = (await getDOMState(editor)).paragraphs;
        expect(pastedState[0].id).toBe(initialState[0].id);
        expect(pastedState[1].id).toBe(initialState[1].id);
        expect(pastedState[2].id).not.toBe(initialState[0].id);
        expect(pastedState[2].id).not.toBe(initialState[1].id);
        await expectDocumentState(siyuanAPI, docID, editor, pastedState);

        await page.keyboard.press(UNDO_SHORTCUT);
        await expectDocumentState(siyuanAPI, docID, editor, initialState);
        await expect.poll(() => getCollapsedSelectionPosition(editor)).toEqual({
            blockID: initialState[1].id,
            collapsed: true,
            offset: 2,
        });

        await page.keyboard.press(REDO_SHORTCUT);
        await expectDocumentState(siyuanAPI, docID, editor, pastedState);
    });

    test("persists an external plain-text replacement across multiple blocks", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const {docID, editor} = await createTestDocument(
            "External Plain Text Cross Block Paste E2E",
            "a\n\nb\n\nc",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        await page.evaluate(() => navigator.clipboard.writeText("replacement"));
        await selectParagraphRange(editor, 0, 2);
        await page.keyboard.press("ControlOrMeta+V");

        await expect.poll(async () => (await getDOMState(editor)).paragraphs.map(item => item.text))
            .toEqual(["replacement"]);
        const pastedState = (await getDOMState(editor)).paragraphs;
        expect(pastedState[0].id).toBe(initialState[0].id);
        await expectDocumentState(siyuanAPI, docID, editor, pastedState);

        await page.keyboard.press(UNDO_SHORTCUT);
        await expectDocumentState(siyuanAPI, docID, editor, initialState);

        await page.keyboard.press(REDO_SHORTCUT);
        await expectDocumentState(siyuanAPI, docID, editor, pastedState);
    });

    test("removes a fully selected heading at the start of a block paste", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const {docID, editor} = await createTestDocument(
            "Full Heading Cross Block Paste E2E",
            "# a\n\nb\n\nd\n\ne",
        );
        const initialIdentity = await getTopBlockIdentity(editor);
        expect(initialIdentity.map(item => item.type)).toEqual([
            "NodeHeading",
            "NodeParagraph",
            "NodeParagraph",
            "NodeParagraph",
        ]);

        await selectTopBlockRange(editor, 2, 3);
        await page.keyboard.press("ControlOrMeta+C");
        await expectClipboardText(page, ["d", "e"]);
        await selectTopBlockRange(editor, 0, 1);
        await pasteBlocks(page);

        await expect.poll(async () => (await getDOMState(editor)).paragraphs.map(item => item.text))
            .toEqual(["d", "e", "d", "e"]);
        const pastedState = (await getDOMState(editor)).paragraphs;
        expect(pastedState.slice(2).map(item => item.id)).toEqual(
            initialIdentity.slice(2).map(item => item.id),
        );
        await expectDocumentState(siyuanAPI, docID, editor, pastedState);

        await page.keyboard.press(UNDO_SHORTCUT);
        await expect.poll(() => getTopBlockIdentity(editor)).toEqual(initialIdentity);
        await expect.poll(() => getPersistedTopBlockIdentity(siyuanAPI, docID)).toEqual(initialIdentity);

        await page.keyboard.press(REDO_SHORTCUT);
        await expectDocumentState(siyuanAPI, docID, editor, pastedState);
    });

    test("persists a cross-block replacement starting in a code block", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const {docID, editor} = await createTestDocument(
            "Code Block Cross Block Paste E2E",
            "```js\na\n```\n\nb\n\nd\n\ne",
        );
        const initialIdentity = await getTopBlockIdentity(editor);
        expect(initialIdentity.map(item => item.type)).toEqual([
            "NodeCodeBlock",
            "NodeParagraph",
            "NodeParagraph",
            "NodeParagraph",
        ]);

        await selectTopBlockRange(editor, 2, 3);
        await page.keyboard.press("ControlOrMeta+C");
        await expectClipboardText(page, ["d", "e"]);
        await selectTopBlockRange(editor, 0, 1);
        await page.keyboard.press("ControlOrMeta+V");

        await expect.poll(() => getTopBlockIdentity(editor)).toEqual([
            initialIdentity[0],
            initialIdentity[2],
            initialIdentity[3],
        ]);
        const codeContent = editor.locator(
            ":scope > [data-type=\"NodeCodeBlock\"] [contenteditable=\"true\"]",
        ).last();
        await expect(codeContent).toContainText("d");
        await expect(codeContent).toContainText("e");
        await expect.poll(() => getPersistedTopBlockIdentity(siyuanAPI, docID)).toEqual([
            initialIdentity[0],
            initialIdentity[2],
            initialIdentity[3],
        ]);

        await page.keyboard.press(UNDO_SHORTCUT);
        await expect.poll(() => getTopBlockIdentity(editor)).toEqual(initialIdentity);
        await expect.poll(() => getPersistedTopBlockIdentity(siyuanAPI, docID)).toEqual(initialIdentity);

        await page.keyboard.press(REDO_SHORTCUT);
        await expect.poll(() => getTopBlockIdentity(editor)).toEqual([
            initialIdentity[0],
            initialIdentity[2],
            initialIdentity[3],
        ]);
        await expect.poll(() => getPersistedTopBlockIdentity(siyuanAPI, docID)).toEqual([
            initialIdentity[0],
            initialIdentity[2],
            initialIdentity[3],
        ]);
    });

    test("does not partially replace a cross-block range starting at a noneditable block", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Noneditable Cross Block Paste E2E",
            "Copy source\n\n$$\nx\n$$\n\nAfter",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        expect(initialState.map(item => item.text)).toEqual(["Copy source", "After"]);
        const initialTopBlocks = await editor.locator(":scope > [data-node-id]").evaluateAll(elements =>
            elements.map(item => ({
                id: item.getAttribute("data-node-id"),
                type: item.getAttribute("data-type"),
            })));

        await selectMathBlockToLastParagraph(editor);
        const existenceCheck = page.waitForResponse(response =>
            new URL(response.url()).pathname === "/api/block/checkBlocksExist", {timeout: 30000});
        await editor.evaluate(element => {
            const source = element.querySelector<HTMLElement>(":scope > [data-type=\"NodeParagraph\"]");
            const target = Array.from(element.querySelectorAll<HTMLElement>(
                ":scope > [data-type=\"NodeParagraph\"] > [contenteditable=\"true\"]",
            )).pop();
            if (!source || !target) {
                throw new Error("paste source or target is unavailable");
            }
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", source.textContent || "");
            clipboardData.setData("text/siyuan", source.outerHTML);
            target.dispatchEvent(new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData,
            }));
        });
        const response = await existenceCheck;
        const result = await response.json() as {code: number; msg: string};
        expect(result.code, result.msg).toBe(0);

        await expect.poll(() => editor.locator(":scope > [data-node-id]").evaluateAll(elements =>
            elements.map(item => ({
                id: item.getAttribute("data-node-id"),
                type: item.getAttribute("data-type"),
            })))).toEqual(initialTopBlocks);
        await expectDocumentState(siyuanAPI, docID, editor, initialState);
    });

    [
        {
            expectedMarkers: ["*", "*", "*"],
            markdown: "1\n\n* 23\n* 45",
            name: "unordered",
        },
        {
            expectedMarkers: ["1.", "2.", "3."],
            markdown: "1\n\n1. 23\n2. 45",
            name: "ordered",
        },
        {
            expectedMarkers: ["*", "*", "*"],
            markdown: "1\n\n* [ ] 23\n* [ ] 45",
            name: "task",
        },
    ].forEach(({expectedMarkers, markdown, name}) => {
        test(`pastes a paragraph-to-${name}-list range once after its original endpoint`, async ({
            baseURL,
            context,
            createTestDocument,
            page,
            siyuanAPI,
        }) => {
            await allowClipboard(context, baseURL);
            const {docID, editor} = await createTestDocument(
                `Paragraph To ${name} List Paste E2E`,
                markdown,
            );
            const initialListItems = await getDirectListItemState(editor);
            expect(initialListItems.map(item => item.text)).toEqual(["23", "45"]);

            await selectParagraphToFirstListItem(editor);
            await page.keyboard.press("ControlOrMeta+C");
            await expectClipboardText(page, ["1", "2"]);
            await page.keyboard.press("ControlOrMeta+V");

            await expect.poll(() => getDirectListItemState(editor)).toEqual(initialListItems);
            await expect.poll(() => getCollapsedSelectionPosition(editor)).toEqual({
                blockID: initialListItems[0].contentID,
                collapsed: true,
                offset: 1,
            });
            await expect.poll(() => getPersistedListItemState(siyuanAPI, docID)).toEqual(
                initialListItems.map(item => ({contentID: item.contentID, id: item.id, text: item.text})),
            );

            await pasteBlocks(page);
            await expect.poll(async () => (await getDirectListItemState(editor)).map(item => item.text))
                .toEqual(["21", "23", "45"]);
            const pastedListItems = await getDirectListItemState(editor);
            expect(pastedListItems.map(item => item.marker)).toEqual(expectedMarkers);
            expect(pastedListItems[0].id).toBe(initialListItems[0].id);
            expect(pastedListItems[1].id).not.toBe(initialListItems[0].id);
            expect(pastedListItems[1].id).not.toBe(initialListItems[1].id);
            expect(pastedListItems[2].id).toBe(initialListItems[1].id);
            await assertValidListDOM(editor);
            await assertValidSyListTree(siyuanAPI, docID, editor);
            await expect.poll(() => getPersistedListItemState(siyuanAPI, docID)).toEqual(
                pastedListItems.map(item => ({contentID: item.contentID, id: item.id, text: item.text})),
            );

            await page.keyboard.press(UNDO_SHORTCUT);
            await expect.poll(() => getDirectListItemState(editor)).toEqual(initialListItems);
            await assertValidSyListTree(siyuanAPI, docID, editor);
            await expect.poll(() => getPersistedListItemState(siyuanAPI, docID)).toEqual(
                initialListItems.map(item => ({contentID: item.contentID, id: item.id, text: item.text})),
            );
            await expect.poll(() => getCollapsedSelectionPosition(editor)).toEqual({
                blockID: initialListItems[0].contentID,
                collapsed: true,
                offset: 1,
            });

            await page.keyboard.press(REDO_SHORTCUT);
            await expect.poll(() => getDirectListItemState(editor)).toEqual(pastedListItems);
            await assertValidSyListTree(siyuanAPI, docID, editor);
            await expect.poll(() => getPersistedListItemState(siyuanAPI, docID)).toEqual(
                pastedListItems.map(item => ({contentID: item.contentID, id: item.id, text: item.text})),
            );
        });
    });

    test("pastes a paragraph-to-nested-list range at its actual endpoint", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const {docID, editor} = await createTestDocument(
            "Paragraph To Nested List Paste E2E",
            "1\n\n* outer\n    * 23\n* 45",
        );
        const initialTexts = ["1", "outer", "23", "45"];
        await expect.poll(() => getAllParagraphTexts(editor)).toEqual(initialTexts);

        await selectParagraphToNestedListItem(editor);
        await page.keyboard.press("ControlOrMeta+C");
        await expectClipboardText(page, ["1", "outer", "2"]);
        await page.keyboard.press("ControlOrMeta+V");

        await expect.poll(() => getAllParagraphTexts(editor)).toEqual(initialTexts);
        await expect.poll(() => getPersistedParagraphTexts(siyuanAPI, docID)).toEqual(initialTexts);

        await pasteBlocks(page);
        const pastedTexts = ["1", "outer", "21", "outer", "23", "45"];
        await expect.poll(() => getAllParagraphTexts(editor)).toEqual(pastedTexts);
        await expect.poll(() => getPersistedParagraphTexts(siyuanAPI, docID)).toEqual(pastedTexts);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);

        await page.keyboard.press(UNDO_SHORTCUT);
        await expect.poll(() => getAllParagraphTexts(editor)).toEqual(initialTexts);
        await expect.poll(() => getPersistedParagraphTexts(siyuanAPI, docID)).toEqual(initialTexts);

        await page.keyboard.press(REDO_SHORTCUT);
        await expect.poll(() => getAllParagraphTexts(editor)).toEqual(pastedTexts);
        await expect.poll(() => getPersistedParagraphTexts(siyuanAPI, docID)).toEqual(pastedTexts);
    });

    test("normalizes a mixed nested-list-to-sibling text range as an ordered list", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const destination = await createTestDocument(
            "Nested List Text Copy E2E",
            [
                "* Parent",
                "  1. 2",
                "* 3",
                "",
                "Destination anchor",
            ].join("\n"),
        );
        await selectNestedListItemToSibling(destination.editor);
        await page.keyboard.press("ControlOrMeta+C");
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("2\n3");

        const anchor = destination.editor.locator(':scope > [data-type="NodeParagraph"]');
        await focusAtEnd(anchor);
        await page.keyboard.press("Enter");
        await focusAtEnd(destination.editor.locator(':scope > [data-type="NodeParagraph"]').last());
        await pasteBlocks(page);

        const lists = destination.editor.locator(':scope > [data-type="NodeList"]');
        await expect(lists).toHaveCount(2);
        const pastedList = lists.last();
        await expect(pastedList).toHaveAttribute("data-subtype", "o");
        const pastedItems = pastedList.locator(':scope > [data-type="NodeListItem"]');
        await expect(pastedItems).toHaveCount(2);
        await expect(pastedItems.evaluateAll(items =>
            items.map(item => item.getAttribute("data-subtype")))).resolves.toEqual(["o", "o"]);
        await expect(pastedItems.locator(
            ':scope > [data-type="NodeParagraph"] > [contenteditable="true"]',
        )).toHaveText(["2", "3"]);
        await expect(pastedItems.locator(':scope > [data-type="NodeList"]')).toHaveCount(0);
        await expect(pastedList.locator('[data-type="virtual-block-ref"]')).toHaveCount(0);
        await assertValidListDOM(destination.editor);
        await assertValidSyListTree(siyuanAPI, destination.docID, destination.editor);
        await expect.poll(() => getPersistedParagraphTexts(siyuanAPI, destination.docID))
            .toEqual(["Parent", "2", "3", "Destination anchor", "2", "3"]);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, destination.docID);
        const reloadedLists = reloadedEditor.locator(':scope > [data-type="NodeList"]');
        await expect(reloadedLists).toHaveCount(2);
        const reloadedList = reloadedLists.last();
        await expect(reloadedList).toHaveAttribute("data-subtype", "o");
        const reloadedItems = reloadedList.locator(':scope > [data-type="NodeListItem"]');
        await expect(reloadedItems).toHaveCount(2);
        await expect(reloadedItems.evaluateAll(items =>
            items.map(item => item.getAttribute("data-subtype")))).resolves.toEqual(["o", "o"]);
        await expect(reloadedList.locator('[data-type="virtual-block-ref"]')).toHaveCount(0);
        await assertValidListDOM(reloadedEditor);
        await assertValidSyListTree(siyuanAPI, destination.docID, reloadedEditor);
    });

    test("undoes and redoes a pasted cross-block ordered list", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const testDocument = await createTestDocument(
            "Cross Block Ordered List Paste Undo E2E",
            [
                "* Parent",
                "  1. 2",
                "* 3",
                "",
                "Paste anchor",
            ].join("\n"),
        );
        await selectNestedListItemToSibling(testDocument.editor);
        await page.keyboard.press("ControlOrMeta+C");

        const anchor = testDocument.editor.locator(':scope > [data-type="NodeParagraph"]');
        await focusAtEnd(anchor);
        await page.keyboard.press("Enter");
        await focusAtEnd(testDocument.editor.locator(':scope > [data-type="NodeParagraph"]').last());
        const beforePasteTexts = ["Parent", "2", "3", "Paste anchor", ""];
        await expect.poll(() => getAllParagraphTexts(testDocument.editor)).toEqual(beforePasteTexts);
        await expect.poll(() => getPersistedParagraphTexts(siyuanAPI, testDocument.docID))
            .toEqual(beforePasteTexts);

        await pasteBlocks(page);
        const pastedTexts = ["Parent", "2", "3", "Paste anchor", "2", "3"];
        await expect.poll(() => getAllParagraphTexts(testDocument.editor)).toEqual(pastedTexts);
        await expect.poll(() => getPersistedParagraphTexts(siyuanAPI, testDocument.docID))
            .toEqual(pastedTexts);
        await assertValidListDOM(testDocument.editor);
        await assertValidSyListTree(siyuanAPI, testDocument.docID, testDocument.editor);

        await requestHistoryAction(page, testDocument.editor, UNDO_SHORTCUT, "undo");
        await expect.poll(() => getAllParagraphTexts(testDocument.editor)).toEqual(beforePasteTexts);
        await expect.poll(() => getPersistedParagraphTexts(siyuanAPI, testDocument.docID))
            .toEqual(beforePasteTexts);
        await assertValidListDOM(testDocument.editor);
        await assertValidSyListTree(siyuanAPI, testDocument.docID, testDocument.editor);

        await requestHistoryAction(page, testDocument.editor, REDO_SHORTCUT, "redo");
        await expect.poll(() => getAllParagraphTexts(testDocument.editor)).toEqual(pastedTexts);
        await expect.poll(() => getPersistedParagraphTexts(siyuanAPI, testDocument.docID))
            .toEqual(pastedTexts);
        await assertValidListDOM(testDocument.editor);
        await assertValidSyListTree(siyuanAPI, testDocument.docID, testDocument.editor);
    });

    test("preserves task-list conversion when replacing a cross-block range", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Cross Block Task List Conversion E2E",
            "a\n\nb",
        );
        const initialState = (await getDOMState(editor)).paragraphs;
        await selectParagraphRange(editor, 0, 1);
        await pasteInternalInlineHTML(editor, "[ ]");

        await expect.poll(() => getTopBlockIdentity(editor).then(items => items.map(item => item.type)))
            .toEqual(["NodeList"]);
        await expect.poll(() => editor.locator(
            ":scope > [data-type=\"NodeList\"] > [data-type=\"NodeListItem\"]",
        ).getAttribute("data-subtype")).toBe("t");
        // 粘贴后列表骨架先出现、内部段落属性元素随后渲染完成，轮询等待结构稳定
        await expect.poll(async () => {
            try {
                await assertValidListDOM(editor);
                return true;
            } catch {
                return false;
            }
        }, {timeout: 30000}).toBe(true);
        await assertValidSyListTree(siyuanAPI, docID, editor);

        await page.keyboard.press(UNDO_SHORTCUT);
        await expectDocumentState(siyuanAPI, docID, editor, initialState);

        await page.keyboard.press(REDO_SHORTCUT);
        await expect.poll(() => getTopBlockIdentity(editor).then(items => items.map(item => item.type)))
            .toEqual(["NodeList"]);
        await expect.poll(async () => {
            try {
                await assertValidListDOM(editor);
                return true;
            } catch {
                return false;
            }
        }, {timeout: 30000}).toBe(true);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    test("preserves heading-to-list conversion when replacing a cross-block range", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Cross Block Heading List Conversion E2E",
            "# a\n\nb",
        );
        const initialIdentity = await getTopBlockIdentity(editor);
        await selectTopBlockRange(editor, 0, 1);
        await pasteInternalInlineHTML(editor, "* ");

        await expect.poll(() => getTopBlockIdentity(editor).then(items => items.map(item => item.type)))
            .toEqual(["NodeList"]);
        await expect(editor.locator(
            ":scope > [data-type=\"NodeList\"] > [data-type=\"NodeListItem\"] " +
            "> [data-type=\"NodeHeading\"]",
        )).toHaveCount(1);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);

        await page.keyboard.press(UNDO_SHORTCUT);
        await expect.poll(() => getTopBlockIdentity(editor)).toEqual(initialIdentity);
        await expect.poll(() => getPersistedTopBlockIdentity(siyuanAPI, docID)).toEqual(initialIdentity);

        await page.keyboard.press(REDO_SHORTCUT);
        await expect.poll(() => getTopBlockIdentity(editor).then(items => items.map(item => item.type)))
            .toEqual(["NodeList"]);
        await assertValidSyListTree(siyuanAPI, docID, editor);
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
        await expect.poll(async () => Object.values(await siyuanAPI.checkBlocksExist(originalIDs)), {
            timeout: 30000,
        }).toEqual(originalIDs.map(() => false));
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
