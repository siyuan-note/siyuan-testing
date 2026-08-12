import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openBlockMenu} from "./helpers/blockMenu";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface ISyNode {
    Data?: string;
    ID?: string;
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

const focusCellAtEnd = async (cell: Locator) => {
    await cell.evaluate(element => {
        const editable = element.closest<HTMLElement>('[contenteditable="true"]');
        if (!editable) {
            throw new Error("table editable container is unavailable");
        }
        editable.focus();
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

const waitForScrollSettled = async (content: Locator) => content.evaluate(element =>
    new Promise<number>(resolve => {
        let frames = 0;
        let lastScrollTop = element.scrollTop;
        let stableFrames = 0;
        const observe = () => {
            const scrollTop = element.scrollTop;
            stableFrames = Math.abs(scrollTop - lastScrollTop) < 0.5 ? stableFrames + 1 : 0;
            lastScrollTop = scrollTop;
            frames++;
            if (stableFrames >= 12 || frames >= 180) {
                resolve(scrollTop);
                return;
            }
            requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
    }));

const selectContiguousBlocks = async (blocks: Locator, editor: Locator, start: number, end: number) => {
    await blocks.nth(start).locator('[contenteditable="true"]').first().click();
    await blocks.nth(end).click({modifiers: ["Shift"]});
    await expect(editor.locator(":scope > .protyle-wysiwyg--select")).toHaveCount(end - start + 1);
};

const mergeSelectedBlocks = async (page: Page, block: Locator, layout: "hLayout" | "vLayout") => {
    const hoverTarget = await block.getAttribute("data-type") === "NodeSuperBlock" ?
        block.locator(":scope > [data-node-id]").first() : block;
    const menu = await openBlockMenu(page, block, hoverTarget);
    const merge = menu.locator('[data-id="mergeSuperBlock"]').first();
    await merge.hover();
    const option = merge.locator(`.b3-menu__submenu [data-id="${layout}"]`).first();
    await expect(option).toBeVisible();
    await requestTransaction(page, () => option.click());
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
    await focusAtEnd(editor.locator(':scope > [data-type="NodeParagraph"]').last());
    await page.keyboard.press(shortcut);
    await response;
};

const waitForIndexedBlock = async (api: SiyuanAPI, query: string, blockID: string) => {
    await expect.poll(async () => {
        const result = await api.searchBlocks(query);
        return result.blocks.some(block => block.id === blockID);
    }, {timeout: 30000}).toBe(true);
};

const waitForPersistedBlockText = async (api: SiyuanAPI, docID: string, blockID: string, text: string) => {
    await expect.poll(async () => {
        const document = await readValidDocument(api, docID);
        const block = flattenNodes(document).find(node => node.ID === blockID);
        return block ? getNodeText(block) : "";
    }, {timeout: 30000}).toBe(text);
};

const getTopDOMState = async (editor: Locator) => editor.locator(":scope > [data-node-id]").evaluateAll(elements =>
    elements.map(element => ({
        content: element.getAttribute("data-content") || "",
        id: element.getAttribute("data-node-id") || "",
        text: element.querySelector(':scope > [contenteditable="true"]')?.textContent || "",
        type: element.getAttribute("data-type") || "",
    })));

const getPersistedEmbedState = async (api: SiyuanAPI, docID: string) => {
    const document = await readValidDocument(api, docID);
    const embed = (document.Children || []).find(node => node.Type === "NodeBlockQueryEmbed");
    return {
        id: embed?.ID || "",
        query: (embed?.Children || []).find(node => node.Type === "NodeBlockQueryEmbedScript")?.Data || "",
        topTypes: (document.Children || []).map(node => node.Type),
    };
};

interface INestedSuperBlockState {
    duplicateIDCount: number;
    firstColumnChildIDs: string[];
    firstColumnLayout: string;
    firstColumnTexts: string[];
    firstColumnType: string;
    innerChildIDs: string[];
    innerID: string;
    innerLayout: string;
    outerChildIDs: string[];
    outerLayout: string;
}

const getNestedSuperBlockDOMState = async (outer: Locator): Promise<INestedSuperBlockState> =>
    outer.evaluate(element => {
        const directBlocks = (item: Element) => Array.from(item.children)
            .filter(child => child.hasAttribute("data-node-id"));
        const blockIDs = (items: Element[]) => items.map(item => item.getAttribute("data-node-id") || "");
        const outerChildren = directBlocks(element);
        const inner = outerChildren[0];
        const innerChildren = inner ? directBlocks(inner) : [];
        const firstColumn = innerChildren[0];
        const firstColumnChildren = firstColumn?.getAttribute("data-type") === "NodeSuperBlock" ?
            directBlocks(firstColumn) : [];
        const allIDs = Array.from(element.querySelectorAll("[data-node-id]"))
            .map(item => item.getAttribute("data-node-id") || "");
        return {
            duplicateIDCount: allIDs.length - new Set(allIDs).size,
            firstColumnChildIDs: blockIDs(firstColumnChildren),
            firstColumnLayout: firstColumn?.getAttribute("data-sb-layout") || "",
            firstColumnTexts: firstColumnChildren.map(item =>
                item.querySelector(':scope > [contenteditable="true"]')?.textContent || ""),
            firstColumnType: firstColumn?.getAttribute("data-type") || "",
            innerChildIDs: blockIDs(innerChildren),
            innerID: inner?.getAttribute("data-node-id") || "",
            innerLayout: inner?.getAttribute("data-sb-layout") || "",
            outerChildIDs: blockIDs(outerChildren),
            outerLayout: element.getAttribute("data-sb-layout") || "",
        };
    });

const getNestedSuperBlockPersistedState = async (api: SiyuanAPI, docID: string,
                                                  outerID: string): Promise<INestedSuperBlockState> => {
    const document = await readValidDocument(api, docID);
    const outer = flattenNodes(document).find(node => node.ID === outerID);
    const blockChildren = (node?: ISyNode) => (node?.Children || []).filter(child => child.ID);
    const layout = (node?: ISyNode) => (node?.Children || [])
        .find(child => child.Type === "NodeSuperBlockLayoutMarker")?.Data || "";
    const outerChildren = blockChildren(outer);
    const inner = outerChildren[0];
    const innerChildren = blockChildren(inner);
    const firstColumn = innerChildren[0];
    const firstColumnChildren = firstColumn?.Type === "NodeSuperBlock" ? blockChildren(firstColumn) : [];
    const ids = flattenNodes(outer || {}).flatMap(node => node.ID ? [node.ID] : []);
    return {
        duplicateIDCount: ids.length - new Set(ids).size,
        firstColumnChildIDs: firstColumnChildren.map(node => node.ID || ""),
        firstColumnLayout: layout(firstColumn),
        firstColumnTexts: firstColumnChildren.map(getNodeText),
        firstColumnType: firstColumn?.Type || "",
        innerChildIDs: innerChildren.map(node => node.ID || ""),
        innerID: inner?.ID || "",
        innerLayout: layout(inner),
        outerChildIDs: outerChildren.map(node => node.ID || ""),
        outerLayout: layout(outer),
    };
};

const getSelectionEmbedState = async (editor: Locator) => editor.evaluate(element => {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0) {
        return undefined;
    }
    const range = selection.getRangeAt(0);
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ?
        range.startContainer as Element : range.startContainer.parentElement;
    const block = startElement?.closest("[data-node-id]");
    const embed = startElement?.closest('[data-type="NodeBlockQueryEmbed"]');
    return {
        blockID: block && element.contains(block) ? block.getAttribute("data-node-id") || "" : "",
        collapsed: range.collapsed,
        embedID: embed && element.contains(embed) ? embed.getAttribute("data-node-id") || "" : "",
    };
});

const insertEmbedBlock = async (page: Page, api: SiyuanAPI, docID: string, editor: Locator,
                                sourceID: string, query: string) => {
    const paragraph = editor.locator(':scope > [data-type="NodeParagraph"]').first();
    const paragraphID = await paragraph.getAttribute("data-node-id");
    expect(paragraphID).toBeTruthy();
    const editable = paragraph.locator(':scope > [contenteditable="true"]');
    if (await editable.textContent()) {
        await editable.fill("");
    }
    await focusAtEnd(paragraph);
    await page.keyboard.type(`{{${query}`, {delay: 10});
    const protyle = editor.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle ')][1]");
    const hint = protyle.locator(".protyle-hint:not(.fn__none)");
    // 嵌入块提示需要等待内核搜索返回，高负载下可能超过默认的 5 秒超时
    await expect(hint).toBeVisible({timeout: 15000});
    const sourceOption = hint.locator(`button:has([data-node-id="${sourceID}"])`).first();
    await expect(sourceOption).toBeVisible({timeout: 15000});
    await waitForPersistedBlockText(api, docID, paragraphID!, `{{${query}`);
    await requestTransaction(page, () => sourceOption.click());
    const embed = editor.locator(':scope > [data-type="NodeBlockQueryEmbed"]');
    await expect(embed).toHaveCount(1);
    await expect(embed).toHaveAttribute("data-content", `select * from blocks where id='${sourceID}'`);
    await expect(embed.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toBeVisible({timeout: 15000});
    return embed;
};

test.describe("block query embeds", () => {
    test.describe.configure({mode: "parallel"});

    test("inserts a query embed and restores it with undo and redo", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const query = `Embedded source ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const source = await createTestDocument("Query Embed Source E2E", query);
        const sourceID = await source.editor.locator(':scope > [data-type="NodeParagraph"]').first()
            .getAttribute("data-node-id");
        expect(sourceID).toBeTruthy();
        await waitForIndexedBlock(siyuanAPI, query, sourceID!);

        const target = await createTestDocument(
            "Query Embed Target E2E",
            "Query placeholder\n\nTarget undo anchor",
        );
        const initialState = await getTopDOMState(target.editor);
        const typedQueryState = initialState.map((item, index) => ({
            ...item,
            text: index === 0 ? `{{${query}` : item.text,
        }));
        let embed = await insertEmbedBlock(page, siyuanAPI, target.docID, target.editor, sourceID!, query);
        const embedID = await embed.getAttribute("data-node-id");
        expect(embedID).toBeTruthy();
        await expect(embed.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toContainText(query);
        await expect.poll(() => getPersistedEmbedState(siyuanAPI, target.docID), {timeout: 30000}).toEqual({
            id: embedID,
            query: `select * from blocks where id='${sourceID}'`,
            topTypes: ["NodeBlockQueryEmbed", "NodeParagraph"],
        });

        await requestHistoryAction(page, target.editor, UNDO_SHORTCUT, "undo");
        await expect.poll(() => getTopDOMState(target.editor)).toEqual(typedQueryState);
        await requestHistoryAction(page, target.editor, REDO_SHORTCUT, "redo");
        embed = target.editor.locator(':scope > [data-type="NodeBlockQueryEmbed"]');
        await expect(embed).toHaveAttribute("data-node-id", embedID!);
        await expect(embed.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toContainText(query);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, target.docID);
        await expect(reloadedEditor.locator(`:scope > [data-node-id="${embedID}"]`)).toHaveAttribute(
            "data-content", `select * from blocks where id='${sourceID}'`);
        await expect(reloadedEditor.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toContainText(query);
    });

    test("edits a source block through an embed and refreshes the rendered result", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const query = `Editable embedded source ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const updatedText = `${query} updated`;
        const source = await createTestDocument("Editable Query Embed Source E2E", query);
        const sourceID = await source.editor.locator(':scope > [data-type="NodeParagraph"]').first()
            .getAttribute("data-node-id");
        expect(sourceID).toBeTruthy();
        await waitForIndexedBlock(siyuanAPI, query, sourceID!);

        const target = await createTestDocument("Editable Query Embed Target E2E");
        const embed = await insertEmbedBlock(page, siyuanAPI, target.docID, target.editor, sourceID!, query);
        const embeddedSource = embed.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"] [data-node-id="${sourceID}"]`);
        const editable = embeddedSource.locator('[contenteditable="true"]').first();
        await expect(editable).toHaveText(query);
        await editable.selectText();
        await page.keyboard.type(updatedText, {delay: 5});
        await waitForPersistedBlockText(siyuanAPI, source.docID, sourceID!, updatedText);
        await expect(editable).toHaveText(updatedText);

        const renderResponse = page.waitForResponse(item =>
            new URL(item.url()).pathname === "/api/search/searchEmbedBlock", {timeout: 15000});
        await embed.locator(".protyle-action__reload").click();
        await renderResponse;
        await expect(embed.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toContainText(updatedText);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, target.docID);
        await expect(reloadedEditor.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`)).toContainText(updatedText);
    });

    test("keeps the source table in view after undo when the same table is embedded above", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const filler = `Scroll position filler ${"content ".repeat(500)}`;
        const created = await createTestDocument(
            "Embedded Source Table Undo Scroll E2E",
            [
                "Embed placeholder",
                filler,
                [
                    "| 11111 | 222 | 333 |",
                    "| --- | --- | --- |",
                    "| 444 | 555 | 666 |",
                    "| 777 | 888 | 999 |",
                ].join("\n"),
            ].join("\n\n"),
        );
        const placeholder = created.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const placeholderID = await placeholder.getAttribute("data-node-id");
        const initialTable = created.editor.locator(':scope > [data-type="NodeTable"]');
        const tableID = await initialTable.getAttribute("data-node-id");
        expect(placeholderID).toBeTruthy();
        expect(tableID).toBeTruthy();

        await siyuanAPI.updateBlock(placeholderID!, `{{select * from blocks where id='${tableID}'}}`);
        await expect.poll(async () => {
            const document = await readValidDocument(siyuanAPI, created.docID);
            return flattenNodes(document).find(node => node.ID === placeholderID)?.Type;
        }, {timeout: 30000}).toBe("NodeBlockQueryEmbed");
        await page.reload();

        const editor = await getDocumentEditor(page, created.docID);
        const embed = editor.locator(`:scope > [data-node-id="${placeholderID}"]`);
        const embeddedTable = embed.locator(`.protyle-wysiwyg__embed [data-node-id="${tableID}"]`);
        const sourceTable = editor.locator(`:scope > [data-node-id="${tableID}"]`);
        await expect(embed).toHaveAttribute("data-type", "NodeBlockQueryEmbed");
        await expect(embeddedTable).toBeVisible({timeout: 15000});
        await expect(sourceTable).toBeAttached();

        const content = editor.locator(
            "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle-content ')][1]",
        );
        await sourceTable.evaluate(element => {
            const contentElement = element.closest<HTMLElement>(".protyle-content");
            if (!contentElement) {
                throw new Error("editor content container is unavailable");
            }
            const contentRect = contentElement.getBoundingClientRect();
            const tableRect = element.getBoundingClientRect();
            contentElement.scrollTop += tableRect.top - contentRect.top -
                (contentElement.clientHeight - tableRect.height) / 2;
        });
        await waitForScrollSettled(content);
        await expect(sourceTable).toBeInViewport();
        await expect(embeddedTable).not.toBeInViewport();

        const sourceCell = sourceTable.locator("thead th").first();
        const embeddedCell = embeddedTable.locator("thead th").first();
        await focusCellAtEnd(sourceCell);
        await requestTransaction(page, () => page.keyboard.type("2"));
        await expect(sourceCell).toHaveText("111112");
        await expect(embeddedCell).toHaveText("111112");
        const scrollTopBeforeUndo = await waitForScrollSettled(content);

        const undoResponse = page.waitForResponse(item =>
            new URL(item.url()).pathname === "/api/transactions/undo", {timeout: 15000});
        await page.keyboard.press(UNDO_SHORTCUT);
        await undoResponse;
        await expect(sourceCell).toHaveText("11111");
        await expect(embeddedCell).toHaveText("11111");
        const scrollTopAfterUndo = await waitForScrollSettled(content);

        expect(Math.abs(scrollTopAfterUndo - scrollTopBeforeUndo)).toBeLessThan(2);
        await expect(sourceTable).toBeInViewport();
        await expect(embeddedTable).not.toBeInViewport();
        await expect.poll(() => getSelectionEmbedState(editor)).toEqual({
            blockID: tableID,
            collapsed: true,
            embedID: "",
        });
    });

    test("splits a nested super block through an embed and keeps undo focus inside the embed", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const created = await createTestDocument(
            "Editable Embedded Nested Super Block E2E",
            "111\n\n222\n\n3333\n\nEmbed placeholder",
        );
        let editor = created.editor;
        const initialParagraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
        const firstID = await initialParagraphs.nth(0).getAttribute("data-node-id");
        const secondID = await initialParagraphs.nth(1).getAttribute("data-node-id");
        const thirdID = await initialParagraphs.nth(2).getAttribute("data-node-id");
        const placeholderID = await initialParagraphs.nth(3).getAttribute("data-node-id");
        expect(firstID).toBeTruthy();
        expect(secondID).toBeTruthy();
        expect(thirdID).toBeTruthy();
        expect(placeholderID).toBeTruthy();

        await selectContiguousBlocks(initialParagraphs, editor, 0, 1);
        await mergeSelectedBlocks(page, initialParagraphs.nth(0), "hLayout");
        const topBlocks = editor.locator(":scope > [data-node-id]");
        await selectContiguousBlocks(topBlocks, editor, 0, 1);
        await mergeSelectedBlocks(page, topBlocks.nth(0), "vLayout");

        let sourceOuter = editor.locator(':scope > [data-type="NodeSuperBlock"][data-sb-layout="row"]');
        await expect(sourceOuter).toHaveCount(1);
        const outerID = await sourceOuter.getAttribute("data-node-id");
        expect(outerID).toBeTruthy();
        const originalState = await getNestedSuperBlockDOMState(sourceOuter);
        expect(originalState).toMatchObject({
            duplicateIDCount: 0,
            firstColumnChildIDs: [],
            firstColumnLayout: "",
            firstColumnType: "NodeParagraph",
            innerChildIDs: [firstID, secondID],
            innerLayout: "col",
            outerChildIDs: [originalState.innerID, thirdID],
            outerLayout: "row",
        });

        await expect.poll(async () => {
            const rows = await siyuanAPI.querySQL(`select id from blocks where id = '${outerID}'`);
            return rows.some(row => row.id === outerID);
        }, {timeout: 30000}).toBe(true);
        await siyuanAPI.updateBlock(placeholderID!, `{{select * from blocks where id='${outerID}'}}`);
        await expect.poll(async () => {
            const document = await readValidDocument(siyuanAPI, created.docID);
            return flattenNodes(document).find(node => node.ID === placeholderID)?.Type;
        }, {timeout: 30000}).toBe("NodeBlockQueryEmbed");
        await page.reload();
        editor = await getDocumentEditor(page, created.docID);
        sourceOuter = editor.locator(`:scope > [data-node-id="${outerID}"]`);
        const embed = editor.locator(`:scope > [data-node-id="${placeholderID}"]`);
        await expect(embed).toHaveAttribute("data-type", "NodeBlockQueryEmbed");
        let embeddedOuter = embed.locator(`.protyle-wysiwyg__embed[data-id="${outerID}"] > [data-node-id="${outerID}"]`);
        await expect(embeddedOuter).toBeVisible({timeout: 15000});
        await expect.poll(() => getNestedSuperBlockDOMState(embeddedOuter)).toEqual(originalState);

        const embeddedFirst = embeddedOuter.locator(`[data-node-id="${firstID}"]`);
        await focusAtEnd(embeddedFirst);
        await requestTransaction(page, () => page.keyboard.press("Enter"));

        await expect.poll(() => getNestedSuperBlockDOMState(sourceOuter)).toMatchObject({
            duplicateIDCount: 0,
            firstColumnLayout: "row",
            firstColumnTexts: ["111", ""],
            firstColumnType: "NodeSuperBlock",
            innerLayout: "col",
            outerLayout: "row",
        });
        const sourceSplitState = await getNestedSuperBlockDOMState(sourceOuter);
        expect(sourceSplitState.innerChildIDs[1]).toBe(secondID);
        expect(sourceSplitState.firstColumnChildIDs[0]).toBe(firstID);
        expect(sourceSplitState.firstColumnChildIDs).toHaveLength(2);
        await expect.poll(() => getNestedSuperBlockDOMState(embeddedOuter)).toEqual(sourceSplitState);
        await expect.poll(() => getNestedSuperBlockPersistedState(
            siyuanAPI, created.docID, outerID!)).toEqual(sourceSplitState);

        const undoResponse = page.waitForResponse(item =>
            new URL(item.url()).pathname === "/api/transactions/undo", {timeout: 15000});
        const embedRenderResponse = page.waitForResponse(item =>
            new URL(item.url()).pathname === "/api/search/searchEmbedBlock", {timeout: 15000});
        await page.keyboard.press(UNDO_SHORTCUT);
        await Promise.all([undoResponse, embedRenderResponse]);

        embeddedOuter = embed.locator(`.protyle-wysiwyg__embed[data-id="${outerID}"] > [data-node-id="${outerID}"]`);
        await expect(embeddedOuter).toBeVisible({timeout: 15000});
        await expect.poll(() => getNestedSuperBlockDOMState(sourceOuter)).toEqual(originalState);
        await expect.poll(() => getNestedSuperBlockDOMState(embeddedOuter)).toEqual(originalState);
        await expect.poll(() => getSelectionEmbedState(editor)).toEqual({
            blockID: firstID,
            collapsed: true,
            embedID: placeholderID,
        });
        await expect.poll(() => getNestedSuperBlockPersistedState(
            siyuanAPI, created.docID, outerID!)).toEqual(originalState);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, created.docID);
        const reloadedSource = reloadedEditor.locator(`:scope > [data-node-id="${outerID}"]`);
        const reloadedEmbed = reloadedEditor.locator(`:scope > [data-node-id="${placeholderID}"]`);
        await expect.poll(() => getNestedSuperBlockDOMState(reloadedSource)).toEqual(originalState);
        await expect.poll(() => getNestedSuperBlockDOMState(
            reloadedEmbed.locator(`.protyle-wysiwyg__embed[data-id="${outerID}"] > [data-node-id="${outerID}"]`)
        )).toEqual(originalState);
    });
});
