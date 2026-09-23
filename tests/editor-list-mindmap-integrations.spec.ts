import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openBlockMenu} from "./helpers/blockMenu";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {assertValidListDOM, assertValidSyListTree} from "./helpers/listAssertions";
import {getDocumentEditor, TestDocumentFactory} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface ISyNode {
    Children?: ISyNode[];
    Data?: string;
    ID?: string;
    Properties?: Record<string, string>;
    Type: string;
}

interface IRenderedAttributeView {
    view: {
        columns: Array<{id: string; type: string}>;
        rowCount: number;
        rows: Array<{
            cells: Array<{value: {keyID: string; text?: {content: string}}}>;
            id: string;
        }>;
    };
}

const findNode = (node: ISyNode, id: string): ISyNode | undefined => {
    if (node.ID === id) {
        return node;
    }
    for (const child of node.Children || []) {
        const found = findNode(child, id);
        if (found) {
            return found;
        }
    }
};

const nodeText = (node: ISyNode): string =>
    (node.Data || "") + (node.Children || []).map(nodeText).join("");

const blockStructure = (root: ISyNode) => {
    const blocks: Array<{id: string; parentID: string | undefined; type: string}> = [];
    const visit = (node: ISyNode, parentID?: string) => {
        if (node.ID) {
            blocks.push({id: node.ID, parentID, type: node.Type});
        }
        (node.Children || []).forEach(child => visit(child, node.ID || parentID));
    };
    visit(root);
    return blocks;
};

const focusAtEnd = async (element: Locator) => {
    await element.evaluate(target => {
        (target as HTMLElement).focus();
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    });
};

const chooseListConversion = async (page: Page, list: Locator, optionID: string, hoverTarget = list) => {
    const menu = await openBlockMenu(page, list, hoverTarget);
    const turnInto = menu.locator('[data-id="turnInto"]').first();
    await turnInto.hover();
    const option = turnInto.locator(`.b3-menu__submenu [data-id="${optionID}"]`).first();
    await expect(option).toBeVisible();
    await option.click();
};

const openMindmapNodeEditor = async (editor: Locator) => {
    const list = editor.locator(':scope > [data-type="NodeList"]');
    const itemID = await list.locator(':scope > [data-type="NodeListItem"]').first().getAttribute("data-node-id");
    expect(itemID).toBeTruthy();
    const content = list.locator(":scope > .list-mindmap")
        .locator(`[data-mindmap-id="${itemID}"] > .list-mindmap__content`);
    await content.locator(".p").first().dblclick();
    const nodeEditor = content.locator(".protyle-wysiwyg").first();
    await expect(nodeEditor).toBeVisible();
    return {content, itemID: itemID!, list, nodeEditor};
};

const createMindmapDocument = (createTestDocument: TestDocumentFactory, title: string, content: string) =>
    createTestDocument(title, ["Before mind map", "", "- Lead text", "",
        ...content.split("\n").map(line => `  ${line}`), "", "  Tail text", "",
        '{: custom-sy-list-mindmap="1"}', "", "After mind map"].join("\n"));

