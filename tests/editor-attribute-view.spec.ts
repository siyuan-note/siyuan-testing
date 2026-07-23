import {BrowserContext, Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

interface ISyNode {
    AttributeViewID?: string;
    AttributeViewType?: string;
    Children?: ISyNode[];
    ID?: string;
    Properties?: Record<string, string>;
    Type?: string;
}

interface IAttributeViewKey {
    id: string;
    name: string;
    type: string;
}

interface IAttributeViewKeyValue {
    key: IAttributeViewKey;
    values?: IAttributeViewValue[];
}

interface IAttributeViewValue {
    block?: {content: string};
    blockID: string;
    checkbox?: {checked: boolean};
    number?: {content: number; isNotEmpty: boolean};
    text?: {content: string};
    type: string;
}

interface IAttributeView {
    id: string;
    keyValues: IAttributeViewKeyValue[];
    name: string;
    viewID: string;
    views: Array<{
        filters?: Array<{
            column?: string;
            filters?: unknown[];
            operator?: string;
        }>;
        group?: {
            field: string;
            hideEmpty: boolean;
            method: number;
            order: number;
        };
        id: string;
        itemIds?: string[];
        name: string;
        pageSize?: number;
        sorts?: Array<{
            column: string;
            order: string;
        }>;
        type: string;
    }>;
}

const flattenNodes = (node: ISyNode): ISyNode[] => [
    node,
    ...(node.Children || []).flatMap(flattenNodes),
];

const readValidDocument = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyNode>(docID);
    const nodes = flattenNodes(document);
    const ids = nodes.flatMap(node => node.ID ? [node.ID] : []);
    expect(ids.length - new Set(ids).size).toBe(0);
    expect(nodes.filter(node => node.ID && node.Properties?.id && node.ID !== node.Properties.id)).toHaveLength(0);
    return document;
};

const focusAtEnd = async (block: Locator) => {
    const editable = block.locator('[contenteditable="true"]').first();
    await expect(editable).toBeVisible();
    await editable.click();
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

const waitForResponse = (page: Page, path: string) => page.waitForResponse(response =>
    new URL(response.url()).pathname === path, {timeout: 15000});

const requestTransaction = async (page: Page, action: () => Promise<void>) => {
    const response = waitForResponse(page, "/api/transactions");
    await action();
    await response;
};

const requestHistoryAction = async (page: Page, block: Locator, shortcut: "Control+Z" | "Control+Y",
                                     action: "undo" | "redo") => {
    const response = waitForResponse(page, `/api/transactions/${action}`);
    await block.locator(".av__title").click();
    await page.keyboard.press(shortcut);
    await response;
};

const allowClipboard = async (context: BrowserContext, baseURL: string | undefined) => {
    if (!baseURL) {
        throw new Error("playwright.config.ts must define use.baseURL");
    }
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(baseURL).origin,
    });
};

const getAttributeView = async (api: SiyuanAPI, avID: string) => {
    const data = await api.post<{av: IAttributeView}>("/api/av/getAttributeView", {id: avID});
    return data.av;
};

const getOrderedBlockContents = async (api: SiyuanAPI, avID: string) => {
    const attributeView = await getAttributeView(api, avID);
    const view = attributeView.views.find(item => item.id === attributeView.viewID);
    const blockKeyValues = attributeView.keyValues.find(item => item.key.type === "block");
    const values = new Map(blockKeyValues?.values?.map(value => [value.blockID, value.block?.content || ""]));
    return {
        contents: (view?.itemIds || []).map(itemID => values.get(itemID) || ""),
        itemIds: view?.itemIds || [],
        pageSize: view?.pageSize,
    };
};

