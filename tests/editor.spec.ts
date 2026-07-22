import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {expectSearchIndex, submitSearch, withKeywordSearch} from "./helpers/search";

const focusEditable = async (editable: Locator) => {
    await expect(editable).toBeVisible();
    await expect(async () => {
        await editable.click();
        expect(await editable.evaluate(element => element.contains(getSelection()?.anchorNode || null))).toBe(true);
    }).toPass({timeout: 15000});
};

const typeInto = async (page: Page, editable: Locator, text: string) => {
    await focusEditable(editable);
    await page.keyboard.type(text, {delay: 10});
};

test.describe("editor", () => {
    test.describe.configure({mode: "parallel"});

    test("creates formatted content and finds the document", {tag: "@smoke"}, async ({
        page,
        createTestDocument,
        siyuanAPI,
    }) => {
        const {docID, editor, title} = await createTestDocument("Editor Input E2E");
        const initialEditable = editor.locator(":scope > [data-node-id] > [contenteditable=true]").first();

        await typeInto(page, initialEditable, "## ");
        const heading = editor.locator('[data-type="NodeHeading"]');
        await expect(heading).toBeVisible();
        await typeInto(page, heading.locator('[contenteditable="true"]'), "Hello Heading");
        await page.keyboard.press("Enter");
        const paragraph = editor.locator(':scope > [data-type="NodeParagraph"]').last();
        await expect(paragraph).toBeVisible();
        await typeInto(page, paragraph.locator('[contenteditable="true"]'), "This is a test paragraph.");
        await page.keyboard.press("Enter");
        const nextParagraph = editor.locator(':scope > [data-type="NodeParagraph"]').last();
        await expect(nextParagraph).toBeVisible();
        await typeInto(page, nextParagraph.locator('[contenteditable="true"]'), "- ");
        const list = editor.locator(':scope > [data-type="NodeList"]');
        await expect(list).toBeVisible();
        const listItems = list.locator(':scope > [data-type="NodeListItem"]');
        await typeInto(page, listItems.first().locator('[contenteditable="true"]'), "list item 1");
        await page.keyboard.press("Enter");
        await expect(listItems).toHaveCount(2);
        await typeInto(page, listItems.nth(1).locator('[contenteditable="true"]'), "list item 2");

        await expect(heading).toContainText("Hello Heading");
        await expect(editor.locator('[data-type="NodeParagraph"]').filter({hasText: "This is a test paragraph."}))
            .toBeVisible();
        await expect(listItems.nth(0)).toContainText("list item 1");
        await expect(listItems.nth(1)).toContainText("list item 2");
        await expect(page.locator(".protyle-breadcrumb").last()).toBeVisible();

        await expectSearchIndex(siyuanAPI, title, docID);
        await withKeywordSearch(page, async (session) => {
            const result = await submitSearch(page, session, title);
            expect(result.blocks.some(block => block.rootID === docID)).toBe(true);
            await expect(session.results.locator(`.b3-list-item[data-node-id="${docID}"]`)).toBeVisible();
        });
    });

    test("folds and unfolds a heading", async ({page, createTestDocument}) => {
        const {editor} = await createTestDocument(
            "Heading Fold E2E",
            "## Fold Me\n\nsub content under heading\n\nmore sub content",
        );
        const heading = editor.locator('[data-type="NodeHeading"]').filter({hasText: "Fold Me"});
        await expect(heading).toBeVisible();
        await heading.click();

        await page.keyboard.press("Control+ArrowUp");
        await expect(heading).toHaveAttribute("fold", "1");
        const firstChild = editor.locator('[data-type="NodeParagraph"]').filter({hasText: "sub content under heading"});
        const secondChild = editor.locator('[data-type="NodeParagraph"]').filter({hasText: "more sub content"});
        await expect(firstChild).toHaveCount(0);
        await expect(secondChild).toHaveCount(0);

        await page.keyboard.press("Control+ArrowUp");
        await expect(heading).not.toHaveAttribute("fold", "1");
        await expect(firstChild).toBeVisible();
        await expect(secondChild).toBeVisible();
    });

    test("undoes and redoes immediately after rapid input", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("Undo Redo E2E");
        const content = "This will be undone";
        const transactionPaths: string[] = [];
        page.on("request", request => transactionPaths.push(new URL(request.url()).pathname));
        const editable = editor.locator(":scope > [data-node-id] > [contenteditable=true]").first();
        await focusEditable(editable);
        const inputTransaction = page.waitForRequest(request =>
            new URL(request.url()).pathname === "/api/transactions",
        );
        await page.keyboard.type(content, {delay: 5});
        const paragraph = editor.locator('[data-type="NodeParagraph"]').filter({hasText: content});
        await expect(paragraph).toBeVisible();
        const undoResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/transactions/undo");
        await editable.press("Control+Z");
        await Promise.all([inputTransaction, undoResponse]);
        await expect(paragraph).toHaveCount(0);
        expect(transactionPaths.lastIndexOf("/api/transactions")).toBeGreaterThanOrEqual(0);
        expect(transactionPaths.indexOf("/api/transactions/undo")).toBeGreaterThanOrEqual(0);
        expect(transactionPaths.lastIndexOf("/api/transactions"))
            .toBeLessThan(transactionPaths.indexOf("/api/transactions/undo"));
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).not.toContain(content);

        const redoResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/transactions/redo");
        await editor.locator(":scope > [data-node-id] > [contenteditable=true]").first().press("Control+Y");
        await redoResponse;
        await expect(paragraph).toBeVisible();
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain(content);
    });

    test("creates and persists a JavaScript code block", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("Code Block E2E");
        const editable = editor.locator(":scope > [data-node-id] > [contenteditable=true]").first();
        await typeInto(page, editable, "```js");
        await page.keyboard.press("Enter");

        const codeBlock = editor.locator('[data-type="NodeCodeBlock"]');
        await expect(codeBlock).toBeVisible();
        await expect(codeBlock.locator(".protyle-action__language")).toHaveText("js");

        const content = "console.log('hello')";
        const codeEditable = codeBlock.locator('.hljs [contenteditable="true"]');
        await focusEditable(codeEditable);
        const transaction = page.waitForResponse(response =>
            new URL(response.url()).pathname === "/api/transactions", {timeout: 15000});
        await page.keyboard.insertText(content);
        await expect(codeBlock).toContainText(content);
        expect((await transaction).ok()).toBe(true);
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID))).toContain(content);
    });
});
