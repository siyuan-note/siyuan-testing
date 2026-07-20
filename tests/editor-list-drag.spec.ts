import {ElementHandle, expect, JSHandle, Locator, Page, test} from "@playwright/test";
import {assertValidListDOM, assertValidSyListTree} from "./helpers/listAssertions";
import {createTestDocument} from "./helpers/testNotebook";

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

const startContentBlockDrag = async (page: Page, source: Locator) => {
    const id = await source.getAttribute("data-node-id");
    await page.mouse.move(0, 0);
    await source.hover();
    const handle = page.locator(`.protyle-gutters button[data-node-id="${id}"] > span[draggable="true"]`);
    await expect(handle).toBeVisible();
    const endTarget = await handle.locator("xpath=../..").elementHandle() as ElementHandle<HTMLElement>;
    expect(endTarget).toBeTruthy();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer()) as JSHandle<DataTransfer>;
    await handle.dispatchEvent("dragstart", {dataTransfer});
    await expect.poll(() => dataTransfer.evaluate(transfer => Array.from(transfer.types).join(",")))
        .toContain("nodeparagraph");
    return {dataTransfer, endTarget} as IDragSession;
};

const startListItemDrag = async (page: Page, source: Locator) => {
    const action = source.locator(":scope > .protyle-action").first();
    await expect(action).toBeVisible();
    const endTarget = await source.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), " +
        "' protyle-wysiwyg ')][1]").elementHandle() as ElementHandle<HTMLElement>;
    expect(endTarget).toBeTruthy();
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
    const clientX = child ? contentBox.x + 40 : contentBox.x + 4;
    const clientY = position === "top" ? contentBox.y + 2 : contentBox.y + contentBox.height - 2;
    await content.dispatchEvent("dragover", {dataTransfer: session.dataTransfer, clientX, clientY});
    const className = `dragover__${position}--${child ? "child" : "sibling"}`;
    await expect(target).toHaveClass(new RegExp(`(^|\\s)${className}(\\s|$)`));
    return content;
};

test.describe("content block dragging around list items", () => {
    test.describe.configure({mode: "parallel"});

    test("rejects a content block as a direct child of NodeList", async ({page}) => {
        const {docID, editor} = await createTestDocument(page, "List Content Gap E2E", "X\n\n* A\n* B\n* C");
        const source = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "X"}).first();
        const list = editor.locator(':scope > [data-type="NodeList"]');
        const firstItem = list.locator(':scope > [data-type="NodeListItem"]').first();

        await dropWithClass(await startContentBlockDrag(page, source), firstItem, "dragover__bottom--sibling");

        await expect(source).toHaveCount(1);
        await expect.poll(() => source.evaluate(element => element.parentElement?.classList.contains("protyle-wysiwyg")))
            .toBeTruthy();
        await assertValidListDOM(editor);
        await assertValidSyListTree(page, docID);
    });

    test("inserts content blocks at an exact position inside a list item", async ({page}) => {
        const {docID, editor} = await createTestDocument(page, "List Content Position E2E", "X\n\nY\n\n* A\n* B\n* C");
        const sourceX = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "X"}).first();
        const sourceY = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "Y"}).first();
        const firstItem = editor.locator(':scope > [data-type="NodeList"] > [data-type="NodeListItem"]').first();
        const firstParagraph = firstItem.locator(':scope > [data-type="NodeParagraph"]').first();

        await dropWithClass(await startContentBlockDrag(page, sourceX), firstParagraph, "dragover__bottom");
        await dropWithClass(await startContentBlockDrag(page, sourceY), firstParagraph, "dragover__bottom");

        await expect.poll(() => getDirectContentTexts(firstItem)).toEqual(["A", "Y", "X"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(page, docID);

        await page.reload();
        const reloadedEditor = page.locator(".protyle-wysiwyg").last();
        const reloadedFirstItem = reloadedEditor.locator(':scope > [data-type="NodeList"] > [data-type="NodeListItem"]').first();
        await expect.poll(() => getDirectContentTexts(reloadedFirstItem)).toEqual(["A", "Y", "X"]);
        await assertValidListDOM(reloadedEditor);
    });

    test("places a content block before a nested list instead of beside its items", async ({page}) => {
        const {docID, editor} = await createTestDocument(page, "Nested List Gap E2E", "X\n\n* Parent\n  * Child");
        const source = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "X"}).first();
        const parentItem = editor.locator('[data-type="NodeListItem"]').filter({hasText: "Parent"}).first();
        const childItem = parentItem.locator(':scope > [data-type="NodeList"] > [data-type="NodeListItem"]').first();

        await dropWithClass(await startContentBlockDrag(page, source), childItem, "dragover__top--sibling");

        await expect.poll(() => getDirectContentTexts(parentItem)).toEqual(["Parent", "X"]);
        await expect.poll(() => getDirectListItemTexts(parentItem.locator(':scope > [data-type="NodeList"]')))
            .toEqual(["Child"]);
        await assertValidListDOM(editor);
        await assertValidSyListTree(page, docID);
    });
});

test.describe("list item dragging", () => {
    test.describe.configure({mode: "parallel"});

    test("moves an item above the first item of another list with a precise tip", async ({page}) => {
        const markdown = "* A\n* B\n\nseparator\n\n* D\n* E";
        const {docID, editor} = await createTestDocument(page, "List Item Before E2E", markdown);
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
        await assertValidSyListTree(page, docID);
    });

    test("nests an item under another item when dropped in the child zone", async ({page}) => {
        const markdown = "* A\n* B\n\nseparator\n\n* D";
        const {docID, editor} = await createTestDocument(page, "List Item Child E2E", markdown);
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
        await assertValidSyListTree(page, docID);
    });
});
