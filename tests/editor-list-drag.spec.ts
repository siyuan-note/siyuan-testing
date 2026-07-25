import {ElementHandle, JSHandle, Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {assertValidListDOM, assertValidSyListTree} from "./helpers/listAssertions";
import {getDocumentEditor} from "./helpers/testNotebook";

interface IDragSession {
    dataTransfer: JSHandle<DataTransfer>;
    endTarget: ElementHandle<HTMLElement>;
}

const getDirectListItemTexts = (list: Locator) => list.evaluate((element) =>
    Array.from(element.children)
        .filter(item => item.getAttribute("data-type") === "NodeListItem")
        .map(item => item.querySelector(":scope > [data-type=\"NodeParagraph\"] [contenteditable=\"true\"]")
            ?.textContent?.trim()));

const getDirectContentTexts = (listItem: Locator) => listItem.evaluate((element) =>
    Array.from(element.children)
        .filter(item => item.hasAttribute("data-node-id") && item.getAttribute("data-type") !== "NodeList")
        .map(item => item.querySelector("[contenteditable=\"true\"]")?.textContent?.trim()));

const startGutterBlockDrag = async (page: Page, source: Locator, expectedType: string) => {
    const id = await source.getAttribute("data-node-id");
    await page.mouse.move(0, 0);
    await source.hover();
    const handle = page.locator(`.protyle-gutters button[data-node-id="${id}"] > span[draggable="true"]`);
    await expect(handle).toBeVisible();
    const endTarget = await handle.locator("xpath=../..").elementHandle() as ElementHandle<HTMLElement>;
    expect(endTarget).not.toBeNull();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer()) as JSHandle<DataTransfer>;
    await handle.dispatchEvent("dragstart", {dataTransfer});
    await expect.poll(() => dataTransfer.evaluate(transfer => Array.from(transfer.types).join(",")))
        .toContain(expectedType);
    return {dataTransfer, endTarget} as IDragSession;
};

const startContentBlockDrag = (page: Page, source: Locator) => startGutterBlockDrag(page, source, "nodeparagraph");

const startListItemDrag = async (page: Page, source: Locator) => {
    const action = source.locator(":scope > .protyle-action").first();
    await expect(action).toBeVisible();
    const endTarget = await source.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), " +
        "' protyle-wysiwyg ')][1]").elementHandle() as ElementHandle<HTMLElement>;
    expect(endTarget).not.toBeNull();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer()) as JSHandle<DataTransfer>;
    await action.dispatchEvent("dragstart", {dataTransfer});
    await expect.poll(() => dataTransfer.evaluate(transfer => Array.from(transfer.types).join(",")))
        .toContain("nodelistitem");
    return {dataTransfer, endTarget} as IDragSession;
};

const finishDrag = async (session: IDragSession) => {
    await session.endTarget.dispatchEvent("dragend", {dataTransfer: session.dataTransfer});
    await session.dataTransfer.dispose();
};

const dropWithClass = async (session: IDragSession, target: Locator, className: string) => {
    await target.evaluate((element, targetClass) => element.classList.add(targetClass), className);
    await target.dispatchEvent("drop", {dataTransfer: session.dataTransfer});
    await finishDrag(session);
};

const dragOverListItem = async (session: IDragSession, target: Locator, position: "top" | "bottom", child = false) => {
    const content = target.locator(":scope > [data-node-id]").first();
    const itemBox = await target.boundingBox();
    const contentBox = await content.boundingBox();
    if (!itemBox || !contentBox) {
        throw new Error("list item is not visible");
    }
    const clientX = child ? contentBox.x + 40 : itemBox.x + 4;
    const clientY = position === "top" ? contentBox.y + 2 : contentBox.y + contentBox.height - 2;
    await content.dispatchEvent("dragover", {dataTransfer: session.dataTransfer, clientX, clientY});
    const className = `dragover__${position}--${child ? "child" : "sibling"}`;
    await expect(target).toHaveClass(new RegExp(`(^|\\s)${className}(\\s|$)`));
    return content;
};

