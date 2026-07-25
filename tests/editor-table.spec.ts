import {BrowserContext, Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {PRIMARY_MODIFIER, REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {SiyuanAPI} from "./helpers/siyuanAPI";
import {getDocumentEditor} from "./helpers/testNotebook";

interface ISyNode {
    ID?: string;
    Data?: string;
    Properties?: Record<string, string>;
    TableAligns?: number[];
    Type?: string;
    Children?: ISyNode[];
}

const flattenNodes = (node: ISyNode): ISyNode[] => [
    node,
    ...(node.Children || []).flatMap(flattenNodes),
];

const getNodeText = (node: ISyNode): string =>
    (node.Data || "") + (node.Children || []).map(getNodeText).join("");

const selectCellContents = async (cell: Locator, collapseToEnd = false) => {
    await expect(cell).toBeVisible();
    await cell.evaluate((element, collapse) => {
        const editable = element.closest('[contenteditable="true"]') as HTMLElement | null;
        if (!editable) {
            throw new Error("table editable container is unavailable");
        }
        editable.focus();
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(collapse);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    }, collapseToEnd);
};

const focusAtEnd = async (block: Locator) => {
    const editable = block.locator('[contenteditable="true"]').first();
    await editable.evaluate(element => {
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

const allowClipboard = async (context: BrowserContext, baseURL: string | undefined) => {
    if (!baseURL) {
        throw new Error("playwright.config.ts must define use.baseURL");
    }
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(baseURL).origin,
    });
};

const requestTransaction = async (page: Page, action: () => Promise<void>) => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === "/api/transactions", {timeout: 30000});
    await action();
    await response;
};

const requestHistoryAction = async (page: Page, table: Locator, action: "undo" | "redo") => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === `/api/transactions/${action}`, {timeout: 30000});
    await selectCellContents(table.locator("tbody td").first(), true);
    await page.keyboard.press(action === "undo" ? UNDO_SHORTCUT : REDO_SHORTCUT);
    await response;
};

const chooseTableCellAction = async (page: Page, cell: Locator, action: string) => {
    await selectCellContents(cell, true);
    await cell.click({button: "right"});
    const menu = page.locator("#commonMenu:not(.fn__none)");
    await expect(menu).toBeVisible();
    const item = menu.locator(`[data-id="${action}"]`).first();
    await expect(item).toBeVisible();
    await requestTransaction(page, () => item.click({position: {x: 12, y: 12}}));
    await expect(menu).toBeHidden();
};

const replaceCellText = async (page: Page, cell: Locator, value: string) => {
    const current = (await cell.textContent())?.replace(/\u200b/g, "").trim() || "";
    await cell.dblclick();
    await expect.poll(() => page.evaluate(() => getSelection()?.toString() || "")).toBe(current);
    await requestTransaction(page, () => page.keyboard.type(value, {delay: 10}));
};

const getDOMTableState = async (table: Locator) => ({
    body: await table.locator("tbody tr").evaluateAll(rows => rows.map(row =>
        Array.from(row.querySelectorAll("td")).map(cell => cell.textContent?.replace(/\u200b/g, "").trim() || ""))),
    duplicateIDs: await table.locator("[data-node-id]").evaluateAll(elements => {
        const ids = elements.map(element => element.getAttribute("data-node-id")).filter(Boolean);
        return ids.length - new Set(ids).size;
    }),
    head: await table.locator("thead tr").evaluateAll(rows => rows.map(row =>
        Array.from(row.querySelectorAll("th")).map(cell => cell.textContent?.replace(/\u200b/g, "").trim() || ""))),
});

const getPersistedTableState = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    const nodes = flattenNodes(document);
    const ids = nodes.flatMap(node => node.ID ? [node.ID] : []);
    const table = nodes.find(node => node.Type === "NodeTable");
    const tableRows = [
        ...(table?.Children?.find(node => node.Type === "NodeTableHead")?.Children || []),
        ...(table?.Children?.filter(node => node.Type === "NodeTableRow") || []),
    ];
    return {
        aligns: table?.TableAligns?.length || 0,
        columns: tableRows.map(row => row.Children?.filter(node => node.Type === "NodeTableCell").length || 0),
        duplicateIDs: ids.length - new Set(ids).size,
        mismatchedPropertyIDs: nodes.filter(node =>
            node.ID && node.Properties?.id && node.ID !== node.Properties.id).length,
        tableCount: nodes.filter(node => node.Type === "NodeTable").length,
        text: table ? getNodeText(table) : "",
    };
};

