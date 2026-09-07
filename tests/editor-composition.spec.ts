import {Locator} from "@playwright/test";
import {expect, test} from "./fixtures";
import {assertValidListDOM, assertValidSyListTree} from "./helpers/listAssertions";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface ISyNode {
    Children?: ISyNode[];
    Data?: string;
    ID?: string;
    Properties?: Record<string, string>;
    Type?: string;
}

const flattenNodes = (node: ISyNode): ISyNode[] => [
    node,
    ...(node.Children || []).flatMap(flattenNodes),
];

const getPersistedMultilineMarkdownState = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    const nodes = flattenNodes(document);
    const ids = nodes.flatMap(node => node.ID ? [node.ID] : []);
    const list = (document.Children || []).find(node => node.Type === "NodeList");
    const listItem = (list?.Children || []).find(node => node.Type === "NodeListItem");
    const code = flattenNodes(listItem || {}).find(node => node.Type === "NodeCodeBlockCode");
    return {
        code: code?.Data?.trim() || "",
        duplicateIDs: ids.length - new Set(ids).size,
        itemBlockTypes: (listItem?.Children || []).filter(node => node.ID).map(node => node.Type),
        mismatchedPropertyIDs: nodes.filter(node =>
            node.ID && node.Properties?.id && node.ID !== node.Properties.id).length,
        topTypes: (document.Children || []).filter(node => node.ID).map(node => node.Type),
    };
};

const dispatchMultilineReplacement = async (editable: Locator, text: string) => {
    const canceled = await editable.evaluate((element, replacement) => {
        element.focus();
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
        const event = new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data: replacement,
            inputType: "insertReplacementText",
        });
        return !element.dispatchEvent(event);
    }, text);
    expect(canceled).toBe(true);
};

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

    test("parses and persists multiline Markdown inserted by macOS text replacement", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        test.skip(process.platform !== "darwin", "macOS text replacement is only available on macOS");

        const {docID, editor} = await createTestDocument("Multiline Text Replacement E2E", ";markdown");
        const paragraph = editor.locator(':scope > [data-type="NodeParagraph"]');
        const editable = paragraph.locator(':scope > [contenteditable="true"]');
        await expect(editable).toHaveText(";markdown");

        await dispatchMultilineReplacement(editable, [
            "- 1",
            "",
            "  ```txt",
            "    code",
            "  ```",
        ].join("\n"));

        const list = editor.locator(':scope > [data-type="NodeList"]');
        const listItem = list.locator(':scope > [data-type="NodeListItem"]');
        const codeBlock = listItem.locator(':scope > [data-type="NodeCodeBlock"]');
        await expect(list).toHaveCount(1);
        await expect(listItem.locator(':scope > [data-type="NodeParagraph"]')).toContainText("1");
        await expect(codeBlock.locator('.hljs [contenteditable="true"]')).toContainText("code");
        await assertValidListDOM(editor);
        await assertValidSyListTree(siyuanAPI, docID, editor);
        await expect.poll(() => getPersistedMultilineMarkdownState(siyuanAPI, docID), {timeout: 30000}).toEqual({
            code: "code",
            duplicateIDs: 0,
            itemBlockTypes: ["NodeParagraph", "NodeCodeBlock"],
            mismatchedPropertyIDs: 0,
            topTypes: ["NodeList"],
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        const reloadedList = reloadedEditor.locator(':scope > [data-type="NodeList"]');
        const reloadedItem = reloadedList.locator(':scope > [data-type="NodeListItem"]');
        await expect(reloadedItem.locator(':scope > [data-type="NodeParagraph"]')).toContainText("1");
        await expect(reloadedItem.locator(':scope > [data-type="NodeCodeBlock"] .hljs [contenteditable="true"]'))
            .toContainText("code");
        await assertValidListDOM(reloadedEditor);
        await assertValidSyListTree(siyuanAPI, docID, reloadedEditor);
    });
});
