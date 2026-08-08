import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openBlockMenu} from "./helpers/blockMenu";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface ISyNode {
    ID?: string;
    Data?: string;
    Properties?: Record<string, string>;
    Type?: string;
    Children?: ISyNode[];
}

const flattenNodes = (node: ISyNode): ISyNode[] => [
    node,
    ...(node.Children || []).flatMap(flattenNodes),
];

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

const selectContiguousBlocks = async (blocks: Locator, editor: Locator, start: number, end: number) => {
    await blocks.nth(start).locator('[contenteditable="true"]').click();
    await blocks.nth(end).click({modifiers: ["Shift"]});
    await expect(editor.locator(":scope > .protyle-wysiwyg--select")).toHaveCount(end - start + 1);
};

const openMenuForBlock = async (page: Page, block: Locator) => {
    const hoverTarget = await block.getAttribute("data-type") === "NodeSuperBlock"
        ? block.locator(":scope > [data-node-id]").first()
        : block;
    return openBlockMenu(page, block, hoverTarget);
};

const mergeSelectedBlocks = async (page: Page, block: Locator, layout: "hLayout" | "vLayout") => {
    const menu = await openMenuForBlock(page, block);
    const merge = menu.locator('[data-id="mergeSuperBlock"]').first();
    await merge.hover();
    const option = merge.locator(`.b3-menu__submenu [data-id="${layout}"]`).first();
    await expect(option).toBeVisible();
    await requestTransaction(page, () => option.click());
};

const useSuperBlockMenu = async (page: Page, superBlock: Locator, optionID: string) => {
    const menu = await openMenuForBlock(page, superBlock);
    const superBlockMenu = menu.locator('[data-id="superBlock"]').first();
    await superBlockMenu.hover();
    const option = superBlockMenu.locator(`.b3-menu__submenu [data-id="${optionID}"]`).first();
    await expect(option).toBeVisible();
    await requestTransaction(page, () => option.click());
};

const getTopDOMState = async (editor: Locator) => editor.locator(":scope > [data-node-id]").evaluateAll(elements =>
    elements.map(element => ({
        id: element.getAttribute("data-node-id") || "",
        layout: element.getAttribute("data-sb-layout") || "",
        text: element.textContent || "",
        type: element.getAttribute("data-type") || "",
    })));

const getSuperBlockDOMState = async (superBlock: Locator) => superBlock.evaluate(element => {
    const allBlocks = Array.from(element.querySelectorAll("[data-node-id]"));
    const ids = allBlocks.map(item => item.getAttribute("data-node-id") || "");
    return {
        childIDs: Array.from(element.querySelectorAll(":scope > [data-node-id]"))
            .map(item => item.getAttribute("data-node-id") || ""),
        duplicateIDCount: ids.length - new Set(ids).size,
        invalidChildren: Array.from(element.querySelectorAll(":scope > [data-node-id]"))
            .filter(item => item.parentElement !== element).length,
        layout: element.getAttribute("data-sb-layout") || "",
    };
});

const getPersistedSuperBlockState = async (api: SiyuanAPI, docID: string) => {
    const document = await readValidDocument(api, docID);
    const superBlock = (document.Children || []).find(node => node.Type === "NodeSuperBlock");
    return {
        childIDs: (superBlock?.Children || []).filter(node => node.ID).map(node => node.ID),
        id: superBlock?.ID || "",
        layout: (superBlock?.Children || []).find(node => node.Type === "NodeSuperBlockLayoutMarker")?.Data || "",
        topTypes: (document.Children || []).map(node => node.Type),
    };
};