test("converts a list to a mind map and back without changing its block IDs or view configuration", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const {docID, editor} = await createTestDocument("Mind map list view conversion E2E",
        "Before\n\n- Alpha\n  - Child\n- Beta\n\nAfter");
    const list = editor.locator(':scope > [data-type="NodeList"]');
    const listID = await list.getAttribute("data-node-id");
    expect(listID).toBeTruthy();
    const original = findNode(await siyuanAPI.readDocument<ISyNode>(docID), listID!);
    expect(original?.Type).toBe("NodeList");
    const itemIDs = (original?.Children || []).map(item => item.ID);
    expect(itemIDs).toHaveLength(2);
    const originalStructure = blockStructure(original!);
    expect(originalStructure.length).toBeGreaterThan(3);

    await chooseListConversion(page, list, "listMindmap",
        list.locator(':scope > [data-type="NodeListItem"] .p').first());
    await expect(list).toHaveAttribute("custom-sy-list-mindmap", "1");
    const host = list.locator(":scope > .list-mindmap");
    await expect(host).toBeVisible();
    const root = host.locator(".list-mindmap__node--virtual > .list-mindmap__content");
    await root.dblclick();
    const title = "View configuration survives conversion";
    await root.locator("textarea").fill(title);
    await root.locator("textarea").press("Enter");
    await expect(root).toHaveText(title);
    await expect.poll(async () => {
        const attrs = await siyuanAPI.getBlockAttrs(listID!);
        return attrs["custom-sy-list-mindmap-data"] || "";
    }, {timeout: 15000}).toContain(title);
    const configured = (await siyuanAPI.getBlockAttrs(listID!))["custom-sy-list-mindmap-data"];
    expect(configured).toContain(title);

    await chooseListConversion(page, list, "list", host);
    await expect(list).not.toHaveAttribute("custom-sy-list-mindmap", "1");
    await expect(host).toHaveCount(0);
    await siyuanAPI.flushTransactions();
    const convertedList = findNode(await siyuanAPI.readDocument<ISyNode>(docID), listID!);
    expect(blockStructure(convertedList!)).toEqual(originalStructure);
    expect((await siyuanAPI.getBlockAttrs(listID!))["custom-sy-list-mindmap-data"]).toBe(configured);
    await chooseListConversion(page, list, "listMindmap",
        list.locator(':scope > [data-type="NodeListItem"] .p').first());
    await expect(host.locator(".list-mindmap__node--virtual > .list-mindmap__content")).toHaveText(title);

    await siyuanAPI.flushTransactions();
    const persisted = findNode(await siyuanAPI.readDocument<ISyNode>(docID), listID!);
    expect(persisted?.Type).toBe("NodeList");
    expect(blockStructure(persisted!)).toEqual(originalStructure);
    await assertValidListDOM(editor);
    await assertValidSyListTree(siyuanAPI, docID, editor);
    await page.reload();
    const reloaded = await getDocumentEditor(page, docID);
    await expect(reloaded.locator(`[data-node-id="${listID}"] > .list-mindmap`)).toBeVisible();
    await expect(reloaded.locator(`[data-node-id="${listID}"] .list-mindmap__node--virtual > .list-mindmap__content`))
        .toHaveText(title);
    const reloadedList = findNode(await siyuanAPI.readDocument<ISyNode>(docID), listID!);
    expect(blockStructure(reloadedList!)).toEqual(originalStructure);
    await assertValidListDOM(reloaded);
    await assertValidSyListTree(siyuanAPI, docID, reloaded);
});