const dragOverWithoutListTarget = async (session: IDragSession, eventTarget: Locator, pointTarget: Locator,
                                         position: "top" | "bottom") => {
    const box = await pointTarget.boundingBox();
    const listItemBox = await pointTarget.locator("xpath=ancestor-or-self::*[@data-type='NodeListItem'][1]")
        .boundingBox();
    if (!box) {
        throw new Error("drop target is not visible");
    }
    await eventTarget.page().evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() =>
        requestAnimationFrame(() => resolve()))));
    const initialTip = await eventTarget.page().locator(".drag-tip__action").textContent().catch(() => null);
    const clientX = (listItemBox || box).x + 4;
    const clientY = position === "top" ? box.y + 2 : box.y + box.height - 2;
    await eventTarget.dispatchEvent("dragover", {dataTransfer: session.dataTransfer, clientX, clientY});
    const state = await eventTarget.page().evaluate(() => ({
        indicators: Array.from(document.querySelectorAll('[class*="dragover__"]'))
            .map(element => ({type: element.getAttribute("data-type"), className: element.className})),
        tip: document.querySelector(".drag-tip__action")?.textContent || null,
    }));
    const moveTip = await eventTarget.page().evaluate(() => window.siyuan.languages.move);
    expect(state.indicators).toEqual([]);
    expect([initialTip, moveTip]).toContain(state.tip);
};

test.describe("content block dragging around list items", () => {
    test.describe.configure({mode: "parallel"});

    test("rejects a content block as a direct child of NodeList", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("List Content Gap E2E", "X\n\n* A\n* B\n* C");
        const source = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "X"}).first();
        const list = editor.locator(':scope > [data-type="NodeList"]');
        const firstItem = list.locator(':scope > [data-type="NodeListItem"]').first();

        await dropWithClass(await startContentBlockDrag(page, source), firstItem, "dragover__bottom--sibling");

        await expect(source).toHaveCount(1);
        await expect.poll(() => source.evaluate(element => element.parentElement?.classList.contains("protyle-wysiwyg")))
            .toBe(true);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    test("does not offer an invalid sibling drop between list items", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("List Content Real Gap E2E", "X\n\n* A\n* B\n* C");
        const source = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "X"}).first();
        const list = editor.locator(':scope > [data-type="NodeList"]');
        const secondItemContent = list.locator(':scope > [data-type="NodeListItem"]').nth(1)
            .locator(':scope > [data-node-id]').first();
        const session = await startContentBlockDrag(page, source);

        await dragOverWithoutListTarget(session, list, secondItemContent, "top");
        await list.dispatchEvent("drop", {dataTransfer: session.dataTransfer});
        await finishDrag(session);

        await expect.poll(() => getDirectListItemTexts(list)).toEqual(["A", "B", "C"]);
        await expect.poll(() => source.evaluate(element => element.parentElement?.classList.contains("protyle-wysiwyg")))
            .toBe(true);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    test("inserts content blocks at an exact position inside a list item", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("List Content Position E2E", "X\n\nY\n\n* A\n* B\n* C");
        const sourceX = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "X"}).first();
        const sourceY = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "Y"}).first();
        const firstItem = editor.locator(':scope > [data-type="NodeList"] > [data-type="NodeListItem"]').first();
        const firstParagraph = firstItem.locator(':scope > [data-type="NodeParagraph"]').first();

        await dropWithClass(await startContentBlockDrag(page, sourceX), firstParagraph, "dragover__bottom");
        await dropWithClass(await startContentBlockDrag(page, sourceY), firstParagraph, "dragover__bottom");

        await expect.poll(() => getDirectContentTexts(firstItem)).toEqual(["A", "Y", "X"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        const reloadedFirstItem = reloadedEditor.locator(':scope > [data-type="NodeList"] > [data-type="NodeListItem"]').first();
        await expect.poll(() => getDirectContentTexts(reloadedFirstItem)).toEqual(["A", "Y", "X"]);
        await assertValidListDOM(reloadedEditor);
    });

    test("places a content block before a nested list instead of beside its items", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("Nested List Gap E2E", "X\n\n* Parent\n  * Child");
        const source = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "X"}).first();
        const parentItem = editor.locator('[data-type="NodeListItem"]').filter({hasText: "Parent"}).first();
        const childItem = parentItem.locator(':scope > [data-type="NodeList"] > [data-type="NodeListItem"]').first();

        await dropWithClass(await startContentBlockDrag(page, source), childItem, "dragover__top--sibling");

        await expect.poll(() => getDirectContentTexts(parentItem)).toEqual(["Parent", "X"]);
        await expect.poll(() => getDirectListItemTexts(parentItem.locator(':scope > [data-type="NodeList"]')))
            .toEqual(["Child"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });
});

