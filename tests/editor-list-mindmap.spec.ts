import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {assertValidListDOM, assertValidSyListTree} from "./helpers/listAssertions";
import {getDocumentEditor, TestDocumentFactory} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface ISyNode {
    ID?: string;
    Type: string;
    Data?: string;
    Properties?: Record<string, string>;
    Children?: ISyNode[];
}

const setupMindmap = async (createTestDocument: TestDocumentFactory) => {
    const document = await createTestDocument("List mind map interaction E2E", [
        "Before mind map", "", "- Alpha", "- Beta",
        '{: custom-sy-list-mindmap="1"}', "", "After mind map",
    ].join("\n"));
    const list = document.editor.locator(':scope > [data-type="NodeList"]');
    await expect(list).toHaveAttribute("custom-sy-list-mindmap", "1");
    const host = list.locator(":scope > .list-mindmap");
    await expect(host).toBeVisible();
    await expect(host.locator("[data-mindmap-id]")).toHaveCount(3);
    const listID = await list.getAttribute("data-node-id");
    expect(listID).toBeTruthy();
    const itemIDs = await list.locator(':scope > [data-type="NodeListItem"]').evaluateAll(elements =>
        elements.map(element => element.getAttribute("data-node-id")!));
    return {...document, list, host, listID: listID!, itemIDs};
};

const expectSelected = async (editor: Locator, ids: string[]) => {
    await expect.poll(() => editor.locator(".protyle-wysiwyg--select").evaluateAll(elements =>
        elements.map(element => element.getAttribute("data-node-id")))).toEqual(ids);
};

const sideSelection = async (page: Page, editor: Locator, host: Locator,
                             side: "left" | "right", direction: "up" | "down") => {
    await host.scrollIntoViewIfNeeded();
    const rect = await host.boundingBox();
    expect(rect).toBeTruthy();
    const bounds = await editor.boundingBox();
    expect(bounds).toBeTruthy();
    const start = {
        x: side === "left" ? rect!.x - 20 : rect!.x + rect!.width + 20,
        y: rect!.y + rect!.height / 2,
    };
    expect(start.x).toBeGreaterThan(bounds!.x);
    expect(start.x).toBeLessThan(bounds!.x + bounds!.width);
    const inside = {
        x: side === "left" ? rect!.x + 20 : rect!.x + rect!.width - 20,
        y: start.y + (direction === "down" ? 40 : -40),
    };
    // 确认终点确实命中脑图画布，不能由停留在外层空白处的移动掩盖事件拦截问题。
    expect(await host.evaluate((element, point) =>
        element.contains(document.elementFromPoint(point.x, point.y)), inside)).toBe(true);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(inside.x, inside.y, {steps: 8});
    return inside;
};

const nodeText = (node: ISyNode): string => (node.Data || "") + (node.Children || []).map(nodeText).join("");

const persistedList = async (api: SiyuanAPI, docID: string, listID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    return document.Children?.find(node => node.ID === listID);
};

for (const side of ["left", "right"] as const) {
    for (const direction of ["up", "down"] as const) {
        test(`selects the mind map from the ${side} margin ${direction} and shrinks across adjacent blocks`, async ({
            page, createTestDocument, siyuanAPI,
        }) => {
            const {editor, host, listID, docID} = await setupMindmap(createTestDocument);
            const adjacent = editor.locator(':scope > [data-type="NodeParagraph"]').nth(direction === "up" ? 0 : 1);
            const adjacentID = await adjacent.getAttribute("data-node-id");
            const inside = await sideSelection(page, editor, host, side, direction);
            try {
                await expectSelected(editor, [listID]);
                const rect = await adjacent.boundingBox();
                expect(rect).toBeTruthy();
                await page.mouse.move(inside.x, rect!.y + rect!.height / 2, {steps: 8});
                await expectSelected(editor, direction === "up" ? [adjacentID!, listID] : [listID, adjacentID!]);
                await page.mouse.move(inside.x, inside.y, {steps: 8});
                await expectSelected(editor, [listID]);
            } finally {
                await page.mouse.up();
            }
            await expect(editor).not.toHaveClass(/fn__pointer-none|protyle-wysiwyg--hiderange/);
            const rect = await adjacent.boundingBox();
            await page.mouse.move(inside.x, rect!.y + rect!.height / 2, {steps: 8});
            await expectSelected(editor, [listID]);
            await assertValidListDOM(editor);
            await assertValidSyListTree(siyuanAPI, docID, editor);
        });
    }
}

