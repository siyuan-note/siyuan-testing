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

type TableControlType = "row" | "column" | "cell" | "add-row" | "add-column";

const getVisibleTableControl = (page: Page, type: TableControlType) =>
    page.locator(`.protyle-table-control [data-type="${type}"]:visible`);

const hoverTableControl = async (page: Page, cell: Locator, type: TableControlType) => {
    await expect(cell).toBeVisible();
    if (type === "cell") {
        await cell.hover();
        return;
    }
    const table = cell.locator("xpath=ancestor::table");
    const tableBox = await table.boundingBox();
    const cellBox = await cell.boundingBox();
    expect(tableBox).not.toBeNull();
    expect(cellBox).not.toBeNull();
    if (type === "row") {
        const firstRow = await cell.evaluate(element =>
            element.parentElement === (element.closest("table") as HTMLTableElement).rows[0]);
        await page.mouse.move(tableBox!.x + (firstRow ? 1 : -1),
            cellBox!.y + cellBox!.height / 2, {steps: 10});
    } else if (type === "column") {
        await page.mouse.move(cellBox!.x + cellBox!.width / 2, tableBox!.y - 1, {steps: 10});
    } else if (type === "add-row") {
        await page.mouse.move(tableBox!.x + tableBox!.width / 2, tableBox!.y + tableBox!.height + 1, {steps: 10});
    } else {
        await page.mouse.move(tableBox!.x + tableBox!.width + 1, tableBox!.y + tableBox!.height / 2, {steps: 10});
    }
};

const openTableControlMenu = async (page: Page, cell: Locator, type: TableControlType) => {
    await hoverTableControl(page, cell, type);
    const control = getVisibleTableControl(page, type);
    await expect(control).toHaveCount(1);
    await control.click({button: "right"});
    const menu = page.locator("#commonMenu:not(.fn__none)");
    await expect(menu).toBeVisible();
    return menu;
};

const getMenuItemByLabel = (page: Page, scope: Locator, label: string) =>
    scope.locator(".b3-menu__item", {
        has: page.locator(".b3-menu__label", {hasText: label}),
    }).first();

const clickTableControl = async (page: Page, cell: Locator, type: TableControlType) => {
    await hoverTableControl(page, cell, type);
    const control = getVisibleTableControl(page, type);
    await expect(control).toHaveCount(1);
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, {steps: 10});
    await expect(control).toBeVisible();
    await control.click({modifiers: [PRIMARY_MODIFIER]});
};