test("edits and undoes a database rich text cell inside a mind map node", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const {docID, editor} = await createTestDocument("Mind map database rich text E2E",
        "Before mind map\n\n- Lead text\n\n  Database placeholder\n\nAfter mind map");
    const list = editor.locator(':scope > [data-type="NodeList"]');
    const placeholder = list.locator(':scope > [data-type="NodeListItem"] > [data-type="NodeParagraph"]').last();
    await focusAtEnd(placeholder.locator('[contenteditable="true"]').first());
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("/database", {delay: 10});
    const protyle = editor.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle ')][1]");
    const databaseOption = protyle.locator('.protyle-hint:not(.fn__none) button[data-id="database"]').first();
    await expect(databaseOption).toBeVisible({timeout: 15000});
    await databaseOption.click();
    await expect(list.locator(':scope > [data-type="NodeListItem"] > [data-type="NodeAttributeView"]')).toBeVisible();
    await chooseListConversion(page, list, "listMindmap",
        list.locator(':scope > [data-type="NodeListItem"] .p').first());
    const {nodeEditor} = await openMindmapNodeEditor(editor);
    const database = nodeEditor.locator('[data-type="NodeAttributeView"]');
    const avID = await database.getAttribute("data-av-id");
    const blockID = await database.getAttribute("data-node-id");
    expect(avID && blockID).toBeTruthy();
    const render = () => siyuanAPI.post<IRenderedAttributeView>("/api/av/renderAttributeView", {id: avID!, blockID: blockID!});

    await database.locator('[data-type="av-add-bottom"]').click();
    await expect.poll(async () => (await render()).view.rowCount, {timeout: 15000}).toBe(1);
    const rowID = (await render()).view.rows[0].id;
    const existingColumns = new Set((await render()).view.columns.map(column => column.id));
    await database.locator('[data-type="av-header-add"]').click();
    await page.locator('#commonMenu .b3-menu__item[data-id="text"]').click();
    let textColumnID = "";
    await expect.poll(async () => {
        textColumnID = (await render()).view.columns.find(column =>
            column.type === "text" && !existingColumns.has(column.id))?.id || "";
        return textColumnID;
    }, {timeout: 15000}).not.toBe("");
    await page.locator('.av__panel [data-type="close"]').first().click({position: {x: 10, y: 10}});
    await expect(nodeEditor).toBeVisible();

    const cell = database.locator(`.av__row[data-id="${rowID}"] .av__cell[data-col-id="${textColumnID}"]`);
    await cell.click();
    const richText = page.locator(".av__richtext-mask");
    await expect(richText).toBeVisible();
    await expect(nodeEditor).toBeVisible();
    await richText.locator('.protyle-wysiwyg [contenteditable="true"]').first().click();
    const value = "Mind map database cell";
    await page.keyboard.insertText(value);
    await page.keyboard.press("Escape");
    await expect(richText).toHaveCount(0);
    await expect(nodeEditor).toBeVisible();
    const storedValue = async () => (await render()).view.rows[0].cells.find(item =>
        item.value.keyID === textColumnID)?.value.text?.content || "";
    await expect.poll(storedValue, {timeout: 15000}).toContain(value);

    const title = database.locator(".av__title");
    await focusAtEnd(title);
    await page.keyboard.press(UNDO_SHORTCUT);
    await expect.poll(storedValue, {timeout: 15000}).not.toContain(value);
    await focusAtEnd(title);
    await page.keyboard.press(REDO_SHORTCUT);
    await expect.poll(storedValue, {timeout: 15000}).toContain(value);

    await nodeEditor.locator(':scope > .p [contenteditable="true"]').first().click();
    await page.keyboard.press("Escape");
    await expect(nodeEditor).toHaveCount(0);
    await siyuanAPI.flushTransactions();
    await assertValidListDOM(editor);
    await assertValidSyListTree(siyuanAPI, docID, editor);
    await page.reload();
    const reloaded = await getDocumentEditor(page, docID);
    expect(await storedValue()).toContain(value);
    await assertValidListDOM(reloaded);
    await assertValidSyListTree(siyuanAPI, docID, reloaded);
    const reopened = await openMindmapNodeEditor(reloaded);
    await expect(reopened.nodeEditor.locator(`[data-type="NodeAttributeView"] .av__cell[data-col-id="${textColumnID}"]`)
        .filter({hasText: value})).toHaveCount(1);
});

