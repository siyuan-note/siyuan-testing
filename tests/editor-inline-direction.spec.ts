import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {selectTextRange} from "./helpers/selection";
import {SiyuanAPI} from "./helpers/siyuanAPI";
import {getDocumentEditor} from "./helpers/testNotebook";

interface ISyNode {
    Children?: ISyNode[];
    Data?: string;
    Properties?: Record<string, string>;
    TextMarkTextContent?: string;
    TextMarkType?: string;
    Type?: string;
}

interface IPersistedDirectionState {
    pairedStyle: string;
    pairedType: string;
    style: string;
    text: string;
    type: string;
}

const TEST_TEXT = "Direction العربية English";

const getPersistedDirectionState = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    const findState = (node: ISyNode): IPersistedDirectionState | undefined => {
        const children = node.Children || [];
        for (let index = 0; index < children.length; index++) {
            const child = children[index];
            if (child.Type === "NodeTextMark" && child.TextMarkTextContent === TEST_TEXT &&
                child.Properties?.style?.includes("direction:")) {
                const pairedIAL = children[index + 1];
                const pairedStyle = pairedIAL?.Data?.match(/style="([^"]*)"/)?.[1] || "";
                return {
                    pairedStyle,
                    pairedType: pairedIAL?.Type || "",
                    style: child.Properties.style,
                    text: child.TextMarkTextContent,
                    type: child.TextMarkType || "",
                };
            }
            const nested = findState(child);
            if (nested) {
                return nested;
            }
        }
        return undefined;
    };
    return findState(document);
};

const getDOMDirectionState = async (editable: Locator) => editable.evaluate((element, text) => {
    const mark = Array.from(element.querySelectorAll<HTMLElement>('[data-type~="text"]')).find(item =>
        item.textContent === text && (item.style.direction || item.style.unicodeBidi));
    if (!mark) {
        return undefined;
    }
    return {
        direction: mark.style.direction,
        text: mark.textContent || "",
        unicodeBidi: mark.style.unicodeBidi,
    };
}, TEST_TEXT);

const openTextDirectionAppearance = async (page: Page, editable: Locator) => {
    await selectTextRange(editable, editable, 0, TEST_TEXT.length);
    await editable.dispatchEvent("keyup", {key: "ArrowRight", shiftKey: true});

    const toolbar = page.locator(".protyle-toolbar:not(.fn__none)");
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator(':scope > [data-type="direction"]')).toHaveCount(0);
    await toolbar.locator(':scope > [data-type="text"]').click();

    const directionRow = page.locator('.protyle-util:not(.fn__none) [data-id="textDirection"]');
    await expect(directionRow).toBeVisible();
    return directionRow;
};

const applyDirection = async (page: Page, editable: Locator, direction: "ltr" | "rtl" | "") => {
    const directionRow = await openTextDirectionAppearance(page, editable);
    const response = page.waitForResponse(item => new URL(item.url()).pathname === "/api/transactions");
    await directionRow.locator(`[data-type="direction"][data-value="${direction}"]`).click();
    expect((await response).ok()).toBe(true);
};

test.describe("editor inline direction", () => {
    test("applies, replaces, clears, and persists text direction from Appearance", async ({
        page,
        createTestDocument,
        fullEntryVisibility,
        siyuanAPI,
    }) => {
        void fullEntryVisibility;
        const {docID, editor} = await createTestDocument("Inline Direction E2E", TEST_TEXT);
        let editable = editor.locator(':scope > [data-type="NodeParagraph"] > [contenteditable="true"]');

        await applyDirection(page, editable, "rtl");
        await expect.poll(() => getDOMDirectionState(editable)).toEqual({
            direction: "rtl",
            text: TEST_TEXT,
            unicodeBidi: "isolate",
        });
        await expect.poll(() => getPersistedDirectionState(siyuanAPI, docID), {timeout: 30000}).toEqual({
            pairedStyle: "direction: rtl; unicode-bidi: isolate;",
            pairedType: "NodeKramdownSpanIAL",
            style: "direction: rtl; unicode-bidi: isolate;",
            text: TEST_TEXT,
            type: "text",
        });

        await page.reload();
        let reloadedEditor = await getDocumentEditor(page, docID);
        editable = reloadedEditor.locator(':scope > [data-type="NodeParagraph"] > [contenteditable="true"]');
        await expect.poll(() => getDOMDirectionState(editable)).toEqual({
            direction: "rtl",
            text: TEST_TEXT,
            unicodeBidi: "isolate",
        });

        await applyDirection(page, editable, "ltr");
        await expect.poll(() => getDOMDirectionState(editable)).toEqual({
            direction: "ltr",
            text: TEST_TEXT,
            unicodeBidi: "isolate",
        });
        await expect.poll(() => getPersistedDirectionState(siyuanAPI, docID), {timeout: 30000}).toEqual({
            pairedStyle: "direction: ltr; unicode-bidi: isolate;",
            pairedType: "NodeKramdownSpanIAL",
            style: "direction: ltr; unicode-bidi: isolate;",
            text: TEST_TEXT,
            type: "text",
        });

        await applyDirection(page, editable, "");
        await expect.poll(() => getDOMDirectionState(editable)).toBeUndefined();
        await expect.poll(() => getPersistedDirectionState(siyuanAPI, docID), {timeout: 30000}).toBeUndefined();

        await page.reload();
        reloadedEditor = await getDocumentEditor(page, docID);
        editable = reloadedEditor.locator(':scope > [data-type="NodeParagraph"] > [contenteditable="true"]');
        await expect(editable).toHaveText(TEST_TEXT);
        await expect.poll(() => getDOMDirectionState(editable)).toBeUndefined();
    });
});