const expectPersistedAttributeView = async (api: SiyuanAPI, docID: string, blockID: string, avID: string) => {
    await expect.poll(async () => {
        const document = await readValidDocument(api, docID);
        const node = flattenNodes(document).find(item => item.ID === blockID);
        return node && {
            attributeViewID: node.AttributeViewID,
            attributeViewType: node.AttributeViewType,
            id: node.Properties?.id,
            type: node.Type,
        };
    }, {timeout: 30000}).toEqual({
        attributeViewID: avID,
        attributeViewType: "table",
        id: blockID,
        type: "NodeAttributeView",
    });

    const stored = await api.readWorkspaceFile<IAttributeView>(`/data/storage/av/${avID}.json`);
    expect(stored.id).toBe(avID);
    expect(stored.keyValues.length).toBeGreaterThan(0);
    expect(stored.keyValues[0].key.type).toBe("block");
    expect(stored.views.some(view => view.id === stored.viewID && view.type === "table")).toBe(true);
    return stored;
};

const expectRenderedAttributeView = async (block: Locator, stored: IAttributeView) => {
    await expect(block.locator(".av__container")).toBeVisible({timeout: 15000});
    await expect(block.locator(".av__title")).toHaveAttribute("data-title", stored.name);
    const headers = await block.locator(".av__row--header .av__cell--header").evaluateAll(elements =>
        elements.map(element => ({
            id: element.getAttribute("data-col-id") || "",
            name: element.querySelector(".av__celltext")?.textContent || "",
            type: element.getAttribute("data-dtype") || "",
        })));
    expect(headers).toEqual(stored.keyValues.map(item => ({
        id: item.key.id,
        name: item.key.name,
        type: item.key.type,
    })));
};

const insertAttributeView = async (page: Page, editor: Locator) => {
    const protyle = editor.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle ')][1]",
    );
    const documentTitle = protyle.locator(".protyle-title__input");
    await expect.poll(() => documentTitle.evaluate(element => element === document.activeElement), {
        timeout: 15000,
    }).toBe(true);
    const paragraph = editor.locator(':scope > [data-type="NodeParagraph"]').first();
    await focusAtEnd(paragraph);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("/database", {delay: 10});

    const hint = protyle.locator(".protyle-hint:not(.fn__none)");
    const databaseOption = hint.locator('button[data-id="database"]').first();
    await expect(databaseOption).toBeVisible({timeout: 15000});

    const transaction = waitForResponse(page, "/api/transactions");
    const render = waitForResponse(page, "/api/av/renderAttributeView");
    await databaseOption.click();
    await Promise.all([transaction, render]);

    const block = editor.locator(':scope > [data-type="NodeAttributeView"]');
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute("data-av-type", "table");
    const blockID = await block.getAttribute("data-node-id");
    const avID = await block.getAttribute("data-av-id");
    expect(blockID).toBeTruthy();
    expect(avID).toBeTruthy();
    return {avID: avID!, block, blockID: blockID!};
};

const addColumn = async (page: Page, block: Locator, type: string, name: string) => {
    const oldCount = await block.locator(".av__row--header .av__cell--header").count();
    await block.locator('[data-type="av-header-add"]').click();
    const menu = page.locator('#commonMenu[data-name="av-header-add"]:not(.fn__none)');
    await expect(menu).toBeVisible();
    await requestTransaction(page, () => menu.locator(`[data-id="${type}"]`).click());
    const headers = block.locator(".av__row--header .av__cell--header");
    await expect(headers).toHaveCount(oldCount + 1);
    const header = headers.last();
    await expect(header).toHaveAttribute("data-dtype", type);
    const id = await header.getAttribute("data-col-id");
    expect(id).toBeTruthy();
    const editPanel = page.locator(".av__panel");
    const nameInput = editPanel.locator('[data-type="name"]');
    await expect(nameInput).toBeVisible({timeout: 15000});
    await nameInput.fill(name);
    await requestTransaction(page, () => nameInput.press("Enter"));
    await expect(header.locator(".av__celltext")).toHaveText(name);
    return {header, id: id!};
};

const editCell = async (page: Page, cell: Locator, value: string) => {
    await cell.scrollIntoViewIfNeeded();
    await expect(cell).toBeVisible({timeout: 15000});
    await cell.click();
    const input = page.locator(".av__mask .b3-text-field");
    await expect(input).toBeVisible();
    await input.fill(value);
    await requestTransaction(page, () => input.press("Enter"));
};