test.describe("list item dragging", () => {
    test.describe.configure({mode: "parallel"});

    test("moves an item above the first item of another list with a precise tip", async ({page, createTestDocument, siyuanAPI}) => {
        const markdown = "* A\n* B\n\nseparator\n\n* D\n* E";
        const {docID, editor} = await createTestDocument("List Item Before E2E", markdown);
        const lists = editor.locator(':scope > [data-type="NodeList"]');
        const targetList = lists.nth(0);
        const sourceList = lists.nth(1);
        const target = targetList.locator(':scope > [data-type="NodeListItem"]').first();
        const source = sourceList.locator(':scope > [data-type="NodeListItem"]').first();
        const session = await startListItemDrag(page, source);
        const dropTarget = await dragOverListItem(session, target, "top");
        const expectedTip = await page.evaluate(() => window.siyuan.languages.dragTipListItemBefore.replace("${x}", "A"));
        await expect(page.locator(".drag-tip__action")).toHaveText(expectedTip);

        await dropTarget.dispatchEvent("drop", {dataTransfer: session.dataTransfer});
        await finishDrag(session);

        await expect.poll(() => getDirectListItemTexts(targetList)).toEqual(["D", "A", "B"]);
        await expect.poll(() => getDirectListItemTexts(sourceList)).toEqual(["E"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    test("moves an item below another item with a precise tip", async ({page, createTestDocument, siyuanAPI}) => {
        const markdown = "* A\n* B\n\nseparator\n\n* D\n* E";
        const {docID, editor} = await createTestDocument("List Item After E2E", markdown);
        const lists = editor.locator(':scope > [data-type="NodeList"]');
        const targetList = lists.nth(0);
        const sourceList = lists.nth(1);
        const target = targetList.locator(':scope > [data-type="NodeListItem"]').first();
        const source = sourceList.locator(':scope > [data-type="NodeListItem"]').first();
        const session = await startListItemDrag(page, source);
        const dropTarget = await dragOverListItem(session, target, "bottom");
        const expectedTip = await page.evaluate(() => window.siyuan.languages.dragTipListItemAfter.replace("${x}", "A"));
        await expect(page.locator(".drag-tip__action")).toHaveText(expectedTip);

        await dropTarget.dispatchEvent("drop", {dataTransfer: session.dataTransfer});
        await finishDrag(session);

        await expect.poll(() => getDirectListItemTexts(targetList)).toEqual(["A", "D", "B"]);
        await expect.poll(() => getDirectListItemTexts(sourceList)).toEqual(["E"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    test("nests an item under another item when dropped in the child zone", async ({page, createTestDocument, siyuanAPI}) => {
        const markdown = "* A\n* B\n\nseparator\n\n* D";
        const {docID, editor} = await createTestDocument("List Item Child E2E", markdown);
        const lists = editor.locator(':scope > [data-type="NodeList"]');
        const targetList = lists.nth(0);
        const target = targetList.locator(':scope > [data-type="NodeListItem"]').first();
        const source = lists.nth(1).locator(':scope > [data-type="NodeListItem"]').first();
        const session = await startListItemDrag(page, source);
        const dropTarget = await dragOverListItem(session, target, "bottom", true);
        const expectedTip = await page.evaluate(() => window.siyuan.languages.dragTipListItemChild.replace("${x}", "A"));
        await expect(page.locator(".drag-tip__action")).toHaveText(expectedTip);

        await dropTarget.dispatchEvent("drop", {dataTransfer: session.dataTransfer});
        await finishDrag(session);

        await expect.poll(() => getDirectListItemTexts(targetList)).toEqual(["A", "B"]);
        await expect.poll(() => getDirectListItemTexts(target.locator(':scope > [data-type="NodeList"]')))
            .toEqual(["D"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    test("inserts items at both ends of an existing nested list", async ({page, createTestDocument, siyuanAPI}) => {
        const markdown = "* A\n  * B\n  * C\n\nseparator\n\n* D\n* E";
        const {docID, editor} = await createTestDocument("Existing Nested List E2E", markdown);
        const topLists = editor.locator(':scope > [data-type="NodeList"]');
        const parentItem = topLists.nth(0).locator(':scope > [data-type="NodeListItem"]').first();
        const nestedList = parentItem.locator(':scope > [data-type="NodeList"]');
        const sourceList = topLists.nth(1);

        const firstSession = await startListItemDrag(page,
            sourceList.locator(':scope > [data-type="NodeListItem"]').first());
        const firstDropTarget = await dragOverListItem(firstSession,
            nestedList.locator(':scope > [data-type="NodeListItem"]').first(), "top");
        await firstDropTarget.dispatchEvent("drop", {dataTransfer: firstSession.dataTransfer});
        await finishDrag(firstSession);

        const secondSession = await startListItemDrag(page,
            sourceList.locator(':scope > [data-type="NodeListItem"]').first());
        const secondDropTarget = await dragOverListItem(secondSession,
            nestedList.locator(':scope > [data-type="NodeListItem"]').filter({hasText: "C"}).first(), "bottom");
        await secondDropTarget.dispatchEvent("drop", {dataTransfer: secondSession.dataTransfer});
        await finishDrag(secondSession);

        await expect.poll(() => getDirectListItemTexts(nestedList)).toEqual(["D", "B", "C", "E"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    test("reorders items within the same list", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("Same List Reorder E2E", "* A\n* B\n* C");
        const list = editor.locator(':scope > [data-type="NodeList"]');
        const source = list.locator(':scope > [data-type="NodeListItem"]').filter({hasText: "C"}).first();
        const target = list.locator(':scope > [data-type="NodeListItem"]').filter({hasText: "A"}).first();
        const session = await startListItemDrag(page, source);
        const dropTarget = await dragOverListItem(session, target, "top");

        await dropTarget.dispatchEvent("drop", {dataTransfer: session.dataTransfer});
        await finishDrag(session);

        await expect.poll(() => getDirectListItemTexts(list)).toEqual(["C", "A", "B"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    test("does not move an item onto itself or its current adjacent position", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("List Item No-op E2E", "* A\n* B\n* C");
        const list = editor.locator(':scope > [data-type="NodeList"]');
        const source = list.locator(':scope > [data-type="NodeListItem"]').nth(1);
        const sourceContent = source.locator(':scope > [data-node-id]').first();

        const selfSession = await startListItemDrag(page, source);
        await dragOverWithoutListTarget(selfSession, sourceContent, sourceContent, "bottom");
        await finishDrag(selfSession);

        const adjacentSession = await startListItemDrag(page, source);
        const adjacentContent = list.locator(':scope > [data-type="NodeListItem"]').first()
            .locator(':scope > [data-node-id]').first();
        await dragOverWithoutListTarget(adjacentSession, adjacentContent, adjacentContent, "bottom");
        await finishDrag(adjacentSession);

        await expect.poll(() => getDirectListItemTexts(list)).toEqual(["A", "B", "C"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    test("does not move a parent item into its own descendant", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("List Descendant No-op E2E", "* A\n  * B\n* C");
        const list = editor.locator(':scope > [data-type="NodeList"]');
        const source = list.locator(':scope > [data-type="NodeListItem"]').first();
        const nestedList = source.locator(':scope > [data-type="NodeList"]');
        const descendantContent = nestedList.locator(':scope > [data-type="NodeListItem"]')
            .first().locator(':scope > [data-node-id]').first();
        const session = await startListItemDrag(page, source);

        await dragOverWithoutListTarget(session, descendantContent, descendantContent, "top");
        await finishDrag(session);

        await expect.poll(() => getDirectListItemTexts(list)).toEqual(["A", "C"]);
        await expect.poll(() => getDirectListItemTexts(nestedList)).toEqual(["B"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    test("restores and reapplies a cross-list move with undo and redo", async ({page, createTestDocument, siyuanAPI}) => {
        const markdown = "* A\n* B\n\nseparator\n\n* D\n* E";
        const {docID, editor} = await createTestDocument("List Move Undo E2E", markdown);
        const lists = editor.locator(':scope > [data-type="NodeList"]');
        const targetList = lists.nth(0);
        const sourceList = lists.nth(1);
        const target = targetList.locator(':scope > [data-type="NodeListItem"]').first();
        const source = sourceList.locator(':scope > [data-type="NodeListItem"]').first();
        const session = await startListItemDrag(page, source);
        const dropTarget = await dragOverListItem(session, target, "top");
        await dropTarget.dispatchEvent("drop", {dataTransfer: session.dataTransfer});
        await finishDrag(session);
        await expect.poll(() => getDirectListItemTexts(targetList)).toEqual(["D", "A", "B"]);
        await expect.poll(() => getDirectListItemTexts(sourceList)).toEqual(["E"]);
        await assertValidSyListTree(siyuanAPI, docID, editor);

        await page.keyboard.press(UNDO_SHORTCUT);
        await expect.poll(() => getDirectListItemTexts(targetList)).toEqual(["A", "B"]);
        await expect.poll(() => getDirectListItemTexts(sourceList)).toEqual(["D", "E"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);

        await page.keyboard.press(REDO_SHORTCUT);
        await expect.poll(() => getDirectListItemTexts(targetList)).toEqual(["D", "A", "B"]);
        await expect.poll(() => getDirectListItemTexts(sourceList)).toEqual(["E"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
    });

    [
        {
            name: "ordered",
            article: "an",
            markdown: "1. O1\n2. O2\n\nseparator\n\n* S",
            subtype: "o",
            expectedTexts: ["S", "O1", "O2"],
            expectedMarkers: ["1.", "2.", "3."],
        },
        {
            name: "task",
            article: "a",
            markdown: "* [ ] T1\n* [x] T2\n\nseparator\n\n* S",
            subtype: "t",
            expectedTexts: ["S", "T1", "T2"],
            expectedMarkers: ["*", "*", "*"],
        },
    ].forEach((listType) => {
        test(`converts an unordered item when moving it into ${listType.article} ${listType.name} list`, async ({page, createTestDocument, siyuanAPI}) => {
            const {docID, editor} = await createTestDocument(`List Type ${listType.name} E2E`, listType.markdown);
            const lists = editor.locator(':scope > [data-type="NodeList"]');
            const targetList = lists.nth(0);
            const sourceList = lists.nth(1);
            await expect(targetList).toHaveAttribute("data-subtype", listType.subtype);
            const target = targetList.locator(':scope > [data-type="NodeListItem"]').first();
            const source = sourceList.locator(':scope > [data-type="NodeListItem"]').first();
            const session = await startListItemDrag(page, source);
            const dropTarget = await dragOverListItem(session, target, "top");

            await dropTarget.dispatchEvent("drop", {dataTransfer: session.dataTransfer});
            await finishDrag(session);

            const targetItems = targetList.locator(':scope > [data-type="NodeListItem"]');
            await expect.poll(() => getDirectListItemTexts(targetList)).toEqual(listType.expectedTexts);
            await expect.poll(() => targetItems.evaluateAll(items => items.map(item => item.getAttribute("data-marker"))))
                .toEqual(listType.expectedMarkers);
            await expect(targetItems.first()).toHaveAttribute("data-subtype", listType.subtype);
            if (listType.subtype === "t") {
                await expect(targetItems.first()).toHaveAttribute("data-task", " ");
            }
            await assertValidListDOM(editor);
            await assertValidSyListTree(siyuanAPI, docID, editor);
        });
    });

});