test.describe("table editing", () => {
    // 系统剪贴板由同一台测试机共享，这组用例需要串行执行，避免后续复制粘贴测试与其他表格操作交叉。
    test.describe.configure({mode: "serial"});

    test("edits a table, appends a row with Tab, and restores it after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Table Editing E2E",
            [
                "| Item | Quantity |",
                "| --- | ---: |",
                "| Alpha | 1 |",
                "| Beta | 2 |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        await expect(table).toHaveCount(1);
        await expect.poll(() => getDOMTableState(table)).toEqual({
            body: [["Alpha", "1"], ["Beta", "2"]],
            duplicateIDs: 0,
            head: [["Item", "Quantity"]],
        });

        const firstCell = table.locator("tbody tr").first().locator("td").first();
        await replaceCellText(page, firstCell, "G");
        await expect(firstCell).toHaveText("G");

        const undoResponse = page.waitForResponse(response =>
            new URL(response.url()).pathname === "/api/transactions/undo", {timeout: 30000});
        await page.keyboard.press(UNDO_SHORTCUT);
        await undoResponse;
        const restoredFirstCell = table.locator("tbody tr").first().locator("td").first();
        await expect(restoredFirstCell).toHaveText("Alpha");

        await selectCellContents(restoredFirstCell, true);
        const redoResponse = page.waitForResponse(response =>
            new URL(response.url()).pathname === "/api/transactions/redo", {timeout: 30000});
        await page.keyboard.press(REDO_SHORTCUT);
        await redoResponse;
        await expect(table.locator("tbody tr").first().locator("td").first()).toHaveText("G");

        const lastCell = table.locator("tbody tr").last().locator("td").last();
        await selectCellContents(lastCell, true);
        await requestTransaction(page, () => page.keyboard.press("Tab"));
        await expect(table.locator("tbody tr")).toHaveCount(3);

        const newRow = table.locator("tbody tr").last();
        const newItemCell = newRow.locator("td").first();
        await selectCellContents(newItemCell);
        await requestTransaction(page, () => page.keyboard.type("Delta", {delay: 10}));
        const newQuantityCell = newRow.locator("td").last();
        await selectCellContents(newQuantityCell);
        await requestTransaction(page, () => page.keyboard.type("3", {delay: 10}));

        await expect.poll(() => getDOMTableState(table), {timeout: 30000}).toEqual({
            body: [["G", "1"], ["Beta", "2"], ["Delta", "3"]],
            duplicateIDs: 0,
            head: [["Item", "Quantity"]],
        });
        await expect.poll(() => getPersistedTableState(siyuanAPI, docID), {timeout: 30000}).toEqual({
            aligns: 2,
            columns: [2, 2, 2, 2],
            duplicateIDs: 0,
            mismatchedPropertyIDs: 0,
            tableCount: 1,
            text: expect.stringMatching(/Item.*Quantity.*G.*1.*Beta.*2.*Delta.*3/s),
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        const reloadedTable = reloadedEditor.locator(':scope > [data-type="NodeTable"]');
        await expect.poll(() => getDOMTableState(reloadedTable), {timeout: 30000}).toEqual({
            body: [["G", "1"], ["Beta", "2"], ["Delta", "3"]],
            duplicateIDs: 0,
            head: [["Item", "Quantity"]],
        });
    });

    test("copies and pastes a table with a new block ID and preserved structure", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        await allowClipboard(context, baseURL);
        const {docID, editor} = await createTestDocument(
            "Table Copy Paste E2E",
            [
                "| Name | Status |",
                "| --- | --- |",
                "| Alpha | Ready |",
                "| Beta | Done |",
                "",
                "Paste anchor",
            ].join("\n"),
        );
        const sourceTable = editor.locator(':scope > [data-type="NodeTable"]');
        const sourceID = await sourceTable.getAttribute("data-node-id");
        expect(sourceID).toBeTruthy();
        await sourceTable.click({modifiers: [PRIMARY_MODIFIER]});
        await expect(sourceTable).toHaveClass(/protyle-wysiwyg--select/);
        await page.keyboard.press("ControlOrMeta+C");
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Alpha");

        const anchor = editor.locator(':scope > [data-type="NodeParagraph"]').filter({hasText: "Paste anchor"});
        await focusAtEnd(anchor);
        await requestTransaction(page, () => page.keyboard.press("Enter"));
        const existenceCheck = page.waitForResponse(response =>
            new URL(response.url()).pathname === "/api/block/checkBlocksExist", {timeout: 30000});
        await page.keyboard.press("ControlOrMeta+V");
        await existenceCheck;

        const tables = editor.locator(':scope > [data-type="NodeTable"]');
        await expect(tables).toHaveCount(2);
        const copiedTable = tables.nth(1);
        const copiedID = await copiedTable.getAttribute("data-node-id");
        expect(copiedID).toBeTruthy();
        expect(copiedID).not.toBe(sourceID);
        await expect.poll(() => getDOMTableState(copiedTable), {timeout: 30000}).toEqual({
            body: [["Alpha", "Ready"], ["Beta", "Done"]],
            duplicateIDs: 0,
            head: [["Name", "Status"]],
        });
        await expect.poll(() => getPersistedTableState(siyuanAPI, docID), {timeout: 30000}).toMatchObject({
            aligns: 2,
            columns: [2, 2, 2],
            duplicateIDs: 0,
            mismatchedPropertyIDs: 0,
            tableCount: 2,
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        const reloadedTables = reloadedEditor.locator(':scope > [data-type="NodeTable"]');
        await expect(reloadedTables).toHaveCount(2);
        await expect.poll(() => getDOMTableState(reloadedTables.nth(1)), {timeout: 30000}).toEqual({
            body: [["Alpha", "Ready"], ["Beta", "Done"]],
            duplicateIDs: 0,
            head: [["Name", "Status"]],
        });
    });

    test("inserts rows and columns and restores the table structure with undo and redo", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Table Insert Structure E2E",
            [
                "| Item | Quantity | Status |",
                "| --- | ---: | --- |",
                "| Alpha | 1 | Ready |",
                "| Beta | 2 | Done |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');

        await chooseTableCellAction(page, table.locator("tbody tr").first().locator("td").nth(1), "insertRowBelow");
        await expect.poll(() => getDOMTableState(table)).toEqual({
            body: [["Alpha", "1", "Ready"], ["", "", ""], ["Beta", "2", "Done"]],
            duplicateIDs: 0,
            head: [["Item", "Quantity", "Status"]],
        });

        await chooseTableCellAction(page, table.locator("thead th").nth(1), "insertColumnRight");
        const expandedState = {
            body: [["Alpha", "1", "", "Ready"], ["", "", "", ""], ["Beta", "2", "", "Done"]],
            duplicateIDs: 0,
            head: [["Item", "Quantity", "", "Status"]],
        };
        await expect.poll(() => getDOMTableState(table)).toEqual(expandedState);
        await expect.poll(() => getPersistedTableState(siyuanAPI, docID), {timeout: 30000}).toMatchObject({
            aligns: 4,
            columns: [4, 4, 4, 4],
            duplicateIDs: 0,
            mismatchedPropertyIDs: 0,
            tableCount: 1,
        });

        await requestHistoryAction(page, table, "undo");
        await expect.poll(() => getDOMTableState(table)).toEqual({
            body: [["Alpha", "1", "Ready"], ["", "", ""], ["Beta", "2", "Done"]],
            duplicateIDs: 0,
            head: [["Item", "Quantity", "Status"]],
        });
        await requestHistoryAction(page, table, "undo");
        await expect.poll(() => getDOMTableState(table)).toEqual({
            body: [["Alpha", "1", "Ready"], ["Beta", "2", "Done"]],
            duplicateIDs: 0,
            head: [["Item", "Quantity", "Status"]],
        });

        await requestHistoryAction(page, table, "redo");
        await requestHistoryAction(page, table, "redo");
        await expect.poll(() => getDOMTableState(table)).toEqual(expandedState);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        await expect.poll(() => getDOMTableState(
            reloadedEditor.locator(':scope > [data-type="NodeTable"]'),
        ), {timeout: 30000}).toEqual(expandedState);
    });

    test("deletes a row and column and persists the restored transaction", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Table Delete Structure E2E",
            [
                "| Item | Quantity | Status |",
                "| --- | ---: | --- |",
                "| Alpha | 1 | Ready |",
                "| Beta | 2 | Done |",
                "| Gamma | 3 | Waiting |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');

        await chooseTableCellAction(page, table.locator("tbody tr").nth(1).locator("td").nth(1), "deleteRow");
        await expect.poll(() => getDOMTableState(table)).toEqual({
            body: [["Alpha", "1", "Ready"], ["Gamma", "3", "Waiting"]],
            duplicateIDs: 0,
            head: [["Item", "Quantity", "Status"]],
        });

        await chooseTableCellAction(page, table.locator("thead th").nth(1), "deleteColumn");
        const reducedState = {
            body: [["Alpha", "Ready"], ["Gamma", "Waiting"]],
            duplicateIDs: 0,
            head: [["Item", "Status"]],
        };
        await expect.poll(() => getDOMTableState(table)).toEqual(reducedState);
        await expect.poll(() => getPersistedTableState(siyuanAPI, docID), {timeout: 30000}).toMatchObject({
            aligns: 2,
            columns: [2, 2, 2],
            duplicateIDs: 0,
            mismatchedPropertyIDs: 0,
            tableCount: 1,
        });

        await requestHistoryAction(page, table, "undo");
        await requestHistoryAction(page, table, "undo");
        await expect.poll(() => getDOMTableState(table)).toEqual({
            body: [["Alpha", "1", "Ready"], ["Beta", "2", "Done"], ["Gamma", "3", "Waiting"]],
            duplicateIDs: 0,
            head: [["Item", "Quantity", "Status"]],
        });

        await requestHistoryAction(page, table, "redo");
        await requestHistoryAction(page, table, "redo");
        await expect.poll(() => getDOMTableState(table)).toEqual(reducedState);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        await expect.poll(() => getDOMTableState(
            reloadedEditor.locator(':scope > [data-type="NodeTable"]'),
        ), {timeout: 30000}).toEqual(reducedState);
    });
});