const addRow = async (page: Page, block: Locator, content: string) => {
    const rows = block.locator(
        ".av__body .av__row:not(.av__row--header):not(.av__row--util):not([data-type=ghost])",
    );
    const oldCount = await rows.count();
    await requestTransaction(page, () => block.locator('[data-type="av-add-bottom"]').click());
    await expect(rows).toHaveCount(oldCount + 1);
    const row = rows.last();
    const rowID = await row.getAttribute("data-id");
    expect(rowID).toBeTruthy();
    const input = page.locator(".av__mask .b3-text-field");
    try {
        await input.waitFor({state: "visible", timeout: 2000});
    } catch {
        await row.locator('[data-dtype="block"]').evaluate(element => (element as HTMLElement).click());
    }
    await expect(input).toBeVisible({timeout: 15000});
    await input.fill(content);
    await requestTransaction(page, () => input.press("Enter"));
    return {id: rowID!, row: block.locator(`.av__row[data-id="${rowID}"]`)};
};

const openAttributeViewConfig = async (page: Page, block: Locator) => {
    await block.locator('[data-type="av-more"]').click();
    const panel = page.locator(".av__panel .b3-menu");
    await expect(panel).toBeVisible({timeout: 15000});
    return panel;
};

const expectRowOrder = async (block: Locator, ids: string[]) => {
    await expect.poll(() => block.locator(
        ".av__body .av__row:not(.av__row--header):not(.av__row--util):not([data-type=ghost])",
    ).evaluateAll(rows => rows.map(row => row.getAttribute("data-id"))), {timeout: 30000}).toEqual(ids);
};