test.describe("super block editing", () => {
    test.describe.configure({mode: "parallel"});

    test("creates a horizontal super block, changes its layout, and removes it", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Horizontal Super Block E2E",
            "Before\n\nLeft column\n\nRight column\n\nAfter",
        );
        const initialState = await getTopDOMState(editor);
        const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
        await selectContiguousBlocks(paragraphs, editor, 1, 2);
        await mergeSelectedBlocks(page, paragraphs.nth(1), "hLayout");

        let superBlock = editor.locator(':scope > [data-type="NodeSuperBlock"]');
        await expect(superBlock).toHaveCount(1);
        const superBlockID = await superBlock.getAttribute("data-node-id");
        expect(superBlockID).toBeTruthy();
        expect(initialState.map(item => item.id)).not.toContain(superBlockID);
        await expect.poll(() => getSuperBlockDOMState(superBlock)).toEqual({
            childIDs: [initialState[1].id, initialState[2].id],
            duplicateIDCount: 0,
            invalidChildren: 0,
            layout: "col",
        });
        await expect.poll(() => getPersistedSuperBlockState(siyuanAPI, docID)).toEqual({
            childIDs: [initialState[1].id, initialState[2].id],
            id: superBlockID,
            layout: "col",
            topTypes: ["NodeParagraph", "NodeSuperBlock", "NodeParagraph"],
        });

        await page.reload();
        let reloadedEditor = await getDocumentEditor(page, docID);
        superBlock = reloadedEditor.locator(':scope > [data-type="NodeSuperBlock"]');
        await expect.poll(() => getSuperBlockDOMState(superBlock)).toEqual({
            childIDs: [initialState[1].id, initialState[2].id],
            duplicateIDCount: 0,
            invalidChildren: 0,
            layout: "col",
        });

        await useSuperBlockMenu(page, superBlock, "turnIntoVLayout");
        await expect(superBlock).toHaveAttribute("data-sb-layout", "row");
        await expect.poll(() => getPersistedSuperBlockState(siyuanAPI, docID)).toMatchObject({layout: "row"});

        await requestHistoryAction(page, reloadedEditor, UNDO_SHORTCUT, "undo");
        await expect(superBlock).toHaveAttribute("data-sb-layout", "col");
        await requestHistoryAction(page, reloadedEditor, REDO_SHORTCUT, "redo");
        await expect(superBlock).toHaveAttribute("data-sb-layout", "row");

        await useSuperBlockMenu(page, superBlock, "cancelSuperBlock");
        await expect.poll(() => getTopDOMState(reloadedEditor)).toEqual(initialState);
        await requestHistoryAction(page, reloadedEditor, UNDO_SHORTCUT, "undo");
        superBlock = reloadedEditor.locator(':scope > [data-type="NodeSuperBlock"]');
        await expect(superBlock).toHaveAttribute("data-node-id", superBlockID!);
        await expect(superBlock).toHaveAttribute("data-sb-layout", "row");
        await requestHistoryAction(page, reloadedEditor, REDO_SHORTCUT, "redo");
        await expect.poll(() => getTopDOMState(reloadedEditor)).toEqual(initialState);

        await page.reload();
        reloadedEditor = await getDocumentEditor(page, docID);
        await expect.poll(() => getTopDOMState(reloadedEditor)).toEqual(initialState);
    });

    test("creates and persists a vertical super block and restores it after undo", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Vertical Super Block E2E",
            "Top row\n\nMiddle row\n\nBottom row",
        );
        const initialState = await getTopDOMState(editor);
        const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
        await selectContiguousBlocks(paragraphs, editor, 0, 2);
        await mergeSelectedBlocks(page, paragraphs.nth(0), "vLayout");

        let superBlock = editor.locator(':scope > [data-type="NodeSuperBlock"]');
        await expect(superBlock).toHaveCount(1);
        const superBlockID = await superBlock.getAttribute("data-node-id");
        await expect.poll(() => getSuperBlockDOMState(superBlock)).toEqual({
            childIDs: initialState.map(item => item.id),
            duplicateIDCount: 0,
            invalidChildren: 0,
            layout: "row",
        });
        await expect.poll(() => getPersistedSuperBlockState(siyuanAPI, docID)).toEqual({
            childIDs: initialState.map(item => item.id),
            id: superBlockID,
            layout: "row",
            topTypes: ["NodeSuperBlock"],
        });

        await useSuperBlockMenu(page, superBlock, "cancelSuperBlock");
        await expect.poll(() => getTopDOMState(editor)).toEqual(initialState);
        await requestHistoryAction(page, editor, UNDO_SHORTCUT, "undo");
        superBlock = editor.locator(':scope > [data-type="NodeSuperBlock"]');
        await expect(superBlock).toHaveAttribute("data-node-id", superBlockID!);
        await expect(superBlock).toHaveAttribute("data-sb-layout", "row");

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        await expect.poll(() => getSuperBlockDOMState(
            reloadedEditor.locator(':scope > [data-type="NodeSuperBlock"]'))).toEqual({
            childIDs: initialState.map(item => item.id),
            duplicateIDCount: 0,
            invalidChildren: 0,
            layout: "row",
        });
    });
});
