import {ElementHandle, expect, JSHandle, Locator, Page, test} from "@playwright/test";
import {createTestDocument} from "./helpers/testNotebook";

const createDocument = async (page: Page) => {
    const {editor} = await createTestDocument(page, "List Drag E2E", "X\n\nY\n\n* A\n* B\n* C");
    await expect(editor.locator(':scope > [data-type="NodeList"]')).toHaveCount(1);

    return editor;
};

const getDirectListItemTexts = (list: Locator) => list.evaluate((element) =>
    Array.from(element.children)
        .filter(item => item.getAttribute("data-type") === "NodeListItem")
        .map(item => item.querySelector(":scope > [data-type=\"NodeParagraph\"] [contenteditable=\"true\"]")
            ?.textContent?.trim()));

const getDirectContentTexts = (listItem: Locator) => listItem.evaluate((element) =>
    Array.from(element.children)
        .filter(item => item.hasAttribute("data-node-id") && item.getAttribute("data-type") !== "NodeList")
        .map(item => item.querySelector("[contenteditable=\"true\"]")?.textContent?.trim()));

const assertListStructure = async (list: Locator) => {
    await expect.poll(() => list.evaluate((element) =>
        Array.from(element.children)
            .filter(item => item.hasAttribute("data-node-id"))
            .map(item => item.getAttribute("data-type"))))
        .toEqual(["NodeListItem", "NodeListItem", "NodeListItem"]);
};

const startBlockDrag = async (page: Page, source: Locator) => {
    const id = await source.getAttribute("data-node-id");
    await page.mouse.move(0, 0);
    await source.hover();
    const handle = page.locator(`.protyle-gutters button[data-node-id="${id}"] > span[draggable="true"]`);
    await expect(handle).toBeVisible();
    const gutter = await handle.locator("xpath=../..").elementHandle() as ElementHandle<HTMLElement>;
    expect(gutter).toBeTruthy();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer()) as JSHandle<DataTransfer>;
    await handle.dispatchEvent("dragstart", {dataTransfer});
    await expect.poll(() => dataTransfer.evaluate(transfer => Array.from(transfer.types).join(",")))
        .toContain("nodeparagraph");
    return {dataTransfer, gutter};
};

const dropBlock = async (page: Page, source: Locator, target: Locator, className: string) => {
    const {dataTransfer, gutter} = await startBlockDrag(page, source);
    await target.evaluate((element, targetClass) => {
        element.closest(".protyle-wysiwyg")?.querySelectorAll("[class*=\"dragover__\"]").forEach(item => {
            Array.from(item.classList).forEach(name => {
                if (name.startsWith("dragover__")) {
                    item.classList.remove(name);
                }
            });
        });
        element.classList.add(targetClass);
    }, className);
    await target.dispatchEvent("drop", {dataTransfer});
    await gutter.dispatchEvent("dragend", {dataTransfer});
    await dataTransfer.dispose();
    await page.waitForTimeout(500);
};

test.describe("editor list block dragging", () => {
    test("keeps list structure valid and supports precise list-item content insertion", async ({page}) => {
        const editor = await createDocument(page);
        const sourceX = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "X"}).first();
        const sourceY = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "Y"}).first();
        const list = editor.locator(':scope > [data-type="NodeList"]').last();
        const listItems = list.locator(':scope > [data-type="NodeListItem"]');
        await expect(listItems).toHaveCount(3);
        await expect.poll(() => getDirectListItemTexts(list)).toEqual(["A", "B", "C"]);

        // 普通内容块不能作为列表项的同级插入，否则会形成 NodeList > NodeParagraph。
        await dropBlock(page, sourceX, listItems.nth(0), "dragover__bottom--sibling");
        await assertListStructure(list);
        await expect(sourceX).toHaveCount(1);
        await expect.poll(() => sourceX.evaluate(element =>
            element.parentElement?.classList.contains("protyle-wysiwyg")))
            .toBeTruthy();

        // 普通内容块可以插入列表项内部，并能相对于具体内容块精确排序。
        const firstListItem = listItems.nth(0);
        const firstParagraph = firstListItem.locator(':scope > [data-type="NodeParagraph"]').first();
        await dropBlock(page, sourceX, firstParagraph, "dragover__bottom");
        await expect.poll(() => getDirectContentTexts(firstListItem)).toEqual(["A", "X"]);
        await assertListStructure(list);

        await dropBlock(page, sourceY, firstParagraph, "dragover__bottom");
        await expect.poll(() => getDirectContentTexts(firstListItem)).toEqual(["A", "Y", "X"]);
        await assertListStructure(list);
    });
});