test("edits an embedded source block through the outer document transaction", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const source = await createTestDocument("Mind map embedded source E2E", "Independent source");
    const sourceID = await source.editor.locator(':scope > [data-type="NodeParagraph"]').first().getAttribute("data-node-id");
    expect(sourceID).toBeTruthy();
    await expect.poll(async () => (await siyuanAPI.querySQL(`SELECT id FROM blocks WHERE id = '${sourceID}'`)).length,
        {timeout: 30000}).toBe(1);
    const {docID, editor} = await createMindmapDocument(createTestDocument,
        "Mind map embedded edit E2E", `{{select * from blocks where id = '${sourceID}'}}`);
    const {nodeEditor} = await openMindmapNodeEditor(editor);
    const embedded = nodeEditor.locator(`.protyle-wysiwyg__embed [data-node-id="${sourceID}"] [contenteditable="true"]`).first();
    await expect(embedded).toBeVisible();
    await focusAtEnd(embedded);
    await page.keyboard.insertText(" edited");
    await nodeEditor.locator(':scope > .p [contenteditable="true"]').first().click();
    const sourceText = async () => {
        const block = findNode(await siyuanAPI.readDocument<ISyNode>(source.docID), sourceID!);
        return block ? nodeText(block) : "";
    };
    await expect.poll(sourceText, {timeout: 15000}).toBe("Independent source edited");

    await focusAtEnd(embedded);
    await page.keyboard.press(UNDO_SHORTCUT);
    await expect.poll(sourceText, {timeout: 15000}).toBe("Independent source");
    await focusAtEnd(embedded);
    await page.keyboard.press(REDO_SHORTCUT);
    await expect.poll(sourceText, {timeout: 15000}).toBe("Independent source edited");

    await nodeEditor.locator(':scope > .p [contenteditable="true"]').first().click();
    await page.keyboard.press("Escape");
    await expect(nodeEditor).toHaveCount(0);
    await siyuanAPI.flushTransactions();
    await assertValidListDOM(editor);
    await assertValidSyListTree(siyuanAPI, docID, editor);
    await page.reload();
    const reloaded = await getDocumentEditor(page, docID);
    await expect.poll(sourceText, {timeout: 15000}).toBe("Independent source edited");
    await assertValidListDOM(reloaded);
    await assertValidSyListTree(siyuanAPI, docID, reloaded);
    const reopened = await openMindmapNodeEditor(reloaded);
    await expect(reopened.nodeEditor.locator(
        `.protyle-wysiwyg__embed [data-node-id="${sourceID}"] [contenteditable="true"]`).first())
        .toContainText("Independent source edited");
});

test("persists and undoes a block split inside an embedded mind map source", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const source = await createTestDocument("Mind map embedded structure source E2E", "> Embedded source text");
    const sourceID = await source.editor.locator(':scope > [data-type="NodeBlockquote"]').getAttribute("data-node-id");
    expect(sourceID).toBeTruthy();
    const sourceChildren = async () => {
        const block = findNode(await siyuanAPI.readDocument<ISyNode>(source.docID), sourceID!);
        return (block?.Children || []).filter(child => child.ID).map(child => ({id: child.ID!, text: nodeText(child)}));
    };
    const original = await sourceChildren();
    expect(original).toHaveLength(1);
    const {docID, editor} = await createMindmapDocument(createTestDocument,
        "Mind map embedded structure E2E", `{{select * from blocks where id = '${sourceID}'}}`);
    const {nodeEditor} = await openMindmapNodeEditor(editor);
    const result = nodeEditor.locator(`.protyle-wysiwyg__embed[data-id="${sourceID}"]`);
    await expect(result).toHaveAttribute("data-allow-child-operation", "true");
    const originalParagraph = result.locator(`[data-node-id="${original[0].id}"] [contenteditable="true"]`).first();
    await focusAtEnd(originalParagraph);
    await page.keyboard.press("Enter");
    await expect.poll(sourceChildren, {timeout: 15000}).toHaveLength(2);
    const split = await sourceChildren();
    expect(split[0]).toEqual(original[0]);
    expect(split[1].id).toBeTruthy();
    await expect(result.locator(`[data-node-id="${split[1].id}"]`)).toBeVisible();

    await focusAtEnd(originalParagraph);
    await page.keyboard.press(UNDO_SHORTCUT);
    await expect.poll(sourceChildren, {timeout: 15000}).toEqual(original);
    await focusAtEnd(originalParagraph);
    await page.keyboard.press(REDO_SHORTCUT);
    await expect.poll(sourceChildren, {timeout: 15000}).toEqual(split);

    await siyuanAPI.flushTransactions();
    await page.reload();
    const reloaded = await getDocumentEditor(page, docID);
    await expect.poll(sourceChildren, {timeout: 15000}).toEqual(split);
    await assertValidListDOM(reloaded);
    await assertValidSyListTree(siyuanAPI, docID, reloaded);
    const reopened = await openMindmapNodeEditor(reloaded);
    await expect(reopened.nodeEditor.locator(
        `.protyle-wysiwyg__embed[data-id="${sourceID}"] [data-node-id="${split[1].id}"]`)).toBeVisible();
});