for (const target of ["canvas", "node"] as const) {
    test(`clicking the mind map ${target} clears a multi-block selection`, async ({page, createTestDocument}) => {
        const {editor, host, listID, itemIDs} = await setupMindmap(createTestDocument);
        const inside = await sideSelection(page, editor, host, "left", "down");
        const after = editor.locator(':scope > [data-type="NodeParagraph"]').last();
        try {
            const rect = await after.boundingBox();
            await page.mouse.move(inside.x, rect!.y + rect!.height / 2, {steps: 8});
            await expectSelected(editor, [listID, (await after.getAttribute("data-node-id"))!]);
        } finally {
            await page.mouse.up();
        }
        if (target === "canvas") {
            await page.mouse.click(inside.x, inside.y);
        } else {
            await host.locator(`[data-mindmap-id="${itemIDs[0]}"] .list-mindmap__content`).click();
        }
        await expectSelected(editor, []);
        await expect(editor.locator(".protyle-wysiwyg--select-mode, [select-start], [select-end]")).toHaveCount(0);
        if (target === "node") {
            await expect(host.locator(`[data-mindmap-id="${itemIDs[0]}"]`)).toHaveClass(/list-mindmap__node--selected/);
        }
    });
}

test("editing a new empty node hides the placeholder and preserves its text after reload", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const {editor, host, list, listID, itemIDs, docID} = await setupMindmap(createTestDocument);
    await host.locator(`[data-mindmap-id="${itemIDs[0]}"] .list-mindmap__content`).click();
    await page.keyboard.press("Enter");
    const content = host.locator(".list-mindmap__node--editing > .list-mindmap__content");
    await expect(content).toBeVisible();
    const editable = content.locator('.protyle-wysiwyg [contenteditable="true"]').first();
    // contenteditable 的焦点属于编辑宿主，正文内的光标位置由浏览器选区表示。
    await expect.poll(() => editable.evaluate(element => {
        const selection = getSelection();
        return !!selection?.isCollapsed && element.contains(selection.anchorNode) &&
            element.contains(selection.focusNode);
    })).toBe(true);
    expect(await content.evaluate(element => element.contains(document.activeElement))).toBe(true);
    expect(await content.evaluate(element => getComputedStyle(element, "::before").content)).toBe("none");
    await expect(content.locator("[placeholder]:not([placeholder=''])")).toHaveCount(0);
    const newID = await content.locator("..").getAttribute("data-mindmap-id");
    expect(newID).toBeTruthy();
    const text = "A complete new mind map node";
    await page.keyboard.insertText(text);
    await expect(editable).toHaveText(text);
    await page.keyboard.press("Escape");
    await expect(host.locator(".list-mindmap__node--editing")).toHaveCount(0);
    await expect(host.locator(`[data-mindmap-id="${newID}"] .list-mindmap__content`)).toHaveText(text);
    await expect.poll(async () => (await persistedList(siyuanAPI, docID, listID))?.Children?.map(node => ({
        id: node.ID, text: nodeText(node),
    })), {timeout: 30000}).toEqual([
        {id: itemIDs[0], text: "Alpha"}, {id: newID, text}, {id: itemIDs[1], text: "Beta"},
    ]);
    await expect(list.locator(':scope > [data-type="NodeListItem"]')).toHaveCount(3);
    await assertValidListDOM(editor);
    await assertValidSyListTree(siyuanAPI, docID, editor);
    await page.reload();
    const reloaded = await getDocumentEditor(page, docID);
    await expect(reloaded.locator(`[data-mindmap-id="${newID}"] .list-mindmap__content`)).toHaveText(text);
    await assertValidListDOM(reloaded);
    await assertValidSyListTree(siyuanAPI, docID, reloaded);
});

test("the unnamed root is 32 by 32 and edits its title without a placeholder", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const {host, listID, docID} = await setupMindmap(createTestDocument);
    const root = host.locator(".list-mindmap__node--virtual");
    await expect(root).toHaveCSS("width", "32px");
    await expect(root).toHaveCSS("height", "32px");
    await root.locator(".list-mindmap__content").dblclick();
    const input = root.locator("textarea");
    await expect(input).toBeFocused();
    await expect(input).not.toHaveAttribute("placeholder");
    const title = "Mind map title";
    await page.keyboard.insertText(title);
    await expect(input).toHaveValue(title);
    await page.keyboard.press("Enter");
    await expect(root.locator("textarea")).toHaveCount(0);
    await expect(root.locator(".list-mindmap__content")).toHaveText(title);
    await expect.poll(async () => {
        const data = (await persistedList(siyuanAPI, docID, listID))?.Properties?.["custom-sy-list-mindmap-data"];
        // .sy 的属性值保留 HTML 实体转义，先按属性的存储形式解码再校验元数据。
        return data ? page.evaluate(value => {
            const decoder = document.createElement("textarea");
            decoder.innerHTML = value;
            return JSON.parse(decoder.value).rootTitle;
        }, data) : undefined;
    }, {timeout: 30000}).toBe(title);
    await page.reload();
    const reloaded = await getDocumentEditor(page, docID);
    await expect(reloaded.locator(".list-mindmap__node--virtual > .list-mindmap__content")).toHaveText(title);
});