test.describe("attribute views", () => {
    test("creates a table database and restores it after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Lifecycle E2E", "Database seed");
        const inserted = await insertAttributeView(page, document.editor);
        let block = inserted.block;

        const stored = await expectPersistedAttributeView(
            siyuanAPI, document.docID, inserted.blockID, inserted.avID,
        );
        const apiAttributeView = await getAttributeView(siyuanAPI, inserted.avID);
        expect(apiAttributeView).toEqual(stored);
        await expectRenderedAttributeView(block, stored);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        block = reloadedEditor.locator(`:scope > [data-node-id="${inserted.blockID}"]`);
        await expect(block).toHaveAttribute("data-type", "NodeAttributeView");
        await expect(block).toHaveAttribute("data-av-id", inserted.avID);
        await expectRenderedAttributeView(block, stored);
        expect(await getAttributeView(siyuanAPI, inserted.avID)).toEqual(stored);
    });

    test("edits the database name, fields, row, and common cell values", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Editing E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const databaseName = `Project tracker ${Date.now()}`;
        const title = block.locator(".av__title");
        await requestTransaction(page, () => title.fill(databaseName));
        await expect(title).toHaveText(databaseName);

        await requestTransaction(page, () => block.locator('[data-type="av-add-bottom"]').click());
        const row = block.locator(".av__body .av__row:not(.av__row--header):not([data-type=ghost])").first();
        await expect(row).toBeVisible({timeout: 15000});
        const rowID = await row.getAttribute("data-id");
        expect(rowID).toBeTruthy();
        const dataRow = block.locator(`.av__body .av__row[data-id="${rowID}"]`);
        const primaryColumnID = await block.locator('.av__row--header [data-dtype="block"]')
            .getAttribute("data-col-id");
        expect(primaryColumnID).toBeTruthy();
        const newRowInput = page.locator(".av__mask .b3-text-field");
        await expect(newRowInput).toBeVisible();
        await newRowInput.fill("First item");
        await requestTransaction(page, () => newRowInput.press("Enter"));

        const textColumn = await addColumn(page, block, "text", "Notes");
        const numberColumn = await addColumn(page, block, "number", "Estimate");
        const checkboxColumn = await addColumn(page, block, "checkbox", "Done");

        await editCell(page, dataRow.locator(`[data-col-id="${textColumn.id}"]`), "Ready for review");
        await editCell(page, dataRow.locator(`[data-col-id="${numberColumn.id}"]`), "13.5");
        const checkboxCell = dataRow.locator(`[data-col-id="${checkboxColumn.id}"]`);
        await requestTransaction(page, () => checkboxCell.click());
        await expect(checkboxCell).toHaveClass(/av__cell-check/);

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const values = Object.fromEntries(av.keyValues.map(item => [item.key.name,
                item.values?.find(value => value.blockID === rowID)]));
            return {
                databaseName: av.name,
                done: values.Done?.checkbox?.checked,
                estimate: values.Estimate?.number?.content,
                item: values[av.keyValues[0].key.name]?.block?.content,
                notes: values.Notes?.text?.content,
                rowIncluded: av.views.find(view => view.id === av.viewID)?.itemIds?.includes(rowID!),
            };
        }, {timeout: 30000}).toEqual({
            databaseName,
            done: true,
            estimate: 13.5,
            item: "First item",
            notes: "Ready for review",
            rowIncluded: true,
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-av-id="${avID}"]`);
        await expect(reloadedBlock.locator(".av__title")).toHaveText(databaseName);
        const reloadedRow = reloadedBlock.locator(`.av__row[data-id="${rowID}"]`);
        await expect(reloadedRow.locator(`[data-col-id="${primaryColumnID}"]`)).toContainText("First item");
        await expect(reloadedRow.locator(`[data-col-id="${textColumn.id}"]`)).toContainText("Ready for review");
        await expect(reloadedRow.locator(`[data-col-id="${numberColumn.id}"]`)).toContainText("13.5");
        await expect(reloadedRow.locator(`[data-col-id="${checkboxColumn.id}"]`)).toHaveClass(/av__cell-check/);
    });

    test("deletes a field and row with undo and redo", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View History E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        await requestTransaction(page, () => block.locator('[data-type="av-add-bottom"]').click());
        const row = block.locator(".av__body .av__row:not(.av__row--header):not([data-type=ghost])").first();
        await expect(row).toBeVisible({timeout: 15000});
        const rowID = await row.getAttribute("data-id");
        expect(rowID).toBeTruthy();
        const newRowInput = page.locator(".av__mask .b3-text-field");
        await expect(newRowInput).toBeVisible();
        await newRowInput.fill("History item");
        await requestTransaction(page, () => newRowInput.press("Enter"));

        const textColumn = await addColumn(page, block, "text", "Temporary");

        await textColumn.header.click();
        const columnMenu = page.locator('#commonMenu[data-name="av-header-cell"]:not(.fn__none)');
        await expect(columnMenu).toBeVisible();
        await requestTransaction(page, () => columnMenu.locator('[data-id="delete"]').click());
        await expect(block.locator(`[data-col-id="${textColumn.id}"]`)).toHaveCount(0);
        await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).keyValues
            .some(item => item.key.id === textColumn.id), {timeout: 30000}).toBe(false);

        await requestHistoryAction(page, block, "Control+Z", "undo");
        await expect(block.locator(`.av__row--header [data-col-id="${textColumn.id}"]`)).toHaveCount(1);
        await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).keyValues
            .some(item => item.key.id === textColumn.id), {timeout: 30000}).toBe(true);

        await requestHistoryAction(page, block, "Control+Y", "redo");
        await expect(block.locator(`[data-col-id="${textColumn.id}"]`)).toHaveCount(0);
        await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).keyValues
            .some(item => item.key.id === textColumn.id), {timeout: 30000}).toBe(false);

        await row.locator(".av__firstcol").click();
        await expect(row).toHaveClass(/av__row--select/);
        await requestTransaction(page, () => page.keyboard.press("Backspace"));
        await expect(block.locator(`.av__row[data-id="${rowID}"]`)).toHaveCount(0);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === av.viewID)?.itemIds?.includes(rowID!) ?? false;
        }, {timeout: 30000}).toBe(false);

        await requestHistoryAction(page, block, "Control+Z", "undo");
        const restoredRows = block.locator(
            ".av__body .av__row:not(.av__row--header):not(.av__row--util):not([data-type=ghost])",
        );
        await expect(restoredRows).toHaveCount(1);
        const restoredRowID = await restoredRows.first().getAttribute("data-id");
        expect(restoredRowID).toBeTruthy();
        expect(restoredRowID).not.toBe(rowID);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === av.viewID)?.itemIds?.includes(restoredRowID!) ?? false;
        }, {timeout: 30000}).toBe(true);

        await requestHistoryAction(page, block, "Control+Y", "redo");
        await expect(restoredRows).toHaveCount(0);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === av.viewID)?.itemIds?.length || 0;
        }, {timeout: 30000}).toBe(0);
        const final = await expectPersistedAttributeView(
            siyuanAPI, document.docID, await block.getAttribute("data-node-id") || "", avID,
        );
        expect(final.keyValues.some(item => item.key.id === textColumn.id)).toBe(false);
        expect(final.views.find(view => view.id === final.viewID)?.itemIds?.includes(rowID!) ?? false).toBe(false);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-av-id="${avID}"]`);
        await expect(reloadedBlock.locator(`[data-col-id="${textColumn.id}"]`)).toHaveCount(0);
        await expect(reloadedBlock.locator(
            ".av__body .av__row:not(.av__row--header):not(.av__row--util)",
        )).toHaveCount(0);
    });

    test("restores database values from attribute view history", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Rollback E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const row = await addRow(page, block, "History row");
        const textColumn = await addColumn(page, block, "text", "Recoverable");
        const cell = row.row.locator(`[data-col-id="${textColumn.id}"]`);
        await editCell(page, cell, "Original history value");
        await expect.poll(async () => {
            const value = (await getAttributeView(siyuanAPI, avID)).keyValues
                .find(item => item.key.id === textColumn.id)?.values
                ?.find(item => item.blockID === row.id);
            return value?.text?.content;
        }, {timeout: 30000}).toBe("Original history value");

        await siyuanAPI.createDocumentHistory(document.docID);
        let snapshotPath = "";
        await expect.poll(async () => {
            const history = await siyuanAPI.searchHistory("", "", "update", 4);
            for (const created of history.histories) {
                const items = await siyuanAPI.getHistoryItems("", created, "update", 4);
                const snapshot = items.find(item => item.path.endsWith(`/storage/av/${avID}.json`));
                if (snapshot) {
                    snapshotPath = snapshot.path;
                    return snapshot;
                }
            }
            return undefined;
        }, {timeout: 15000}).toMatchObject({op: "update", title: avID});

        await editCell(page, cell, "Changed history value");
        await expect.poll(async () => {
            const value = (await getAttributeView(siyuanAPI, avID)).keyValues
                .find(item => item.key.id === textColumn.id)?.values
                ?.find(item => item.blockID === row.id);
            return value?.text?.content;
        }, {timeout: 30000}).toBe("Changed history value");

        await siyuanAPI.rollbackAttributeViewHistory(snapshotPath);
        await expect.poll(async () => {
            const value = (await getAttributeView(siyuanAPI, avID)).keyValues
                .find(item => item.key.id === textColumn.id)?.values
                ?.find(item => item.blockID === row.id);
            return value?.text?.content;
        }, {timeout: 30000}).toBe("Original history value");

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedCell = reloadedEditor.locator(
            `:scope > [data-av-id="${avID}"] .av__row[data-id="${row.id}"] [data-col-id="${textColumn.id}"]`,
        );
        await expect(reloadedCell).toContainText("Original history value");
        await expect(reloadedCell).not.toContainText("Changed history value");
    });

    test("sorts and filters rows and restores the rules after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Sort Filter E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const charlie = await addRow(page, block, "Charlie");
        const alpha = await addRow(page, block, "Alpha");
        const bravo = await addRow(page, block, "Bravo");
        const primaryColumnID = await block.locator('.av__row--header [data-dtype="block"]')
            .getAttribute("data-col-id");
        expect(primaryColumnID).toBeTruthy();
        const primaryColumnName = await block.locator(
            '.av__row--header [data-dtype="block"] .av__celltext',
        ).innerText();

        await block.locator('[data-type="av-sort"]').click();
        const sortPanel = page.locator(".av__panel .b3-menu");
        await expect(sortPanel).toBeVisible({timeout: 15000});
        await sortPanel.locator('[data-type="addSort"]').click();
        const sortMenu = page.locator('#commonMenu[data-name="av-add-sort"]:not(.fn__none)');
        await expect(sortMenu).toBeVisible();
        await requestTransaction(page, () => sortMenu.locator(".b3-menu__item").filter({
            hasText: primaryColumnName,
        }).click());
        await expectRowOrder(block, [alpha.id, bravo.id, charlie.id]);

        const orderSelect = sortPanel.locator(`.b3-menu__item[data-id="${primaryColumnID}"] select`).last();
        await requestTransaction(page, async () => {
            await orderSelect.selectOption("DESC");
        });
        await expectRowOrder(block, [charlie.id, bravo.id, alpha.id]);

        await sortPanel.locator('[data-type="go-config"]').click();
        await sortPanel.locator('[data-type="goFilters"]').click();
        await sortPanel.locator('[data-type="addFilterCondition"]').click();
        const conditionMenu = page.locator('#commonMenu[data-name="addFilterCondition"]:not(.fn__none)');
        await expect(conditionMenu).toBeVisible();
        await conditionMenu.locator(".b3-menu__item").first().click();
        const filterMenu = page.locator('#commonMenu[data-name="av-add-filter"]:not(.fn__none)');
        await expect(filterMenu).toBeVisible();
        await requestTransaction(page, () => filterMenu.locator(".b3-menu__item").filter({
            hasText: primaryColumnName,
        }).click());
        const filterInput = sortPanel.locator('.av__filter-row[data-column] [data-type="filterValue"]');
        await expect(filterInput).toBeVisible();
        await filterInput.fill("Bravo");
        await requestTransaction(page, () => filterInput.press("Enter"));
        await expectRowOrder(block, [bravo.id]);

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const view = av.views.find(item => item.id === av.viewID);
            const rootFilter = view?.filters?.[0] as {filters?: Array<{column?: string; operator?: string}>};
            return {
                filter: rootFilter?.filters?.map(item => ({column: item.column, operator: item.operator})),
                sorts: view?.sorts,
            };
        }, {timeout: 30000}).toEqual({
            filter: [{column: primaryColumnID, operator: "Contains"}],
            sorts: [{column: primaryColumnID, order: "DESC"}],
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-av-id="${avID}"]`);
        await expect(reloadedBlock.locator('[data-type="av-sort"]')).toHaveClass(/block__icon--active/);
        await expect(reloadedBlock.locator('[data-type="av-filter"]')).toHaveClass(/block__icon--active/);
        await expectRowOrder(reloadedBlock, [bravo.id]);
    });

    test("groups rows and switches table, gallery, and kanban layouts", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Group Layout E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        await addRow(page, block, "First group item");
        await addRow(page, block, "Second group item");
        const checkboxColumn = await addColumn(page, block, "checkbox", "Done");
        const rows = block.locator(
            ".av__body .av__row:not(.av__row--header):not(.av__row--util):not([data-type=ghost])",
        );
        await requestTransaction(page, () => rows.first().locator(`[data-col-id="${checkboxColumn.id}"]`).click());

        const panel = await openAttributeViewConfig(page, block);
        await panel.locator('[data-type="goGroups"]').click();
        await Promise.all([
            waitForResponse(page, "/api/av/setAttrViewGroup"),
            panel.locator(`[data-type="setGroupMethod"][data-id="${checkboxColumn.id}"]`).click(),
        ]);
        await expect(block.locator(".av__body[data-group-id]")).toHaveCount(2, {timeout: 30000});
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(item => item.id === av.viewID)?.group;
        }, {timeout: 30000}).toMatchObject({field: checkboxColumn.id, hideEmpty: true, method: 0, order: 2});

        await panel.locator('[data-type="go-config"]').click();
        await panel.locator('[data-type="go-layout"]').click();
        await Promise.all([
            waitForResponse(page, "/api/av/changeAttrViewLayout"),
            panel.locator('[data-type="set-layout"][data-view-type="gallery"]').click(),
        ]);
        await expect(block).toHaveAttribute("data-av-type", "gallery");
        await expect(block.locator(".av__gallery")).toHaveCount(2);
        await expect(block.locator(".av__gallery").first()).toBeVisible();

        await Promise.all([
            waitForResponse(page, "/api/av/changeAttrViewLayout"),
            panel.locator('[data-type="set-layout"][data-view-type="kanban"]').click(),
        ]);
        await expect(block).toHaveAttribute("data-av-type", "kanban");
        await expect(block.locator(".av__kanban")).toBeVisible();
        await expect(block.locator(".av__kanban-group")).toHaveCount(2);

        await Promise.all([
            waitForResponse(page, "/api/av/changeAttrViewLayout"),
            panel.locator('[data-type="set-layout"][data-view-type="table"]').click(),
        ]);
        await expect(block).toHaveAttribute("data-av-type", "table");
        await expect(block.locator(".av__row--header").first()).toBeVisible();
        await expect(block.locator(".av__body[data-group-id]")).toHaveCount(2);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-av-id="${avID}"]`);
        await expect(reloadedBlock).toHaveAttribute("data-av-type", "table");
        await expect(reloadedBlock.locator(".av__body[data-group-id]")).toHaveCount(2);
    });

    test("pastes beyond existing rows while the database uses virtual scrolling", async ({
        baseURL,
        context,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Virtual Paste E2E", "Database seed");
        const {avID, blockID} = await insertAttributeView(page, document.editor);
        await expectPersistedAttributeView(siyuanAPI, document.docID, blockID, avID);
        const blockKey = (await getAttributeView(siyuanAPI, avID)).keyValues.find(item => item.key.type === "block");
        expect(blockKey).toBeTruthy();

        const seedContents = Array.from({length: 120}, (_, index) => `Seed ${index.toString().padStart(3, "0")}`);
        await siyuanAPI.post("/api/av/appendAttributeViewDetachedBlocksWithValues", {
            avID,
            blocksValues: seedContents.map(content => [{
                block: {content},
                keyID: blockKey!.key.id,
            }]),
        });
        await expect.poll(() => getOrderedBlockContents(siyuanAPI, avID), {timeout: 30000}).toMatchObject({
            contents: seedContents,
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-av-id="${avID}"]`);
        const pageSizeButton = reloadedBlock.locator('.av__row--util [data-type="set-page-size"]');
        await expect(pageSizeButton).toBeVisible({timeout: 15000});
        await pageSizeButton.click();
        const pageSizeMenu = page.locator('#commonMenu[data-name="av-page-size"]:not(.fn__none)');
        await expect(pageSizeMenu).toBeVisible();
        await requestTransaction(page, () => pageSizeMenu.locator(".b3-menu__item").last().click());

        await expect(reloadedBlock).toHaveAttribute("data-v-scroll", "true", {timeout: 30000});
        await expect(reloadedBlock.locator(
            ".av__body .av__row:not(.av__row--header):not(.av__row--util):not([data-type=ghost])",
        )).toHaveCount(100);
        await expect.poll(() => getOrderedBlockContents(siyuanAPI, avID), {timeout: 30000}).toMatchObject({
            pageSize: 102400,
        });

        await allowClipboard(context, baseURL);
        const pasteContents = Array.from({length: 130}, (_, index) =>
            `Pasted ${index.toString().padStart(3, "0")}`);
        const firstCell = reloadedBlock.locator(".av__body .av__row[data-id] [data-dtype=block]").first();
        await firstCell.click();
        await page.keyboard.press("Escape");
        await expect(firstCell).toHaveClass(/av__cell--select/);
        await page.evaluate(text => navigator.clipboard.writeText(text), pasteContents.join("\n"));

        const pasteRowsResponse = waitForResponse(page, "/api/av/getAttributeViewPasteRows");
        const pasteTransaction = waitForResponse(page, "/api/transactions");
        await page.keyboard.press("Control+V");
        await Promise.all([pasteRowsResponse, pasteTransaction]);
        await expect.poll(() => getOrderedBlockContents(siyuanAPI, avID), {timeout: 30000}).toMatchObject({
            contents: pasteContents,
        });
        expect((await getOrderedBlockContents(siyuanAPI, avID)).itemIds).toHaveLength(130);

        await requestHistoryAction(page, reloadedBlock, "Control+Z", "undo");
        await expect.poll(() => getOrderedBlockContents(siyuanAPI, avID), {timeout: 30000}).toMatchObject({
            contents: seedContents,
        });
        expect((await getOrderedBlockContents(siyuanAPI, avID)).itemIds).toHaveLength(120);
    });

    test("preserves boundary values in a wider multi-row table", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Boundary E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const rowNames = [
            "Item 00",
            "Item 01",
            "Item 02",
            "Item 03",
            "Item 04",
            "Item 05",
            "Item 06",
            "Item 07",
            "Item 08",
            "Item 09",
            "Item 10",
            '中文 🚀 <tag> & "quotes"',
        ];
        const rows: Array<Awaited<ReturnType<typeof addRow>>> = [];
        for (const name of rowNames) {
            rows.push(await addRow(page, block, name));
        }
        expect(new Set(rows.map(row => row.id)).size).toBe(rowNames.length);

        const textColumn = await addColumn(page, block, "text", "Long notes");
        const numberColumn = await addColumn(page, block, "number", "Signed decimal");
        const checkboxColumn = await addColumn(page, block, "checkbox", "Boundary done");
        const longText = `开始 🚀 ${"0123456789abcdef".repeat(64)} 结束`;
        await editCell(page, rows[0].row.locator(`[data-col-id="${textColumn.id}"]`), longText);
        await editCell(page, rows.at(-1)!.row.locator(`[data-col-id="${numberColumn.id}"]`), "-123456789.125");
        const checkedCell = rows[6].row.locator(`[data-col-id="${checkboxColumn.id}"]`);
        await requestTransaction(page, () => checkedCell.click());

        await expect(block.locator(
            ".av__body .av__row:not(.av__row--header):not(.av__row--util):not([data-type=ghost])",
        )).toHaveCount(rowNames.length);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const values = Object.fromEntries(av.keyValues.map(item => [item.key.name, item.values]));
            return {
                checked: values["Boundary done"]?.find(value => value.blockID === rows[6].id)?.checkbox?.checked,
                itemIds: av.views.find(view => view.id === av.viewID)?.itemIds,
                longText: values["Long notes"]?.find(value => value.blockID === rows[0].id)?.text?.content,
                number: values["Signed decimal"]?.find(value => value.blockID === rows.at(-1)!.id)?.number?.content,
                specialName: values[av.keyValues[0].key.name]
                    ?.find(value => value.blockID === rows.at(-1)!.id)?.block?.content,
            };
        }, {timeout: 30000}).toEqual({
            checked: true,
            itemIds: rows.map(row => row.id),
            longText,
            number: -123456789.125,
            specialName: rowNames.at(-1),
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-av-id="${avID}"]`);
        await expect(reloadedBlock.locator(
            ".av__body .av__row:not(.av__row--header):not(.av__row--util):not([data-type=ghost])",
        )).toHaveCount(rowNames.length);
        await expect(reloadedBlock.locator(`.av__row[data-id="${rows[0].id}"] ` +
            `[data-col-id="${textColumn.id}"]`)).toContainText(longText);
        await expect(reloadedBlock.locator(`.av__row[data-id="${rows.at(-1)!.id}"] ` +
            `[data-col-id="${numberColumn.id}"]`)).toContainText("-123456789.125");
        await expect(reloadedBlock.locator(`.av__row[data-id="${rows[6].id}"] ` +
            `[data-col-id="${checkboxColumn.id}"]`)).toHaveClass(/av__cell-check/);
    });
});
