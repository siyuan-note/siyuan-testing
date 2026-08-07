import {Locator} from "@playwright/test";
import {expect, test} from "./fixtures";

const cancelComposition = async (container: Locator, afterInlineMath = false) => {
    await container.evaluate((element, useInlineMath) => {
        const editable = element.closest('[contenteditable="true"]') as HTMLElement | null;
        if (!editable) {
            throw new Error("editable container is unavailable");
        }
        editable.focus();
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        const range = document.createRange();
        if (useInlineMath) {
            const mathElement = element.querySelector('[data-type~="inline-math"]');
            if (!mathElement) {
                throw new Error("inline formula is unavailable");
            }
            range.setStartAfter(mathElement);
            range.collapse(true);
        } else {
            range.selectNodeContents(element);
            range.collapse(false);
        }
        selection.removeAllRanges();
        selection.addRange(range);

        element.dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true}));
        selection.removeAllRanges();
        element.dispatchEvent(new CompositionEvent("compositionend", {bubbles: true, data: ""}));
    }, afterInlineMath);
};

const hasCursorAfterInlineMath = (container: Locator) => container.evaluate(element => {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0) {
        return false;
    }
    const range = selection.getRangeAt(0);
    const previousNode = range.startContainer.childNodes[range.startOffset - 1];
    return range.collapsed && range.startContainer === element &&
        previousNode instanceof Element && previousNode.matches('[data-type~="inline-math"]');
});

const hasCursorAtEnd = (container: Locator) => container.evaluate(element => {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0) {
        return false;
    }
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !element.contains(range.startContainer)) {
        return false;
    }
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(element);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    const removePlaceholders = (value: string) => value.replace(/[\u200B\uFEFF]/g, "");
    return removePlaceholders(prefixRange.toString()) === removePlaceholders(element.textContent || "");
});

test.describe("editor composition", () => {
    test.describe.configure({mode: "parallel"});

    test("restores the cursor after canceling Chinese composition after an inline formula", async ({
        createTestDocument,
    }) => {
        const {editor} = await createTestDocument("Editor Composition E2E", "$KATEX$");
        const editable = editor.locator(':scope > [data-type="NodeParagraph"] > [contenteditable="true"]');
        const inlineMath = editable.locator(':scope > [data-type~="inline-math"]');
        await expect(inlineMath).toBeVisible();

        await cancelComposition(editable, true);

        await expect.poll(() => hasCursorAfterInlineMath(editable)).toBe(true);
    });

    test("keeps the cursor in a table cell after canceling composition after an inline formula", async ({
        createTestDocument,
    }) => {
        const {editor} = await createTestDocument(
            "Table Composition E2E",
            [
                "| Formula | Other |",
                "| --- | --- |",
                "| $KATEX$ | Text |",
            ].join("\n"),
        );
        const cell = editor.locator(':scope > [data-type="NodeTable"] tbody td').first();
        const inlineMath = cell.locator(':scope > [data-type~="inline-math"]');
        await expect(inlineMath).toBeVisible();

        await cancelComposition(cell, true);

        await expect.poll(() => hasCursorAfterInlineMath(cell)).toBe(true);
    });

    test("keeps the cursor at the end of plain text in a table cell after canceling composition", async ({
        createTestDocument,
    }) => {
        const {editor} = await createTestDocument(
            "Plain Table Composition E2E",
            [
                "| Value | Other |",
                "| --- | --- |",
                "| Plain | Text |",
            ].join("\n"),
        );
        const cell = editor.locator(':scope > [data-type="NodeTable"] tbody td').first();
        await expect(cell).toHaveText("Plain");

        await cancelComposition(cell);

        await expect.poll(() => hasCursorAtEnd(cell)).toBe(true);
    });
});