const copyTableControlSelection = async (page: Page) => page.evaluate(() => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData,
    });
    document.dispatchEvent(event);
    const siyuan = clipboardData.getData("text/siyuan");
    const html = clipboardData.getData("text/html");
    const container = document.createElement("div");
    container.innerHTML = siyuan;
    const table = container.querySelector("table");
    const getRows = (selector: string) => Array.from(table?.querySelectorAll(selector) || []).map(row =>
        Array.from(row.querySelectorAll("th, td"))
            .filter(cell => !cell.classList.contains("fn__none"))
            .map(cell => cell.textContent?.replace(/\u200b/g, "").trim() || ""));
    return {
        body: getRows("tbody tr"),
        columnCount: table?.querySelectorAll(":scope > colgroup > col").length || 0,
        defaultPrevented: event.defaultPrevented,
        hasSiyuanComment: html.startsWith("<!--data-siyuan='"),
        head: getRows("thead tr"),
        nodeType: container.firstElementChild?.getAttribute("data-type") || "",
        plain: clipboardData.getData("text/plain"),
        types: Array.from(clipboardData.types).sort(),
    };
});

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

    test("keeps the table block gutter accessible beside the row control", async ({
        createTestDocument,
        page,
    }) => {
        const {editor} = await createTestDocument(
            "Table Block Gutter E2E",
            [
                "| Item | Quantity |",
                "| --- | ---: |",
                "| Alpha | 1 |",
            ].join("\n"),
        );
        const tableBlock = editor.locator(':scope > [data-type="NodeTable"]');
        const tableID = await tableBlock.getAttribute("data-node-id");
        expect(tableID).toBeTruthy();
        const firstCell = tableBlock.locator("thead th").first();
        await firstCell.hover();
        await hoverTableControl(page, firstCell, "row");
        const rowControl = getVisibleTableControl(page, "row");
        const gutter = page.locator(`.protyle-gutters button[data-node-id="${tableID}"]`);
        await expect(rowControl).toBeVisible();
        await expect(gutter).toBeVisible();
        const rowControlBox = await rowControl.boundingBox();
        const gutterBox = await gutter.boundingBox();
        expect(rowControlBox).not.toBeNull();
        expect(gutterBox).not.toBeNull();
        expect(gutterBox!.x + gutterBox!.width).toBeLessThanOrEqual(rowControlBox!.x);

        await page.mouse.click(gutterBox!.x + gutterBox!.width / 2, gutterBox!.y + gutterBox!.height / 2);
        await expect(page.locator("#commonMenu:not(.fn__none)")).toBeVisible();
        await expect(page.locator(".protyle-table-control__selection:visible")).toHaveCount(0);
    });

    test("supports dragging rows and columns directly from outside the table", async ({
        createTestDocument,
        page,
    }) => {
        const {editor} = await createTestDocument(
            "Table External Control Drag E2E",
            [
                "| Item | Quantity |",
                "| --- | ---: |",
                "| Alpha | 1 |",
                "| Beta | 2 |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"] table');
        const bodyCell = table.locator("tbody td").first();
        const tableBox = await table.boundingBox();
        const bodyCellBox = await bodyCell.boundingBox();
        expect(tableBox).not.toBeNull();
        expect(bodyCellBox).not.toBeNull();

        await page.mouse.move(tableBox!.x - 40, bodyCellBox!.y + bodyCellBox!.height / 2);
        await page.mouse.move(tableBox!.x - 1, bodyCellBox!.y + bodyCellBox!.height / 2, {steps: 10});
        const rowControl = getVisibleTableControl(page, "row");
        await expect(rowControl).toBeVisible();
        const rowControlBox = await rowControl.boundingBox();
        const secondRowBox = await table.locator("tbody tr").nth(1).boundingBox();
        expect(rowControlBox).not.toBeNull();
        expect(secondRowBox).not.toBeNull();
        await requestTransaction(page, async () => {
            await page.mouse.move(rowControlBox!.x + rowControlBox!.width / 2,
                rowControlBox!.y + rowControlBox!.height / 2);
            await page.mouse.down();
            await page.mouse.move(tableBox!.x + 20, secondRowBox!.y + secondRowBox!.height - 2, {steps: 10});
            await page.mouse.up();
        });
        await expect(table.locator("tbody tr td:first-child")).toHaveText(["Beta", "Alpha"]);

        await page.mouse.move(0, 0);
        const updatedTableBox = await table.boundingBox();
        const updatedHeaderCellBox = await table.locator("thead th").first().boundingBox();
        expect(updatedTableBox).not.toBeNull();
        expect(updatedHeaderCellBox).not.toBeNull();
        await page.mouse.move(updatedHeaderCellBox!.x + updatedHeaderCellBox!.width / 2, updatedTableBox!.y - 40);
        await page.mouse.move(updatedHeaderCellBox!.x + updatedHeaderCellBox!.width / 2,
            updatedTableBox!.y - 1, {steps: 10});
        const columnControl = getVisibleTableControl(page, "column");
        await expect(columnControl).toBeVisible();
        const columnControlBox = await columnControl.boundingBox();
        const secondHeaderCellBox = await table.locator("thead th").nth(1).boundingBox();
        expect(columnControlBox).not.toBeNull();
        expect(secondHeaderCellBox).not.toBeNull();
        await requestTransaction(page, async () => {
            await page.mouse.move(columnControlBox!.x + columnControlBox!.width / 2,
                columnControlBox!.y + columnControlBox!.height / 2);
            await page.mouse.down();
            await page.mouse.move(secondHeaderCellBox!.x + secondHeaderCellBox!.width - 2,
                updatedTableBox!.y + 20, {steps: 10});
            await page.mouse.up();
        });
        await expect(table.locator("thead th")).toHaveText(["Quantity", "Item"]);
    });

    test("uses slim table controls without blocking editor scrolling", async ({
        createTestDocument,
        page,
    }) => {
        const trailingContent = Array.from({length: 80}, (_, index) => `Trailing paragraph ${index + 1}`).join("\n\n");
        const {editor} = await createTestDocument(
            "Table Compact Control Scroll E2E",
            [
                "| Item | Quantity |",
                "| --- | ---: |",
                "| Alpha | 1 |",
                "",
                trailingContent,
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        const bodyCell = table.locator("tbody td").first();
        const headerCell = table.locator("thead th").first();
        await hoverTableControl(page, bodyCell, "row");
        const rowControl = getVisibleTableControl(page, "row");
        const rowControlBox = await rowControl.boundingBox();
        const bodyCellBox = await bodyCell.boundingBox();
        expect(rowControlBox).not.toBeNull();
        expect(bodyCellBox).not.toBeNull();
        expect(rowControlBox!.width).toBeCloseTo(16, 0);
        expect(rowControlBox!.height).toBeCloseTo(bodyCellBox!.height, 0);

        await hoverTableControl(page, headerCell, "column");
        const columnControl = getVisibleTableControl(page, "column");
        const columnControlBox = await columnControl.boundingBox();
        const headerCellBox = await headerCell.boundingBox();
        expect(columnControlBox).not.toBeNull();
        expect(headerCellBox).not.toBeNull();
        expect(columnControlBox!.width).toBeCloseTo(headerCellBox!.width, 0);
        expect(columnControlBox!.height).toBeCloseTo(16, 0);

        await hoverTableControl(page, bodyCell, "add-row");
        const addRowControlBox = await getVisibleTableControl(page, "add-row").boundingBox();
        const tableBox = await table.locator("table").boundingBox();
        expect(addRowControlBox).not.toBeNull();
        expect(tableBox).not.toBeNull();
        expect(addRowControlBox!.width).toBeCloseTo(tableBox!.width, 0);
        expect(addRowControlBox!.height).toBeCloseTo(16, 0);

        await hoverTableControl(page, bodyCell, "add-column");
        const addColumnControlBox = await getVisibleTableControl(page, "add-column").boundingBox();
        expect(addColumnControlBox).not.toBeNull();
        expect(addColumnControlBox!.width).toBeCloseTo(16, 0);
        expect(addColumnControlBox!.height).toBeCloseTo(tableBox!.height, 0);

        const content = editor.locator(
            "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle-content ')][1]",
        );
        const scrollState = await content.evaluate(element => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
        }));
        expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
        await page.mouse.wheel(0, 240);
        await expect.poll(() => content.evaluate(element => element.scrollTop))
            .toBeGreaterThan(scrollState.scrollTop);
    });

    test("uses consistent small corners for tables and table controls", async ({
        createTestDocument,
        page,
    }) => {
        const {editor} = await createTestDocument(
            "Table Corner E2E",
            [
                "| Item | Quantity |",
                "| --- | ---: |",
                "| Alpha | 1 |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        const tableElement = table.locator("table");
        const bodyCell = table.locator("tbody td").first();
        const smallRadius = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue("--b3-border-radius-s").trim());
        const getCornerRadii = (element: Locator) => element.evaluate(item => {
            const style = getComputedStyle(item);
            return [
                style.borderTopLeftRadius,
                style.borderTopRightRadius,
                style.borderBottomRightRadius,
                style.borderBottomLeftRadius,
            ];
        });
        const roundedCorners = [smallRadius, smallRadius, smallRadius, smallRadius];
        await expect.poll(() => getCornerRadii(tableElement)).toEqual(roundedCorners);
        await expect(tableElement).toHaveCSS("overflow", "hidden");

        for (const type of ["cell", "row", "column"] as const) {
            await hoverTableControl(page, bodyCell, type);
            await expect.poll(() => getCornerRadii(getVisibleTableControl(page, type))).toEqual(roundedCorners);
        }

        await hoverTableControl(page, bodyCell, "add-row");
        await expect.poll(() => getCornerRadii(tableElement))
            .toEqual([smallRadius, smallRadius, "0px", "0px"]);
        await expect.poll(() => getCornerRadii(getVisibleTableControl(page, "add-row")))
            .toEqual(["0px", "0px", smallRadius, smallRadius]);

        await hoverTableControl(page, bodyCell, "add-column");
        await expect.poll(() => getCornerRadii(tableElement))
            .toEqual([smallRadius, "0px", "0px", smallRadius]);
        await expect.poll(() => getCornerRadii(getVisibleTableControl(page, "add-column")))
            .toEqual(["0px", smallRadius, smallRadius, "0px"]);

        await hoverTableControl(page, bodyCell, "cell");
        await expect.poll(() => getCornerRadii(tableElement)).toEqual(roundedCorners);
    });

    test("positions a slim row control on the logical row covered by a merged cell", async ({
        createTestDocument,
        page,
    }) => {
        const {editor} = await createTestDocument(
            "Table Merged Logical Row Control E2E",
            [
                "| Item | Quantity | Status |",
                "| --- | ---: | --- |",
                "| Alpha | 1 | Ready |",
                "| Beta | 2 | Done |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        const firstColumnCells = table.locator("tbody tr td:first-child");
        await clickTableControl(page, firstColumnCells.nth(0), "cell");
        await clickTableControl(page, firstColumnCells.nth(1), "cell");
        const menu = await openTableControlMenu(page, firstColumnCells.nth(1), "cell");
        const mergeLabel = await page.evaluate(() => window.siyuan.languages.mergeCell);
        await requestTransaction(page, () => getMenuItemByLabel(page, menu, mergeLabel).click());

        const bodyRows = table.locator("tbody tr");
        const firstRowBox = await bodyRows.nth(0).boundingBox();
        const secondRowBox = await bodyRows.nth(1).boundingBox();
        expect(firstRowBox).not.toBeNull();
        expect(secondRowBox).not.toBeNull();
        const secondRowCell = bodyRows.nth(1).locator("td:not(.fn__none)").first();
        await hoverTableControl(page, secondRowCell, "row");
        const rowControl = getVisibleTableControl(page, "row");
        const rowControlBox = await rowControl.boundingBox();
        expect(rowControlBox).not.toBeNull();
        expect(rowControlBox!.width).toBeCloseTo(16, 0);
        expect(rowControlBox!.height).toBeCloseTo(secondRowBox!.height, 0);
        expect(rowControlBox!.y + rowControlBox!.height / 2)
            .toBeCloseTo(secondRowBox!.y + secondRowBox!.height / 2, 0);

        await rowControl.click({modifiers: [PRIMARY_MODIFIER]});
        const selection = page.locator(".protyle-table-control__selection:visible");
        await expect(selection).toHaveCount(1);
        const selectionBox = await selection.boundingBox();
        expect(selectionBox).not.toBeNull();
        expect(selectionBox!.y).toBeCloseTo(firstRowBox!.y, 0);
        expect(selectionBox!.y + selectionBox!.height)
            .toBeCloseTo(secondRowBox!.y + secondRowBox!.height, 0);
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

    test("selects discontinuous rows and clears the selection without a page error", async ({
        createTestDocument,
        page,
    }) => {
        const {editor} = await createTestDocument(
            "Table Discontinuous Row Selection E2E",
            [
                "| Item | Quantity | Status |",
                "| --- | ---: | --- |",
                "| Alpha | 1 | Ready |",
                "| Beta | 2 | Done |",
                "| Gamma | 3 | Waiting |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        const firstCells = table.locator("tbody tr td:first-child");
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));

        await clickTableControl(page, firstCells.nth(0), "row");
        await clickTableControl(page, firstCells.nth(2), "row");
        const copied = await copyTableControlSelection(page);
        expect(copied).toMatchObject({
            body: [["Gamma", "3", "Waiting"]],
            columnCount: 3,
            defaultPrevented: true,
            hasSiyuanComment: true,
            head: [["Alpha", "1", "Ready"]],
            nodeType: "NodeTable",
            plain: "Alpha\t1\tReady\nGamma\t3\tWaiting",
        });
        expect(copied.types).toEqual(expect.arrayContaining(["text/html", "text/plain", "text/siyuan"]));

        await clickTableControl(page, firstCells.nth(0), "row");
        await expect.poll(() => copyTableControlSelection(page)).toMatchObject({
            body: [],
            head: [["Gamma", "3", "Waiting"]],
            plain: "Gamma\t3\tWaiting",
        });
        await clickTableControl(page, firstCells.nth(2), "row");
        await expect.poll(() => copyTableControlSelection(page)).toMatchObject({
            defaultPrevented: false,
            plain: "",
            types: [],
        });
        expect(pageErrors).toEqual([]);
    });

    test("copies discontinuous columns as a valid SiYuan table", async ({
        createTestDocument,
        page,
    }) => {
        const {editor} = await createTestDocument(
            "Table Discontinuous Column Selection E2E",
            [
                "| Item | Quantity | Status |",
                "| --- | ---: | --- |",
                "| Alpha | 1 | Ready |",
                "| Beta | 2 | Done |",
                "| Gamma | 3 | Waiting |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        const headerCells = table.locator("thead th");
        await clickTableControl(page, headerCells.nth(0), "column");
        await clickTableControl(page, headerCells.nth(2), "column");

        const copied = await copyTableControlSelection(page);
        expect(copied).toMatchObject({
            body: [["Alpha", "Ready"], ["Beta", "Done"], ["Gamma", "Waiting"]],
            columnCount: 2,
            defaultPrevented: true,
            hasSiyuanComment: true,
            head: [["Item", "Status"]],
            nodeType: "NodeTable",
            plain: "Item\tStatus\nAlpha\tReady\nBeta\tDone\nGamma\tWaiting",
        });
        expect(copied.types).toEqual(expect.arrayContaining(["text/html", "text/plain", "text/siyuan"]));
    });

    test("shows table control descriptions and current cell style states", async ({
        createTestDocument,
        page,
    }) => {
        const {editor} = await createTestDocument(
            "Table Control State E2E",
            [
                "| Item | Quantity | Status |",
                "| --- | ---: | --- |",
                "| Alpha | 1 | Ready |",
                "| Beta | 2 | Done |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        const firstCell = table.locator("tbody tr").first().locator("td").first();
        const secondCell = table.locator("tbody tr").last().locator("td").first();
        const labels = await page.evaluate(() => ({
            addColumn: window.siyuan.languages.insertColumnRight,
            addRow: window.siyuan.languages.insertRowBelow,
            alignRight: window.siyuan.languages.alignRight,
            cell: window.siyuan.languages.more,
            color: window.siyuan.languages.colorPrimary,
            column: window.siyuan.languages.column,
            default: window.siyuan.languages.default,
            defaultHorizontal: window.siyuan.languages.useDefaultHorizontalAlign,
            row: window.siyuan.languages.row,
        }));

        await firstCell.hover();
        for (const [type, label] of [
            ["row", labels.row],
            ["column", labels.column],
            ["cell", labels.cell],
            ["add-row", labels.addRow],
            ["add-column", labels.addColumn],
        ] as const) {
            await hoverTableControl(page, firstCell, type);
            const control = page.locator(`.protyle-table-control [data-type="${type}"]:visible`);
            await expect(control).toHaveCount(1);
            await expect(control).toHaveAttribute("type", "button");
            await expect(control).toHaveAttribute("aria-label", label);
            await expect(control).toHaveClass(/b3-tooltips/);
        }

        let menu = await openTableControlMenu(page, firstCell, "cell");
        let colorItem = getMenuItemByLabel(page, menu, labels.color);
        let colorSubmenu = colorItem.locator(":scope > .b3-menu__submenu");
        let defaultColorItem = getMenuItemByLabel(page, colorSubmenu, labels.default);
        const firstColorLabel = `${labels.color} 1`;
        let firstColorItem = getMenuItemByLabel(page, colorSubmenu, firstColorLabel);
        await expect(defaultColorItem.locator(":scope > .b3-menu__checked")).toHaveCount(1);
        await expect(firstColorItem.locator(":scope > .b3-menu__checked")).toHaveCount(0);
        await colorItem.hover();
        await expect(firstColorItem).toBeVisible();
        const firstColorItemBox = await firstColorItem.boundingBox();
        const firstColorPreviewBox = await firstColorItem.locator(".protyle-table-control__color").boundingBox();
        expect(firstColorItemBox).not.toBeNull();
        expect(firstColorPreviewBox).not.toBeNull();
        expect(firstColorPreviewBox!.y + firstColorPreviewBox!.height / 2)
            .toBeCloseTo(firstColorItemBox!.y + firstColorItemBox!.height / 2, 0);
        await requestTransaction(page, () => firstColorItem.click());

        menu = await openTableControlMenu(page, firstCell, "cell");
        colorItem = getMenuItemByLabel(page, menu, labels.color);
        colorSubmenu = colorItem.locator(":scope > .b3-menu__submenu");
        defaultColorItem = getMenuItemByLabel(page, colorSubmenu, labels.default);
        firstColorItem = getMenuItemByLabel(page, colorSubmenu, firstColorLabel);
        await expect(defaultColorItem.locator(":scope > .b3-menu__checked")).toHaveCount(0);
        await expect(firstColorItem.locator(":scope > .b3-menu__checked")).toHaveCount(1);
        const alignRightItem = getMenuItemByLabel(page, menu, labels.alignRight);
        await requestTransaction(page, () => alignRightItem.click());

        menu = await openTableControlMenu(page, firstCell, "cell");
        await expect(getMenuItemByLabel(page, menu, labels.alignRight)
            .locator(":scope > .b3-menu__checked")).toHaveCount(1);
        await expect(getMenuItemByLabel(page, menu, labels.defaultHorizontal)
            .locator(":scope > .b3-menu__checked")).toHaveCount(0);
        await expect(menu.locator(":scope > .b3-menu__items > .b3-menu__separator")).toHaveCount(4);
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();

        await clickTableControl(page, firstCell, "cell");
        await clickTableControl(page, secondCell, "cell");
        menu = await openTableControlMenu(page, secondCell, "cell");
        colorItem = getMenuItemByLabel(page, menu, labels.color);
        colorSubmenu = colorItem.locator(":scope > .b3-menu__submenu");
        await expect(colorSubmenu.locator(".b3-menu__checked")).toHaveCount(0);
        await expect(getMenuItemByLabel(page, menu, labels.alignRight)
            .locator(":scope > .b3-menu__checked")).toHaveCount(0);
        await expect(getMenuItemByLabel(page, menu, labels.defaultHorizontal)
            .locator(":scope > .b3-menu__checked")).toHaveCount(0);
    });

    test("explains disabled table actions when merged cells prevent dragging", async ({
        createTestDocument,
        page,
    }) => {
        const {editor} = await createTestDocument(
            "Table Merged Action State E2E",
            [
                "| Item | Quantity | Status |",
                "| --- | ---: | --- |",
                "| Alpha | 1 | Ready |",
                "| Beta | 2 | Done |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        const firstRowCells = table.locator("tbody tr").first().locator("td");
        await clickTableControl(page, firstRowCells.nth(0), "cell");
        await clickTableControl(page, firstRowCells.nth(1), "cell");
        let menu = await openTableControlMenu(page, firstRowCells.nth(1), "cell");
        const labels = await page.evaluate(() => ({
            cancelMerged: window.siyuan.languages.cancelMerged,
            deleteRow: window.siyuan.languages["delete-row"],
            duplicate: window.siyuan.languages.duplicate,
            merge: window.siyuan.languages.mergeCell,
        }));
        await requestTransaction(page, () => getMenuItemByLabel(page, menu, labels.merge).click());

        const mergedCell = table.locator("tbody tr").first().locator("td").first();
        await hoverTableControl(page, mergedCell, "row");
        const rowControl = getVisibleTableControl(page, "row");
        await expect(rowControl).toHaveClass(/protyle-table-control__handle--drag-disabled/);
        await expect(rowControl).toHaveCSS("cursor", "pointer");
        await hoverTableControl(page, mergedCell, "column");
        const columnControl = getVisibleTableControl(page, "column");
        await expect(columnControl).toHaveClass(/protyle-table-control__handle--drag-disabled/);
        await expect(columnControl).toHaveCSS("cursor", "pointer");

        menu = await openTableControlMenu(page, mergedCell, "row");
        const duplicateItem = getMenuItemByLabel(page, menu, labels.duplicate);
        const deleteItem = getMenuItemByLabel(page, menu, labels.deleteRow);
        await expect(duplicateItem).toBeDisabled();
        await expect(deleteItem).toBeDisabled();
        await expect(duplicateItem.locator(":scope > .b3-menu__accelerator")).toHaveText(labels.cancelMerged);
        await expect(deleteItem.locator(":scope > .b3-menu__accelerator")).toHaveText(labels.cancelMerged);
        await expect(menu.locator(":scope > .b3-menu__items > .b3-menu__separator")).toHaveCount(3);
    });

    test("clears discontinuously selected cells and persists the result", async ({
        createTestDocument,
        page,
    }) => {
        const {docID, editor} = await createTestDocument(
            "Table Discontinuous Cell Selection E2E",
            [
                "| Item | Quantity | Status |",
                "| --- | ---: | --- |",
                "| Alpha | 1 | Ready |",
                "| Beta | 2 | Done |",
            ].join("\n"),
        );
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        const alpha = table.locator("tbody tr").nth(0).locator("td").nth(0);
        const done = table.locator("tbody tr").nth(1).locator("td").nth(2);
        await clickTableControl(page, alpha, "cell");
        await clickTableControl(page, done, "cell");

        await done.hover();
        await getVisibleTableControl(page, "cell").click({button: "right"});
        const menu = page.locator("#commonMenu:not(.fn__none)");
        await expect(menu).toBeVisible();
        const clearLabel = await page.evaluate(() => window.siyuan.languages.clear);
        const clearItem = menu.locator(".b3-menu__item", {
            has: page.locator(".b3-menu__label", {hasText: clearLabel}),
        }).first();
        await expect(clearItem).toBeVisible();
        await requestTransaction(page, () => clearItem.click());

        const clearedState = {
            body: [["", "1", "Ready"], ["Beta", "2", ""]],
            duplicateIDs: 0,
            head: [["Item", "Quantity", "Status"]],
        };
        await expect.poll(() => getDOMTableState(table)).toEqual(clearedState);
        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, docID);
        await expect.poll(() => getDOMTableState(
            reloadedEditor.locator(':scope > [data-type="NodeTable"]'),
        ), {timeout: 30000}).toEqual(clearedState);
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
