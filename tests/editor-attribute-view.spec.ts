import {BrowserContext, JSHandle, Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

const AV_RENDER_TIMEOUT = 15000;

interface ISyNode {
    AttributeViewID?: string;
    AttributeViewType?: string;
    Children?: ISyNode[];
    ID?: string;
    Properties?: Record<string, string>;
    Type?: string;
}

interface IAttributeViewKey {
    created?: {includeTime: boolean};
    id: string;
    name: string;
    numberFormat?: string;
    options?: Array<{
        color: string;
        name: string;
    }>;
    relation?: {
        avID: string;
        backKeyID: string;
        isTwoWay: boolean;
    };
    rollup?: {
        calc?: {
            operator: string;
            result?: unknown;
        };
        keyID: string;
        relationKeyID: string;
    };
    template?: string;
    type: string;
    updated?: {includeTime: boolean};
}

interface IAttributeViewKeyValue {
    key: IAttributeViewKey;
    values?: IAttributeViewValue[];
}

interface IAttributeViewValue {
    block?: {content: string; id?: string};
    blockID: string;
    checkbox?: {checked: boolean};
    date?: {
        content?: number;
        content2?: number;
        hasEndDate?: boolean;
        isNotEmpty?: boolean;
        isNotEmpty2?: boolean;
        isNotTime?: boolean;
    };
    email?: {content: string};
    isDetached?: boolean;
    mAsset?: Array<{
        content: string;
        name: string;
        type: "file" | "image";
    }>;
    mSelect?: Array<{
        color: string;
        content: string;
    }>;
    number?: {content: number; isNotEmpty: boolean};
    phone?: {content: string};
    relation?: {blockIDs: string[]};
    rollup?: {contents: IAttributeViewValue[]};
    template?: {content: string};
    text?: {content: string};
    type: string;
    url?: {content: string};
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

const waitForResponse = (page: Page, path: string, timeout = 15000) => page.waitForResponse(response =>
    new URL(response.url()).pathname === path, {timeout});

const waitForTransactionAction = (page: Page, action: string, timeout = 30000) => page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== "/api/transactions") {
        return false;
    }
    const payload = response.request().postDataJSON() as {
        transactions?: Array<{
            doOperations?: Array<{action?: string}>;
        }>;
    };
    return payload.transactions?.some(transaction =>
        transaction.doOperations?.some(operation => operation.action === action)) || false;
}, {timeout});

const requestTransaction = async (page: Page, action: () => Promise<void>) => {
    const response = waitForResponse(page, "/api/transactions");
    await action();
    await response;
};

const requestTransactionAndRender = async (page: Page, action: () => Promise<void>) => {
    const transaction = waitForResponse(page, "/api/transactions");
    const render = waitForResponse(page, "/api/av/renderAttributeView", 30000);
    await action();
    await Promise.all([transaction, render]);
};

const requestHistoryAction = async (page: Page, block: Locator, shortcut: string,
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
    await page.keyboard.press("ControlOrMeta+A");
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

const addColumn = async (page: Page, block: Locator, type: string, name: string, menuID = type) => {
    const headers = block.locator(".av__row--header .av__cell--header");
    const oldCount = await headers.count();
    const menu = page.locator('#commonMenu[data-name="av-header-add"]:not(.fn__none)');
    const transaction = waitForResponse(page, "/api/transactions", 30000);
    await expect(async () => {
        if (await menu.isVisible()) {
            await page.keyboard.press("Escape");
            await expect(menu).toBeHidden();
        }
        await expect(block).not.toHaveAttribute("data-rendering", "true");
        await block.locator('[data-type="av-header-add"]').click();
        await expect(menu).toBeVisible({timeout: 2000});
        await menu.locator(`[data-id="${menuID}"]`).click({force: true});
        await expect(headers).toHaveCount(oldCount + 1, {timeout: 2000});
    }).toPass({timeout: 30000});
    const response = await transaction;
    const payload = response.request().postDataJSON() as {
        transactions: Array<{
            doOperations: Array<{
                action: string;
                id?: string;
                type?: string;
            }>;
        }>;
    };
    const operation = payload.transactions.flatMap(item => item.doOperations)
        .find(item => item.action === "addAttrViewCol" && item.type === type);
    const id = operation?.id;
    expect(id).toBeTruthy();
    const header = block.locator(
        `.av__row--header .av__cell--header[data-col-id="${id}"]`,
    );
    await expect(header).toHaveAttribute("data-dtype", type);
    const editPanel = page.locator(".av__panel");
    const nameInput = editPanel.locator('[data-type="name"]');
    await expect(nameInput).toBeVisible({timeout: 15000});
    await nameInput.fill(name);
    await requestTransaction(page, () => nameInput.press("Enter"));
    await expect(header.locator(".av__celltext")).toHaveText(name);
    return {header, id: id!};
};

const addRelationColumn = async (page: Page, block: Locator, targetAvID: string, name: string) => {
    const oldCount = await block.locator(".av__row--header .av__cell--header").count();
    await block.locator('[data-type="av-header-add"]').click();
    const menu = page.locator('#commonMenu[data-name="av-header-add"]:not(.fn__none)');
    await expect(menu).toBeVisible();
    await requestTransaction(page, () => menu.locator('[data-id="relation"]').click({force: true}));

    const headers = block.locator(".av__row--header .av__cell--header");
    await expect(headers).toHaveCount(oldCount + 1, {timeout: AV_RENDER_TIMEOUT});
    const header = headers.last();
    await expect(header).toHaveAttribute("data-dtype", "relation");
    const id = await header.getAttribute("data-col-id");
    expect(id).toBeTruthy();

    const editPanel = page.locator(".av__panel");
    await expect(editPanel.locator('[data-type="name"]')).toBeVisible({timeout: 15000});
    await editPanel.locator('[data-type="name"]').fill(name);
    const targetPicker = editPanel.locator('[data-type="goSearchAV"]');
    await targetPicker.click();

    const searchMenu = page.locator("#commonMenu:not(.fn__none)");
    const target = searchMenu.locator(`[data-av-id="${targetAvID}"]`).first();
    await expect(target).toBeVisible({timeout: 15000});
    await target.click();
    await expect(targetPicker).toHaveAttribute("data-av-id", targetAvID);

    const confirm = editPanel.locator('[data-type="updateRelation"]');
    await expect(confirm).toBeVisible();
    await requestTransaction(page, () => confirm.click());
    await expect(editPanel).toBeHidden();
    await expect(header.locator(".av__celltext")).toHaveText(name);
    return {header, id: id!};
};

const configureRollupColumn = async (page: Page, cell: Locator, relationColumnID: string,
                                     targetColumnID: string, operator: "Sum" | "Unique values") => {
    await expect(async () => {
        await expect(cell).toBeVisible();
        await cell.click();
        await expect(page.locator(".av__panel [data-type=\"goSearchRollupCol\"]"))
            .toBeVisible({timeout: 2000});
    }).toPass({timeout: 30000});

    const panel = page.locator(".av__panel");
    await panel.locator('[data-type="goSearchRollupCol"]').click();
    let menu = page.locator("#commonMenu:not(.fn__none)");
    let option = menu.locator(`.b3-list-item[data-col-id="${relationColumnID}"]`);
    await expect(option).toBeVisible({timeout: 15000});
    await requestTransaction(page, () => option.click());

    const targetPicker = panel.locator('[data-type="goSearchRollupTarget"]');
    await expect(targetPicker).toHaveAttribute("data-av-id", /.+/);
    await targetPicker.click();
    menu = page.locator("#commonMenu:not(.fn__none)");
    option = menu.locator(`.b3-list-item[data-col-id="${targetColumnID}"]`);
    await expect(option).toBeVisible({timeout: 15000});
    await requestTransaction(page, () => option.click());

    const label = await page.evaluate(value => value === "Sum"
        ? window.siyuan.languages.calcOperatorSum
        : window.siyuan.languages.uniqueValues, operator);
    await panel.locator('[data-type="goSearchRollupCalc"]').click();
    menu = page.locator("#commonMenu:not(.fn__none)");
    const calcOption = menu.locator(".b3-menu__item").filter({
        has: page.locator(".b3-menu__label", {hasText: label}),
    });
    await expect(calcOption).toBeVisible({timeout: 15000});
    await requestTransaction(page, () => calcOption.click());

    await panel.locator('[data-type="close"]').click({position: {x: 5, y: 5}});
    await expect(panel).toHaveCount(0);
};

const editCell = async (page: Page, cell: Locator, value: string) => {
    const input = page.locator(".av__mask .b3-text-field:visible");
    const block = cell.locator(
        "xpath=ancestor::*[@data-type='NodeAttributeView'][1]",
    );
    await expect(async () => {
        await expect(cell).toBeVisible();
        await expect(block).not.toHaveAttribute("data-rendering", "true");
        await cell.click();
        await expect(input).toBeVisible({timeout: 2000});
    }).toPass({timeout: 30000});
    await input.fill(value);
    await requestTransaction(page, () => input.press("Enter"));
    await expect(input).toHaveCount(0);
};

const setNumberFormat = async (page: Page, header: Locator,
                               format: "commas" | "percent" | "USD") => {
    const panel = page.locator(".av__panel");
    await expect(async () => {
        await expect(header).toBeVisible();
        await header.click();
        const headerMenu = page.locator('#commonMenu[data-name="av-header-cell"]:not(.fn__none)');
        await expect(headerMenu).toBeVisible({timeout: 2000});
        await headerMenu.locator('[data-id="edit"]').click();
        await expect(panel.locator('[data-type="numberFormat"]')).toBeVisible({timeout: 2000});
    }).toPass({timeout: AV_RENDER_TIMEOUT});
    await panel.locator('[data-type="numberFormat"]').click();

    const menu = page.locator('#commonMenu[data-name="av-col-format-number"]:not(.fn__none)');
    await expect(menu).toBeVisible();
    const label = await page.evaluate(value => {
        if (value === "commas") {
            return window.siyuan.languages.numberFormatCommas;
        }
        if (value === "percent") {
            return window.siyuan.languages.numberFormatPercent;
        }
        return window.siyuan.languages.numberFormatUSD;
    }, format);
    const option = menu.locator(".b3-menu__item").filter({
        has: page.locator(".b3-menu__label", {hasText: label}),
    });
    await expect(option).toBeVisible();
    await requestTransaction(page, () => option.click());
    await expect(panel).toHaveCount(0);
};

const editSelectCell = async (page: Page, cell: Locator, values: string[]) => {
    const input = page.locator(".av__panel .b3-chips input:visible");
    const block = cell.locator(
        "xpath=ancestor::*[@data-type='NodeAttributeView'][1]",
    );
    await expect(async () => {
        await expect(cell).toBeVisible();
        await expect(block).not.toHaveAttribute("data-rendering", "true");
        await cell.click();
        await expect(input).toBeVisible({timeout: 2000});
    }).toPass({timeout: 30000});
    const type = await cell.getAttribute("data-dtype");
    for (const value of values) {
        await input.fill(value);
        if (type === "select") {
            await requestTransactionAndRender(page, () => input.press("Enter"));
        } else {
            await requestTransaction(page, () => input.press("Enter"));
        }
    }
    await expect(cell.locator(".b3-chip")).toHaveText(values);
    await expect(block).not.toHaveAttribute("data-rendering", "true", {timeout: 30000});
    if (await input.count() > 0) {
        await expect(async () => {
            const panel = input.locator(
                "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' av__panel ')][1]",
            );
            await panel.locator('.b3-dialog__scrim[data-type="close"]').click({force: true});
            await expect(input).toHaveCount(0, {timeout: 1000});
        }).toPass({timeout: AV_RENDER_TIMEOUT});
    }
};

const openSelectCellPanel = async (page: Page, cell: Locator) => {
    const panel = page.locator(".av__panel");
    await expect(async () => {
        await expect(cell).toBeVisible();
        await cell.click();
        await expect(panel.locator(".b3-chips input")).toBeVisible({timeout: 2000});
    }).toPass({timeout: AV_RENDER_TIMEOUT});
    return panel;
};

const renameSelectOption = async (page: Page, panel: Locator, oldName: string, newName: string) => {
    const renamedOption = panel.locator(
        `[data-type="addColOptionOrCell"][data-name="${newName}"]`,
    );
    await expect(async () => {
        if (await renamedOption.isVisible()) {
            return;
        }
        const option = panel.locator(`[data-type="addColOptionOrCell"][data-name="${oldName}"]`);
        await expect(option).toBeVisible();
        await option.locator('[data-type="setColOption"]').click();
        const menu = page.locator('#commonMenu[data-name="av-col-option"]:not(.fn__none)');
        const input = menu.locator("input.b3-text-field").first();
        await expect(input).toBeVisible();
        await input.fill(newName);
        const transaction = waitForResponse(page, "/api/transactions", 5000);
        await input.press("Enter");
        await transaction;
        await expect(menu).toBeHidden();
        await expect(renamedOption).toBeVisible();
    }).toPass({timeout: 30000});
};

const sortSelectOptionBefore = async (page: Page, panel: Locator, sourceName: string, targetName: string) => {
    const source = panel.locator(`[data-type="addColOptionOrCell"][data-name="${sourceName}"]`);
    const target = panel.locator(`[data-type="addColOptionOrCell"][data-name="${targetName}"]`);
    await expect(source).toBeVisible();
    await expect(target).toBeVisible();
    const targetBox = await target.boundingBox();
    expect(targetBox).not.toBeNull();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer()) as JSHandle<DataTransfer>;
    await source.dispatchEvent("dragstart", {dataTransfer});
    const point = {
        clientX: targetBox!.x + Math.min(8, targetBox!.width / 2),
        clientY: targetBox!.y + 2,
    };
    await target.dispatchEvent("dragenter", {dataTransfer, ...point});
    await target.dispatchEvent("dragover", {dataTransfer, ...point});
    await target.dispatchEvent("dragover", {dataTransfer, ...point});
    await expect(target).toHaveClass(/dragover__top/);
    await requestTransaction(page, () => target.dispatchEvent("drop", {dataTransfer, ...point}));
    await dataTransfer.dispose();
};

const deleteSelectOption = async (page: Page, panel: Locator, name: string) => {
    const option = panel.locator(`[data-type="addColOptionOrCell"][data-name="${name}"]`);
    await expect(option).toBeVisible();
    await option.locator('[data-type="setColOption"]').click();
    const menu = page.locator('#commonMenu[data-name="av-col-option"]:not(.fn__none)');
    const deleteAction = menu.locator('[data-id="delete"]');
    await expect(deleteAction).toBeVisible();
    await deleteAction.click();
    const confirm = page.locator("#confirmDialogConfirmBtn:visible");
    await expect(confirm).toBeVisible();
    await requestTransaction(page, () => confirm.click());
    await expect(panel.locator(
        `[data-type="addColOptionOrCell"][data-name="${name}"]`,
    )).toHaveCount(0);
};

const editDateCell = async (page: Page, cell: Locator) => {
    const input = page.locator(".av__panel input.b3-text-field:visible").first();
    const block = cell.locator(
        "xpath=ancestor::*[@data-type='NodeAttributeView'][1]",
    );
    await expect(async () => {
        await expect(cell).toBeVisible();
        await expect(block).not.toHaveAttribute("data-rendering", "true");
        await cell.click();
        await expect(input).toBeVisible({timeout: 2000});
    }).toPass({timeout: 30000});
    const inputType = await input.getAttribute("type");
    expect(["date", "datetime-local"]).toContain(inputType);
    const isNotTime = inputType === "date";
    const value = isNotTime ? "2026-08-17" : "2026-08-17T14:30";
    const display = isNotTime ? "2026-08-17" : "2026-08-17 14:30";
    await input.fill(value);
    await requestTransaction(page, () => input.press("Enter"));
    await expect(input).toHaveCount(0);
    return {display, isNotTime};
};

const setTimedDateRange = async (page: Page, cell: Locator, start: string, end: string) => {
    const panel = page.locator(".av__panel");
    await expect(async () => {
        await expect(cell).toBeVisible();
        await cell.click();
        await expect(panel.locator("input.b3-text-field").first()).toBeVisible({timeout: 2000});
    }).toPass({timeout: AV_RENDER_TIMEOUT});

    const dateInputs = panel.locator("input.b3-text-field");
    const toggles = panel.locator('input[type="checkbox"]');
    const endDateToggle = toggles.nth(0);
    const includeTimeToggle = toggles.nth(1);
    if (!await includeTimeToggle.isChecked()) {
        await includeTimeToggle.click();
    }
    await expect(dateInputs.first()).toHaveAttribute("type", "datetime-local");
    if (!await endDateToggle.isChecked()) {
        await endDateToggle.click();
    }
    const endInput = dateInputs.nth(1);
    await expect(endInput).toBeVisible();
    await dateInputs.first().fill(start);
    await endInput.fill(end);
    const transaction = waitForResponse(page, "/api/transactions", 30000);
    await endInput.press("Enter");
    await transaction;
    await expect(panel).toHaveCount(0);
};

const editTemplateCell = async (page: Page, cell: Locator, template: string) => {
    const input = page.locator(".av__mask .b3-text-field:visible");
    const block = cell.locator(
        "xpath=ancestor::*[@data-type='NodeAttributeView'][1]",
    );
    const initialRender = waitForResponse(page, "/api/av/renderAttributeView", 30000);
    await expect(async () => {
        await expect(cell).toBeVisible();
        await expect(block).not.toHaveAttribute("data-rendering", "true");
        await cell.click();
        await expect(input).toBeVisible({timeout: 2000});
    }).toPass({timeout: 30000});
    await initialRender;
    await expect(input).toHaveAttribute("data-template", "");
    await input.fill(template);
    await requestTransaction(page, () => input.press("Enter"));
    await expect(input).toHaveCount(0);
};

const uploadAssetCell = async (page: Page, cell: Locator, file: {
    buffer: Buffer;
    mimeType: string;
    name: string;
}) => {
    const panelMenu = page.locator(".av__panel .b3-menu").filter({
        has: page.locator('[data-type="addAssetExist"]'),
    }).last();
    const uploadInput = panelMenu.locator('input[type="file"]');
    const block = cell.locator(
        "xpath=ancestor::*[@data-type='NodeAttributeView'][1]",
    );
    await expect(async () => {
        await expect(cell).toBeVisible();
        await expect(block).not.toHaveAttribute("data-rendering", "true");
        await cell.click();
        await expect(panelMenu.locator('[data-type="addAssetExist"]')).toBeVisible({timeout: 2000});
        await expect(uploadInput).toBeAttached();
    }).toPass({timeout: AV_RENDER_TIMEOUT});

    const uploadResponse = waitForResponse(page, "/upload", 30000);
    const transactionResponse = waitForResponse(page, "/api/transactions", 30000);
    await uploadInput.setInputFiles(file);
    const response = await uploadResponse;
    await transactionResponse;
    const payload = await response.json() as {
        code: number;
        data: {succMap: Record<string, string>};
    };
    expect(payload.code).toBe(0);
    const assetPath = payload.data.succMap[file.name];
    expect(assetPath).toBeTruthy();
    return assetPath;
};

const addRow = async (page: Page, block: Locator, content: string) => {
    const rows = block.locator(
        ".av__body .av__row:not(.av__row--header):not(.av__row--util):not([data-type=ghost])",
    );
    const oldCount = await rows.count();
    await requestTransaction(page, () => block.locator('[data-type="av-add-bottom"]').click());
    await expect(rows).toHaveCount(oldCount + 1, {timeout: AV_RENDER_TIMEOUT});
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

const addAttributeViewView = async (page: Page, block: Locator, layout: "gallery" | "kanban" | "table") => {
    await block.locator('[data-type="av-add"]').click();
    const menu = page.locator("#commonMenu:not(.fn__none)");
    await expect(menu).toBeVisible();
    const label = await page.evaluate(value => window.siyuan.languages[value], layout);
    const transaction = waitForTransactionAction(page, "addAttrViewView");
    await menu.locator(".b3-menu__item").filter({
        has: page.locator(".b3-menu__label", {hasText: label}),
    }).click();
    const response = await transaction;
    const payload = response.request().postDataJSON() as {
        transactions: Array<{
            doOperations: Array<{
                action: string;
                id?: string;
                layout?: string;
            }>;
        }>;
    };
    const operation = payload.transactions.flatMap(item => item.doOperations)
        .find(item => item.action === "addAttrViewView");
    expect(operation?.id).toBeTruthy();
    const panel = page.locator(".av__panel");
    if (await panel.count() > 0) {
        await panel.locator('[data-type="close"]').click({position: {x: 5, y: 5}});
        await expect(panel).toHaveCount(0);
    }
    return operation!.id!;
};

const openFocusedViewMenu = async (page: Page, block: Locator) => {
    await block.locator(".av__views .layout-tab-bar .item--focus").click();
    const menu = page.locator('#commonMenu[data-name="av-view"]:not(.fn__none)');
    await expect(menu).toBeVisible();
    return menu;
};

const duplicateFocusedView = async (page: Page, block: Locator) => {
    const menu = await openFocusedViewMenu(page, block);
    const transaction = waitForTransactionAction(page, "duplicateAttrViewView");
    await menu.locator('[data-id="duplicate"]').click();
    const response = await transaction;
    const payload = response.request().postDataJSON() as {
        transactions: Array<{
            doOperations: Array<{
                action: string;
                id?: string;
            }>;
        }>;
    };
    const operation = payload.transactions.flatMap(item => item.doOperations)
        .find(item => item.action === "duplicateAttrViewView");
    expect(operation?.id).toBeTruthy();
    return operation!.id!;
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

    test("creates, renames, duplicates, switches, and deletes views", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Views E2E", "Database seed");
        const inserted = await insertAttributeView(page, document.editor);
        const {avID, blockID} = inserted;
        let block = inserted.block;
        const initial = await getAttributeView(siyuanAPI, avID);
        const initialViewID = initial.viewID;
        expect(initial.views).toHaveLength(1);
        expect(initial.views[0].type).toBe("table");
        const switchView = async (viewID: string, layout: "gallery" | "table") => {
            await requestTransaction(page, () => block.locator(
                `.av__views .layout-tab-bar .item[data-id="${viewID}"]`,
            ).click());
            await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).viewID, {
                timeout: 30000,
            }).toBe(viewID);
            await page.reload();
            const editor = await getDocumentEditor(page, document.docID);
            block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
            await expect(block.locator(
                `.av__views .layout-tab-bar .item[data-id="${viewID}"]`,
            )).toHaveClass(/item--focus/);
            await expect(block).toHaveAttribute("data-av-type", layout);
        };

        const galleryViewID = await addAttributeViewView(page, block, "gallery");
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return {
                current: av.viewID,
                type: av.views.find(view => view.id === galleryViewID)?.type,
                viewIDs: av.views.map(view => view.id),
            };
        }, {timeout: 30000}).toEqual({
            current: galleryViewID,
            type: "gallery",
            viewIDs: [initialViewID, galleryViewID],
        });
        await page.reload();
        const galleryEditor = await getDocumentEditor(page, document.docID);
        block = galleryEditor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator(
            `.av__views .layout-tab-bar .item[data-id="${galleryViewID}"]`,
        )).toHaveClass(/item--focus/);
        await expect(block).toHaveAttribute("data-av-type", "gallery");
        const galleryName = `Gallery workflow ${Date.now()}`;
        let menu = await openFocusedViewMenu(page, block);
        await menu.locator('[data-id="rename"]').click();
        const panel = page.locator(".av__panel");
        const nameInput = panel.locator('.b3-text-field[data-type="name"]');
        await expect(nameInput).toBeVisible();
        await nameInput.fill(galleryName);
        await requestTransaction(page, () => nameInput.press("Enter"));
        await expect(panel).toHaveCount(0);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === galleryViewID)?.name;
        }, {timeout: 30000}).toBe(galleryName);
        await page.reload();
        const renamedEditor = await getDocumentEditor(page, document.docID);
        block = renamedEditor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator(
            `.av__views .layout-tab-bar .item[data-id="${galleryViewID}"] .item__text`,
        )).toHaveText(galleryName);

        const duplicateViewID = await duplicateFocusedView(page, block);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const source = av.views.find(view => view.id === galleryViewID);
            const duplicate = av.views.find(view => view.id === duplicateViewID);
            return {
                current: av.viewID,
                duplicateType: duplicate?.type,
                sourceName: source?.name,
                viewIDs: av.views.map(view => view.id),
            };
        }, {timeout: 30000}).toEqual({
            current: duplicateViewID,
            duplicateType: "gallery",
            sourceName: galleryName,
            viewIDs: [initialViewID, galleryViewID, duplicateViewID],
        });
        await page.reload();
        const duplicateEditor = await getDocumentEditor(page, document.docID);
        block = duplicateEditor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator(
            `.av__views .layout-tab-bar .item[data-id="${duplicateViewID}"]`,
        )).toHaveClass(/item--focus/);
        await expect(block).toHaveAttribute("data-av-type", "gallery");

        await switchView(initialViewID, "table");
        await switchView(galleryViewID, "gallery");
        menu = await openFocusedViewMenu(page, block);
        await requestTransaction(page, () => menu.locator('[data-id="delete"]').click());
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return {
                current: av.viewID,
                viewIDs: av.views.map(view => view.id),
            };
        }, {timeout: 30000}).toEqual({
            current: initialViewID,
            viewIDs: [initialViewID, duplicateViewID],
        });
        await page.reload();
        const firstDeleteEditor = await getDocumentEditor(page, document.docID);
        block = firstDeleteEditor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator(
            `.av__views .layout-tab-bar .item[data-id="${galleryViewID}"]`,
        )).toHaveCount(0);
        await expect(block.locator(
            `.av__views .layout-tab-bar .item[data-id="${initialViewID}"]`,
        )).toHaveClass(/item--focus/);
        await expect(block).toHaveAttribute("data-av-type", "table");

        await switchView(duplicateViewID, "gallery");
        menu = await openFocusedViewMenu(page, block);
        await requestTransaction(page, () => menu.locator('[data-id="delete"]').click());
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return {
                current: av.viewID,
                viewIDs: av.views.map(view => view.id),
            };
        }, {timeout: 30000}).toEqual({
            current: initialViewID,
            viewIDs: [initialViewID],
        });
        await page.reload();
        const secondDeleteEditor = await getDocumentEditor(page, document.docID);
        block = secondDeleteEditor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator(".av__views .layout-tab-bar .item")).toHaveCount(1);
        await expect(block.locator(
            `.av__views .layout-tab-bar .item[data-id="${initialViewID}"]`,
        )).toHaveClass(/item--focus/);

        menu = await openFocusedViewMenu(page, block);
        await expect(menu.locator('[data-id="delete"]')).toHaveCount(0);
        await page.keyboard.press("Escape");

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return {
                current: av.viewID,
                views: av.views.map(view => ({id: view.id, type: view.type})),
            };
        }, {timeout: 30000}).toEqual({
            current: initialViewID,
            views: [{id: initialViewID, type: "table"}],
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(reloadedBlock).toHaveAttribute("data-av-type", "table");
        await expect(reloadedBlock.locator(".av__views .layout-tab-bar .item")).toHaveCount(1);
        await expect(reloadedBlock.locator(
            `.av__views .layout-tab-bar .item[data-id="${initialViewID}"]`,
        )).toHaveClass(/item--focus/);
        await expectPersistedAttributeView(siyuanAPI, document.docID, blockID, avID);
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

    test("formats, clears, and restores numeric values", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Number Format E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const negativeRow = await addRow(page, block, "Negative amount");
        const zeroRow = await addRow(page, block, "Zero amount");
        const column = await addColumn(page, block, "number", "Amount");
        let rendered = {
            header: column.header,
            negativeCell: negativeRow.row.locator(`[data-col-id="${column.id}"]`),
            zeroCell: zeroRow.row.locator(`[data-col-id="${column.id}"]`),
        };
        await editCell(page, rendered.negativeCell, "-1234567.126");
        await editCell(page, rendered.zeroCell, "0");

        const readNumberState = async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const keyValues = av.keyValues.find(item => item.key.id === column.id);
            const values = new Map(keyValues?.values?.map(value => [value.blockID, value.number && {
                content: value.number.content,
                isNotEmpty: value.number.isNotEmpty,
            }]));
            return {
                format: keyValues?.key.numberFormat,
                negative: values.get(negativeRow.id),
                zero: values.get(zeroRow.id),
            };
        };
        const reloadNumberCells = async () => {
            await page.reload();
            const editor = await getDocumentEditor(page, document.docID);
            const reloadedBlock = editor.locator(`:scope > [data-av-id="${avID}"]`);
            return {
                header: reloadedBlock.locator(
                    `.av__row--header .av__cell--header[data-col-id="${column.id}"]`,
                ),
                negativeCell: reloadedBlock.locator(
                    `.av__row[data-id="${negativeRow.id}"] [data-col-id="${column.id}"]`,
                ),
                zeroCell: reloadedBlock.locator(
                    `.av__row[data-id="${zeroRow.id}"] [data-col-id="${column.id}"]`,
                ),
            };
        };
        await expect.poll(readNumberState, {timeout: 30000}).toEqual({
            format: "",
            negative: {
                content: -1234567.126,
                isNotEmpty: true,
            },
            zero: {
                content: 0,
                isNotEmpty: true,
            },
        });

        await setNumberFormat(page, rendered.header, "commas");
        await expect.poll(readNumberState, {timeout: 30000}).toMatchObject({format: "commas"});
        rendered = await reloadNumberCells();
        await expect(rendered.negativeCell.locator(".av__celltext")).toHaveText("-1,234,567.126");
        await expect(rendered.zeroCell.locator(".av__celltext")).toHaveText("0");

        await setNumberFormat(page, rendered.header, "percent");
        await expect.poll(readNumberState, {timeout: 30000}).toMatchObject({format: "percent"});
        rendered = await reloadNumberCells();
        await expect(rendered.negativeCell.locator(".av__celltext")).toHaveText("-123456712.6%");
        await expect(rendered.zeroCell.locator(".av__celltext")).toHaveText("0%");

        await setNumberFormat(page, rendered.header, "USD");
        await expect.poll(readNumberState, {timeout: 30000}).toMatchObject({format: "USD"});
        rendered = await reloadNumberCells();
        await expect(rendered.negativeCell.locator(".av__celltext")).toHaveText("$-1,234,567.13");
        await expect(rendered.zeroCell.locator(".av__celltext")).toHaveText("$0.00");

        await editCell(page, rendered.negativeCell, "");
        await expect(rendered.negativeCell.locator(".av__celltext")).toHaveText("");
        await expect.poll(readNumberState, {timeout: 30000}).toMatchObject({
            format: "USD",
            negative: {
                isNotEmpty: false,
            },
            zero: {
                content: 0,
                isNotEmpty: true,
            },
        });

        await editCell(page, rendered.negativeCell, "42.5");
        await expect(rendered.negativeCell.locator(".av__celltext")).toHaveText("$42.50");
        await expect.poll(readNumberState, {timeout: 30000}).toEqual({
            format: "USD",
            negative: {
                content: 42.5,
                isNotEmpty: true,
            },
            zero: {
                content: 0,
                isNotEmpty: true,
            },
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-av-id="${avID}"]`);
        await expect(reloadedBlock.locator(
            `.av__row[data-id="${negativeRow.id}"] [data-col-id="${column.id}"] .av__celltext`,
        )).toHaveText("$42.50");
        await expect(reloadedBlock.locator(
            `.av__row[data-id="${zeroRow.id}"] [data-col-id="${column.id}"] .av__celltext`,
        )).toHaveText("$0.00");
    });

    test("edits select, multi-select, and date values and restores them after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Special Fields E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const row = await addRow(page, block, "Special field item");
        const selectColumn = await addColumn(page, block, "select", "Status");
        const multiSelectColumn = await addColumn(page, block, "mSelect", "Labels", "multiSelect");
        const dateColumn = await addColumn(page, block, "date", "Due date");

        const selectCell = row.row.locator(`[data-col-id="${selectColumn.id}"]`);
        const multiSelectCell = row.row.locator(`[data-col-id="${multiSelectColumn.id}"]`);
        const dateCell = row.row.locator(`[data-col-id="${dateColumn.id}"]`);
        await editSelectCell(page, selectCell, ["Ready"]);
        await editSelectCell(page, multiSelectCell, ["Frontend", "Urgent"]);
        const date = await editDateCell(page, dateCell);

        await expect(selectCell.locator(".b3-chip")).toHaveText(["Ready"]);
        await expect(multiSelectCell.locator(".b3-chip")).toHaveText(["Frontend", "Urgent"]);
        await expect(dateCell).toContainText(date.display);

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const fields = Object.fromEntries(av.keyValues.map(item => [item.key.name, item]));
            const selectValue = fields.Status?.values?.find(value => value.blockID === row.id);
            const multiSelectValue = fields.Labels?.values?.find(value => value.blockID === row.id);
            const dateValue = fields["Due date"]?.values?.find(value => value.blockID === row.id);
            return {
                dateContentPresent: typeof dateValue?.date?.content === "number" &&
                    dateValue.date.content > 0,
                dateIsNotEmpty: dateValue?.date?.isNotEmpty,
                dateIsNotTime: dateValue?.date?.isNotTime,
                dateType: dateValue?.type,
                multiSelectColorsPresent: multiSelectValue?.mSelect?.every(item => Boolean(item.color)),
                multiSelectOptions: fields.Labels?.key.options?.map(item => item.name),
                multiSelectType: multiSelectValue?.type,
                multiSelectValues: multiSelectValue?.mSelect?.map(item => item.content),
                selectColorsPresent: selectValue?.mSelect?.every(item => Boolean(item.color)),
                selectOptions: fields.Status?.key.options?.map(item => item.name),
                selectType: selectValue?.type,
                selectValues: selectValue?.mSelect?.map(item => item.content),
            };
        }, {timeout: 30000}).toEqual({
            dateContentPresent: true,
            dateIsNotEmpty: true,
            dateIsNotTime: date.isNotTime,
            dateType: "date",
            multiSelectColorsPresent: true,
            multiSelectOptions: ["Frontend", "Urgent"],
            multiSelectType: "mSelect",
            multiSelectValues: ["Frontend", "Urgent"],
            selectColorsPresent: true,
            selectOptions: ["Ready"],
            selectType: "select",
            selectValues: ["Ready"],
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedRow = reloadedEditor.locator(
            `:scope > [data-av-id="${avID}"] .av__row[data-id="${row.id}"]`,
        );
        await expect(reloadedRow.locator(`[data-col-id="${selectColumn.id}"] .b3-chip`))
            .toHaveText(["Ready"]);
        await expect(reloadedRow.locator(`[data-col-id="${multiSelectColumn.id}"] .b3-chip`))
            .toHaveText(["Frontend", "Urgent"]);
        await expect(reloadedRow.locator(`[data-col-id="${dateColumn.id}"]`)).toContainText(date.display);
    });

    test("sets, clears, and restores a timed date range", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Date Range E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const row = await addRow(page, block, "Scheduled item");
        const column = await addColumn(page, block, "date", "Schedule");
        const cell = row.row.locator(`[data-col-id="${column.id}"]`);
        const firstRange = {
            end: "2026-09-18T17:45",
            start: "2026-09-14T09:15",
        };
        const firstTimestamps = await page.evaluate(range => ({
            end: new Date(range.end).getTime(),
            start: new Date(range.start).getTime(),
        }), firstRange);
        await setTimedDateRange(page, cell, firstRange.start, firstRange.end);
        await expect(cell.locator(".av__celltext")).toContainText("2026-09-14 09:15");
        await expect(cell.locator(".av__celltext")).toContainText("2026-09-18 17:45");

        const readDateValue = async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const value = av.keyValues.find(item => item.key.id === column.id)
                ?.values?.find(item => item.blockID === row.id);
            return {
                content: value?.date?.content ?? null,
                content2: value?.date?.content2 ?? null,
                hasEndDate: value?.date?.hasEndDate ?? false,
                isNotEmpty: value?.date?.isNotEmpty ?? false,
                isNotEmpty2: value?.date?.isNotEmpty2 ?? false,
                isNotTime: value?.date?.isNotTime ?? true,
                type: value?.type,
            };
        };
        await expect.poll(readDateValue, {timeout: 30000}).toEqual({
            content: firstTimestamps.start,
            content2: firstTimestamps.end,
            hasEndDate: true,
            isNotEmpty: true,
            isNotEmpty2: true,
            isNotTime: false,
            type: "date",
        });

        await cell.click();
        let panel = page.locator(".av__panel");
        await expect(panel.locator('[data-type="clearDate"]')).toBeVisible();
        await requestTransaction(page, () => panel.locator('[data-type="clearDate"]').click());
        await expect(panel).toHaveCount(0);
        await expect(cell.locator(".av__celltext")).toHaveText("");
        await expect.poll(readDateValue, {timeout: 30000}).toMatchObject({
            hasEndDate: false,
            isNotEmpty: false,
            isNotEmpty2: false,
            isNotTime: true,
            type: "date",
        });

        const finalRange = {
            end: "2026-10-23T16:40",
            start: "2026-10-21T08:05",
        };
        const finalTimestamps = await page.evaluate(range => ({
            end: new Date(range.end).getTime(),
            start: new Date(range.start).getTime(),
        }), finalRange);
        await setTimedDateRange(page, cell, finalRange.start, finalRange.end);
        await expect.poll(readDateValue, {timeout: 30000}).toEqual({
            content: finalTimestamps.start,
            content2: finalTimestamps.end,
            hasEndDate: true,
            isNotEmpty: true,
            isNotEmpty2: true,
            isNotTime: false,
            type: "date",
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedCell = reloadedEditor.locator(
            `:scope > [data-av-id="${avID}"] .av__row[data-id="${row.id}"] ` +
            `[data-col-id="${column.id}"]`,
        );
        await expect(reloadedCell.locator(".av__celltext")).toContainText("2026-10-21 08:05");
        await expect(reloadedCell.locator(".av__celltext")).toContainText("2026-10-23 16:40");
        await expect(reloadedCell.locator(".av__celltext")).toHaveAttribute(
            "data-value", expect.stringContaining('"hasEndDate":true'),
        );
    });

    test("renames, reorders, and deletes single-select options across existing rows", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Select Options E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const first = await addRow(page, block, "First status item");
        const second = await addRow(page, block, "Second status item");
        const column = await addColumn(page, block, "select", "Status");
        const firstCell = first.row.locator(`[data-col-id="${column.id}"]`);
        const secondCell = second.row.locator(`[data-col-id="${column.id}"]`);
        await editSelectCell(page, firstCell, ["Draft"]);
        await editSelectCell(page, secondCell, ["Review"]);

        let panel = await openSelectCellPanel(page, secondCell);
        await renameSelectOption(page, panel, "Review", "Approved");
        await expect(secondCell.locator(".b3-chip")).toHaveText("Approved");
        await sortSelectOptionBefore(page, panel, "Approved", "Draft");
        expect(await panel.locator('[data-type="addColOptionOrCell"]').evaluateAll(options =>
            options.map(option => option.getAttribute("data-name")))).toEqual(["Approved", "Draft"]);
        await panel.locator('[data-type="close"]').click({position: {x: 5, y: 5}});
        await expect(panel).toHaveCount(0);

        panel = await openSelectCellPanel(page, firstCell);
        await deleteSelectOption(page, panel, "Draft");
        await expect(firstCell.locator(".b3-chip")).toHaveCount(0);
        await expect(secondCell.locator(".b3-chip")).toHaveText("Approved");
        await panel.locator('[data-type="close"]').click({position: {x: 5, y: 5}});

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const field = av.keyValues.find(item => item.key.id === column.id);
            return {
                first: field?.values?.find(value => value.blockID === first.id)?.mSelect
                    ?.map(option => option.content) || [],
                options: field?.key.options?.map(option => option.name),
                second: field?.values?.find(value => value.blockID === second.id)?.mSelect
                    ?.map(option => option.content) || [],
            };
        }, {timeout: 30000}).toEqual({
            first: [],
            options: ["Approved"],
            second: ["Approved"],
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-av-id="${avID}"]`);
        await expect(reloadedBlock.locator(
            `.av__row[data-id="${first.id}"] [data-col-id="${column.id}"] .b3-chip`,
        )).toHaveCount(0);
        await expect(reloadedBlock.locator(
            `.av__row[data-id="${second.id}"] [data-col-id="${column.id}"] .b3-chip`,
        )).toHaveText("Approved");
    });

    test("renames and deletes multi-select options across existing rows", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument(
            "Attribute View Multi Select Options E2E", "Database seed",
        );
        const {avID, block} = await insertAttributeView(page, document.editor);
        const first = await addRow(page, block, "First label item");
        const second = await addRow(page, block, "Second label item");
        const column = await addColumn(page, block, "mSelect", "Labels", "multiSelect");
        const firstCell = first.row.locator(`[data-col-id="${column.id}"]`);
        const secondCell = second.row.locator(`[data-col-id="${column.id}"]`);
        await editSelectCell(page, firstCell, ["Frontend", "Urgent"]);
        await editSelectCell(page, secondCell, ["Backend", "Urgent"]);

        let panel = await openSelectCellPanel(page, firstCell);
        await renameSelectOption(page, panel, "Urgent", "Critical");
        await expect(firstCell.locator(".b3-chip")).toHaveText(["Frontend", "Critical"]);
        await expect(secondCell.locator(".b3-chip")).toHaveText(["Backend", "Critical"]);
        await panel.locator('[data-type="close"]').click({position: {x: 5, y: 5}});

        panel = await openSelectCellPanel(page, secondCell);
        await deleteSelectOption(page, panel, "Critical");
        await expect(firstCell.locator(".b3-chip")).toHaveText(["Frontend"]);
        await expect(secondCell.locator(".b3-chip")).toHaveText(["Backend"]);
        await panel.locator('[data-type="close"]').click({position: {x: 5, y: 5}});

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const field = av.keyValues.find(item => item.key.id === column.id);
            return {
                first: field?.values?.find(value => value.blockID === first.id)?.mSelect
                    ?.map(option => option.content) || [],
                options: field?.key.options?.map(option => option.name),
                second: field?.values?.find(value => value.blockID === second.id)?.mSelect
                    ?.map(option => option.content) || [],
            };
        }, {timeout: 30000}).toEqual({
            first: ["Frontend"],
            options: ["Frontend", "Backend"],
            second: ["Backend"],
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-av-id="${avID}"]`);
        await expect(reloadedBlock.locator(
            `.av__row[data-id="${first.id}"] [data-col-id="${column.id}"] .b3-chip`,
        )).toHaveText(["Frontend"]);
        await expect(reloadedBlock.locator(
            `.av__row[data-id="${second.id}"] [data-col-id="${column.id}"] .b3-chip`,
        )).toHaveText(["Backend"]);
    });

    test("edits URL, email, and phone values and restores their link semantics after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Link Fields E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const row = await addRow(page, block, "Link field item");
        const urlColumn = await addColumn(page, block, "url", "Project URL", "link");
        const emailColumn = await addColumn(page, block, "email", "Contact email");
        const phoneColumn = await addColumn(page, block, "phone", "Contact phone");
        const suffix = Date.now().toString();
        const url = `https://example.com/projects/${suffix}?source=e2e`;
        const email = `qa+${suffix}@example.com`;
        const phone = `+1 202 555 ${suffix.slice(-4)}`;

        const urlCell = row.row.locator(`[data-col-id="${urlColumn.id}"]`);
        const emailCell = row.row.locator(`[data-col-id="${emailColumn.id}"]`);
        const phoneCell = row.row.locator(`[data-col-id="${phoneColumn.id}"]`);
        await editCell(page, urlCell, url);
        await editCell(page, emailCell, email);
        await editCell(page, phoneCell, phone);

        await expect(urlCell.locator('.av__celltext--url[data-type="url"]')).toHaveAttribute("data-href", url);
        await expect(emailCell.locator('.av__celltext--url[data-type="email"]')).toHaveText(email);
        await expect(phoneCell.locator('.av__celltext--url[data-type="phone"]')).toHaveText(phone);

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const valueFor = (keyID: string) => av.keyValues.find(item => item.key.id === keyID)
                ?.values?.find(value => value.blockID === row.id);
            const urlValue = valueFor(urlColumn.id);
            const emailValue = valueFor(emailColumn.id);
            const phoneValue = valueFor(phoneColumn.id);
            return {
                email: emailValue?.email?.content,
                emailType: emailValue?.type,
                phone: phoneValue?.phone?.content,
                phoneType: phoneValue?.type,
                url: urlValue?.url?.content,
                urlType: urlValue?.type,
            };
        }, {timeout: 30000}).toEqual({
            email,
            emailType: "email",
            phone,
            phoneType: "phone",
            url,
            urlType: "url",
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedRow = reloadedEditor.locator(
            `:scope > [data-av-id="${avID}"] .av__row[data-id="${row.id}"]`,
        );
        await expect(reloadedRow.locator(
            `[data-col-id="${urlColumn.id}"] .av__celltext--url[data-type="url"]`,
        )).toHaveAttribute("data-href", url);
        await expect(reloadedRow.locator(
            `[data-col-id="${emailColumn.id}"] .av__celltext--url[data-type="email"]`,
        )).toHaveText(email);
        await expect(reloadedRow.locator(
            `[data-col-id="${phoneColumn.id}"] .av__celltext--url[data-type="phone"]`,
        )).toHaveText(phone);
    });

    test("uploads an attachment value and restores it after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Asset Field E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const row = await addRow(page, block, "Asset field item");
        const assetColumn = await addColumn(page, block, "mAsset", "Attachments", "assets");
        const assetCell = row.row.locator(`[data-col-id="${assetColumn.id}"]`);
        const filename = `av-asset-${Date.now()}.txt`;
        const content = "Attribute view asset E2E\nsecond line";
        const assetPath = await uploadAssetCell(page, assetCell, {
            buffer: Buffer.from(content),
            mimeType: "text/plain",
            name: filename,
        });
        expect(assetPath).toMatch(/^assets\/.+\.txt$/);

        const asset = assetCell.locator('.av__celltext--url[data-url]');
        await expect(asset).toHaveText(filename);
        await expect(asset).toHaveAttribute("data-name", filename);
        await expect(asset).toHaveAttribute("data-url", assetPath);
        const workspacePath = `/data/${assetPath}`;
        expect(await siyuanAPI.readWorkspaceText(workspacePath)).toBe(content);

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const value = av.keyValues.find(item => item.key.id === assetColumn.id)
                ?.values?.find(item => item.blockID === row.id);
            return {
                assets: value?.mAsset,
                type: value?.type,
            };
        }, {timeout: 30000}).toEqual({
            assets: [{
                content: assetPath,
                name: filename,
                type: "file",
            }],
            type: "mAsset",
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedAsset = reloadedEditor.locator(
            `:scope > [data-av-id="${avID}"] .av__row[data-id="${row.id}"] ` +
            `[data-col-id="${assetColumn.id}"] .av__celltext--url[data-url="${assetPath}"]`,
        );
        await expect(reloadedAsset).toHaveText(filename);
        await expect(reloadedAsset).toHaveAttribute("data-name", filename);
        expect(await siyuanAPI.readWorkspaceText(workspacePath)).toBe(content);

        await siyuanAPI.removeWorkspaceFile(workspacePath);
    });

    test("recalculates a template field after its source value changes and restores it after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Template Field E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const row = await addRow(page, block, "Template field item");
        const notesColumn = await addColumn(page, block, "text", "Notes");
        let notesCell = row.row.locator(`[data-col-id="${notesColumn.id}"]`);
        await editCell(page, notesCell, "Initial value");

        const templateColumn = await addColumn(page, block, "template", "Summary");
        let templateCell = row.row.locator(`[data-col-id="${templateColumn.id}"]`);
        const template = "Summary: .action{.Notes}";
        await editTemplateCell(page, templateCell, template);

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const keyValue = av.keyValues.find(item => item.key.id === templateColumn.id);
            return {
                definition: keyValue?.key.template,
                type: keyValue?.key.type,
            };
        }, {timeout: 30000}).toEqual({
            definition: template,
            type: "template",
        });

        await page.reload();
        let reloadedEditor = await getDocumentEditor(page, document.docID);
        let reloadedRow = reloadedEditor.locator(
            `:scope > [data-av-id="${avID}"] .av__row[data-id="${row.id}"]`,
        );
        notesCell = reloadedRow.locator(`[data-col-id="${notesColumn.id}"]`);
        templateCell = reloadedRow.locator(`[data-col-id="${templateColumn.id}"]`);
        await expect(templateCell).toHaveText("Summary: Initial value", {timeout: 30000});

        await editCell(page, notesCell, "Updated value");
        await expect(templateCell).toHaveText("Summary: Updated value", {timeout: 30000});
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.keyValues.find(item => item.key.id === notesColumn.id)
                ?.values?.find(item => item.blockID === row.id)?.text?.content;
        }, {timeout: 30000}).toBe("Updated value");

        await page.reload();
        reloadedEditor = await getDocumentEditor(page, document.docID);
        reloadedRow = reloadedEditor.locator(
            `:scope > [data-av-id="${avID}"] .av__row[data-id="${row.id}"]`,
        );
        await expect(reloadedRow.locator(`[data-col-id="${notesColumn.id}"]`)).toHaveText("Updated value");
        await expect(reloadedRow.locator(`[data-col-id="${templateColumn.id}"]`))
            .toHaveText("Summary: Updated value");
        const stored = await getAttributeView(siyuanAPI, avID);
        expect(stored.keyValues.find(item => item.key.id === templateColumn.id)?.key.template).toBe(template);
    });

    test("updates automatic timestamps and line numbers while preserving creation time", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Automatic Fields E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const first = await addRow(page, block, "First automatic item");
        const second = await addRow(page, block, "Second automatic item");
        const notesColumn = await addColumn(page, block, "text", "Notes");
        const createdColumn = await addColumn(page, block, "created", "Created at", "createdTime");
        const updatedColumn = await addColumn(page, block, "updated", "Updated at", "updatedTime");
        const lineNumberColumn = await addColumn(page, block, "lineNumber", "Position");
        const firstCreatedCell = first.row.locator(`[data-col-id="${createdColumn.id}"]`);
        const firstUpdatedCell = first.row.locator(`[data-col-id="${updatedColumn.id}"]`);
        const firstLineCell = first.row.locator(`[data-col-id="${lineNumberColumn.id}"]`);
        const secondLineCell = second.row.locator(`[data-col-id="${lineNumberColumn.id}"]`);
        const readTimeValue = async (cell: Locator) => {
            const value = await cell.locator(".av__celltext").getAttribute("data-value");
            return value ? JSON.parse(value) as {
                content: number;
                formattedContent: string;
                isNotEmpty: boolean;
            } : undefined;
        };

        await expect.poll(async () => {
            const created = await readTimeValue(firstCreatedCell);
            const updated = await readTimeValue(firstUpdatedCell);
            return {
                created: Boolean(created?.isNotEmpty && created.content > 0 && created.formattedContent),
                firstLine: await firstLineCell.textContent(),
                secondLine: await secondLineCell.textContent(),
                updated: Boolean(updated?.isNotEmpty && updated.content > 0 && updated.formattedContent),
            };
        }, {timeout: 30000}).toEqual({
            created: true,
            firstLine: "1",
            secondLine: "2",
            updated: true,
        });
        const initialCreated = (await readTimeValue(firstCreatedCell))!;
        const initialUpdated = (await readTimeValue(firstUpdatedCell))!;

        await editCell(page, first.row.locator(`[data-col-id="${notesColumn.id}"]`), "Timestamp changed");
        await expect.poll(async () => {
            const created = await readTimeValue(firstCreatedCell);
            const updated = await readTimeValue(firstUpdatedCell);
            return {
                created: created?.content,
                updatedAdvanced: Boolean(updated && updated.content > initialUpdated.content),
            };
        }, {timeout: 30000}).toEqual({
            created: initialCreated.content,
            updatedAdvanced: true,
        });
        const finalUpdated = (await readTimeValue(firstUpdatedCell))!;

        const third = await addRow(page, block, "Third automatic item");
        const thirdLineCell = third.row.locator(`[data-col-id="${lineNumberColumn.id}"]`);
        await expect(thirdLineCell).toHaveText("3", {timeout: 30000});
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return {
                itemIds: av.views.find(view => view.id === av.viewID)?.itemIds,
                types: [createdColumn.id, updatedColumn.id, lineNumberColumn.id].map(columnID =>
                    av.keyValues.find(item => item.key.id === columnID)?.key.type),
            };
        }, {timeout: 30000}).toEqual({
            itemIds: [first.id, second.id, third.id],
            types: ["created", "updated", "lineNumber"],
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedBlock = reloadedEditor.locator(`:scope > [data-av-id="${avID}"]`);
        const reloadedFirst = reloadedBlock.locator(`.av__row[data-id="${first.id}"]`);
        const reloadedCreated = await readTimeValue(
            reloadedFirst.locator(`[data-col-id="${createdColumn.id}"]`),
        );
        const reloadedUpdated = await readTimeValue(
            reloadedFirst.locator(`[data-col-id="${updatedColumn.id}"]`),
        );
        expect(reloadedCreated?.content).toBe(initialCreated.content);
        expect(reloadedUpdated?.content).toBe(finalUpdated.content);
        await expect(reloadedFirst.locator(`[data-col-id="${lineNumberColumn.id}"]`)).toHaveText("1");
        await expect(reloadedBlock.locator(
            `.av__row[data-id="${second.id}"] [data-col-id="${lineNumberColumn.id}"]`,
        )).toHaveText("2");
        await expect(reloadedBlock.locator(
            `.av__row[data-id="${third.id}"] [data-col-id="${lineNumberColumn.id}"]`,
        )).toHaveText("3");
    });

    test("links a row through a relation field and restores it after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const sourceDocument = await createTestDocument("Attribute View Relation Source E2E", "Source seed");
        const source = await insertAttributeView(page, sourceDocument.editor);
        const sourceRow = await addRow(page, source.block, "Source item");

        const targetDocument = await createTestDocument("Attribute View Relation Target E2E", "Target seed");
        const target = await insertAttributeView(page, targetDocument.editor);
        const targetRow = await addRow(page, target.block, "Target item");

        await page.goto(`/?id=${sourceDocument.docID}`);
        const sourceEditor = await getDocumentEditor(page, sourceDocument.docID);
        const sourceBlock = sourceEditor.locator(`:scope > [data-av-id="${source.avID}"]`);
        const relationColumn = await addRelationColumn(page, sourceBlock, target.avID, "Related item");
        const relationCell = sourceBlock.locator(
            `.av__row[data-id="${sourceRow.id}"] [data-col-id="${relationColumn.id}"]`,
        );
        await relationCell.click();

        const relationPanel = page.locator(".av__panel");
        const candidate = relationPanel.locator(
            `[data-type="setRelationCell"][data-relation-type="candidate"][data-row-id="${targetRow.id}"]`,
        );
        await expect(candidate).toBeVisible({timeout: 15000});
        await requestTransaction(page, () => candidate.click());
        await expect(relationCell.locator(`.av__cell--relation[data-row-id="${targetRow.id}"]`))
            .toContainText("Target item");

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, source.avID);
            const keyValue = av.keyValues.find(item => item.key.id === relationColumn.id);
            const value = keyValue?.values?.find(item => item.blockID === sourceRow.id);
            return {
                relation: keyValue?.key.relation,
                targetIDs: value?.relation?.blockIDs,
                type: value?.type,
            };
        }, {timeout: 30000}).toEqual({
            relation: {
                avID: target.avID,
                backKeyID: expect.any(String),
                isTwoWay: false,
            },
            targetIDs: [targetRow.id],
            type: "relation",
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, sourceDocument.docID);
        const reloadedCell = reloadedEditor.locator(
            `:scope > [data-av-id="${source.avID}"] ` +
            `.av__row[data-id="${sourceRow.id}"] [data-col-id="${relationColumn.id}"]`,
        );
        await expect(reloadedCell.locator(`.av__cell--relation[data-row-id="${targetRow.id}"]`))
            .toContainText("Target item");
    });

    test("recalculates text and numeric rollups as relation values change", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const targetDocument = await createTestDocument("Attribute View Rollup Target E2E", "Target seed");
        const target = await insertAttributeView(page, targetDocument.editor);
        const firstTarget = await addRow(page, target.block, "First target");
        const secondTarget = await addRow(page, target.block, "Second target");
        const textColumn = await addColumn(page, target.block, "text", "Label");
        const numberColumn = await addColumn(page, target.block, "number", "Amount");
        await editCell(page, firstTarget.row.locator(`[data-col-id="${textColumn.id}"]`), "Alpha");
        await editCell(page, firstTarget.row.locator(`[data-col-id="${numberColumn.id}"]`), "10");
        await editCell(page, secondTarget.row.locator(`[data-col-id="${textColumn.id}"]`), "Beta");
        await editCell(page, secondTarget.row.locator(`[data-col-id="${numberColumn.id}"]`), "20");

        const sourceDocument = await createTestDocument("Attribute View Rollup Source E2E", "Source seed");
        const source = await insertAttributeView(page, sourceDocument.editor);
        const sourceRow = await addRow(page, source.block, "Source item");
        const relationColumn = await addRelationColumn(page, source.block, target.avID, "Related items");
        const relationCell = source.block.locator(
            `.av__row[data-id="${sourceRow.id}"] [data-col-id="${relationColumn.id}"]`,
        );
        await relationCell.click();
        const relationPanel = page.locator(".av__panel");
        for (const targetRow of [firstTarget, secondTarget]) {
            const candidate = relationPanel.locator(
                `[data-type="setRelationCell"][data-relation-type="candidate"]` +
                `[data-row-id="${targetRow.id}"]`,
            );
            await expect(candidate).toBeVisible({timeout: 15000});
            await requestTransaction(page, () => candidate.click());
        }
        await relationPanel.locator('[data-type="close"]').click({position: {x: 5, y: 5}});
        await expect(relationPanel).toHaveCount(0);

        const textRollup = await addColumn(page, source.block, "rollup", "Related labels");
        const numberRollup = await addColumn(page, source.block, "rollup", "Total amount");
        const sourceDataRow = source.block.locator(`.av__row[data-id="${sourceRow.id}"]`);
        const textRollupCell = sourceDataRow.locator(`[data-col-id="${textRollup.id}"]`);
        const numberRollupCell = sourceDataRow.locator(`[data-col-id="${numberRollup.id}"]`);
        await configureRollupColumn(
            page, textRollupCell, relationColumn.id, textColumn.id, "Unique values",
        );
        await configureRollupColumn(
            page, numberRollupCell, relationColumn.id, numberColumn.id, "Sum",
        );
        await expect(textRollupCell).toContainText("Alpha");
        await expect(textRollupCell).toContainText("Beta");
        await expect(numberRollupCell).toHaveText("30");

        await page.goto(`/?id=${targetDocument.docID}`);
        const targetEditor = await getDocumentEditor(page, targetDocument.docID);
        const targetBlock = targetEditor.locator(`:scope > [data-av-id="${target.avID}"]`);
        const reloadedFirstTarget = targetBlock.locator(`.av__row[data-id="${firstTarget.id}"]`);
        await editCell(
            page, reloadedFirstTarget.locator(`[data-col-id="${textColumn.id}"]`), "Alpha updated",
        );
        await editCell(
            page, reloadedFirstTarget.locator(`[data-col-id="${numberColumn.id}"]`), "15",
        );

        await page.goto(`/?id=${sourceDocument.docID}`);
        const sourceEditor = await getDocumentEditor(page, sourceDocument.docID);
        const reloadedSourceBlock = sourceEditor.locator(`:scope > [data-av-id="${source.avID}"]`);
        const reloadedSourceRow = reloadedSourceBlock.locator(`.av__row[data-id="${sourceRow.id}"]`);
        const reloadedRelationCell = reloadedSourceRow.locator(`[data-col-id="${relationColumn.id}"]`);
        const reloadedTextRollup = reloadedSourceRow.locator(`[data-col-id="${textRollup.id}"]`);
        const reloadedNumberRollup = reloadedSourceRow.locator(`[data-col-id="${numberRollup.id}"]`);
        await expect(reloadedTextRollup).toContainText("Alpha updated");
        await expect(reloadedTextRollup).toContainText("Beta");
        await expect(reloadedNumberRollup).toHaveText("35");

        await reloadedRelationCell.click();
        const selectedSecondTarget = page.locator(".av__panel").locator(
            `[data-type="setRelationCell"][data-relation-type="selected"]` +
            `[data-row-id="${secondTarget.id}"]`,
        );
        await expect(selectedSecondTarget).toBeVisible({timeout: 15000});
        await requestTransaction(page, () => selectedSecondTarget.click());
        await expect(reloadedTextRollup).toContainText("Alpha updated");
        await expect(reloadedTextRollup).not.toContainText("Beta");
        await expect(reloadedNumberRollup).toHaveText("15");

        const secondTargetCandidate = page.locator(".av__panel").locator(
            `[data-type="setRelationCell"][data-relation-type="candidate"]` +
            `[data-row-id="${secondTarget.id}"]`,
        );
        await expect(secondTargetCandidate).toBeVisible();
        await requestTransaction(page, () => secondTargetCandidate.click());
        await expect(reloadedTextRollup).toContainText("Beta");
        await expect(reloadedNumberRollup).toHaveText("35");
        await page.locator(".av__panel [data-type=\"close\"]").click({position: {x: 5, y: 5}});

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, source.avID);
            const relation = av.keyValues.find(item => item.key.id === relationColumn.id);
            const relationValue = relation?.values?.find(item => item.blockID === sourceRow.id);
            const numberRollupConfig = av.keyValues.find(
                item => item.key.id === numberRollup.id,
            )?.key.rollup;
            const textRollupConfig = av.keyValues.find(
                item => item.key.id === textRollup.id,
            )?.key.rollup;
            return {
                numberRollup: numberRollupConfig && {
                    keyID: numberRollupConfig.keyID,
                    operator: numberRollupConfig.calc?.operator,
                    relationKeyID: numberRollupConfig.relationKeyID,
                },
                relation: relation?.key.relation,
                relationIDs: relationValue?.relation?.blockIDs,
                textRollup: textRollupConfig && {
                    keyID: textRollupConfig.keyID,
                    operator: textRollupConfig.calc?.operator,
                    relationKeyID: textRollupConfig.relationKeyID,
                },
            };
        }, {timeout: 30000}).toEqual({
            numberRollup: {
                keyID: numberColumn.id,
                operator: "Sum",
                relationKeyID: relationColumn.id,
            },
            relation: {
                avID: target.avID,
                backKeyID: expect.any(String),
                isTwoWay: false,
            },
            relationIDs: [firstTarget.id, secondTarget.id],
            textRollup: {
                keyID: textColumn.id,
                operator: "Unique values",
                relationKeyID: relationColumn.id,
            },
        });

        await page.reload();
        const finalEditor = await getDocumentEditor(page, sourceDocument.docID);
        const finalRow = finalEditor.locator(
            `:scope > [data-av-id="${source.avID}"] .av__row[data-id="${sourceRow.id}"]`,
        );
        await expect(finalRow.locator(`[data-col-id="${textRollup.id}"]`))
            .toContainText("Alpha updated");
        await expect(finalRow.locator(`[data-col-id="${textRollup.id}"]`)).toContainText("Beta");
        await expect(finalRow.locator(`[data-col-id="${numberRollup.id}"]`)).toHaveText("35");
    });

    test("binds a detached primary value and exposes the rebind action", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const targetText = `Bindable database target ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const document = await createTestDocument(
            "Attribute View Primary Binding E2E",
            `Database seed\n\n${targetText}`,
        );
        const targetBlock = document.editor.locator(':scope > [data-type="NodeParagraph"]').nth(1);
        const targetBlockID = await targetBlock.getAttribute("data-node-id");
        expect(targetBlockID).toBeTruthy();
        await expect.poll(async () => {
            const result = await siyuanAPI.searchBlocks(targetText);
            return result.blocks.some(item => item.id === targetBlockID);
        }, {timeout: 30000}).toBe(true);

        const {avID, block} = await insertAttributeView(page, document.editor);
        const row = await addRow(page, block, targetText);
        const primaryCell = row.row.locator('[data-dtype="block"]');
        const labels = await page.evaluate(() => ({
            bind: window.siyuan.languages.bind,
            rebind: window.siyuan.languages.rebind,
        }));
        await expect(primaryCell).toHaveAttribute("data-detached", "true");
        const bindAction = primaryCell.locator('[data-type="av-row-update"]');
        await expect(bindAction).toHaveAttribute("aria-label", labels.bind);
        await bindAction.click();

        const protyle = block.locator(
            "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle ')][1]",
        );
        const hint = protyle.locator(".protyle-hint:not(.fn__none)");
        const targetOption = hint.locator(`button:has([data-node-id="${targetBlockID}"])`).first();
        await expect(targetOption).toBeVisible({timeout: 15000});
        await requestTransaction(page, () => targetOption.click());

        await expect(primaryCell).not.toHaveAttribute("data-detached", "true");
        await expect(primaryCell.locator(".av__celltext--ref")).toHaveAttribute("data-id", targetBlockID!);
        await expect(primaryCell.locator('[data-type="av-row-update"]')).toHaveAttribute("aria-label", labels.rebind);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const value = av.keyValues.find(item => item.key.type === "block")
                ?.values?.find(item => item.blockID === row.id);
            return {
                id: value?.block?.id,
                isDetached: value?.isDetached || false,
            };
        }, {timeout: 30000}).toEqual({
            id: targetBlockID,
            isDetached: false,
        });

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedCell = reloadedEditor.locator(
            `:scope > [data-av-id="${avID}"] .av__row[data-id="${row.id}"] [data-dtype="block"]`,
        );
        await expect(reloadedCell.locator(".av__celltext--ref")).toHaveAttribute("data-id", targetBlockID!);
        await expect(reloadedCell.locator('[data-type="av-row-update"]')).toHaveAttribute("aria-label", labels.rebind);
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

        await requestHistoryAction(page, block, UNDO_SHORTCUT, "undo");
        await expect(block.locator(`.av__row--header [data-col-id="${textColumn.id}"]`)).toHaveCount(1);
        await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).keyValues
            .some(item => item.key.id === textColumn.id), {timeout: 30000}).toBe(true);

        await requestHistoryAction(page, block, REDO_SHORTCUT, "redo");
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

        await requestHistoryAction(page, block, UNDO_SHORTCUT, "undo");
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

        await requestHistoryAction(page, block, REDO_SHORTCUT, "redo");
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
        test.slow();
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
        await requestTransactionAndRender(page, () => sortMenu.locator(".b3-menu__item").filter({
            hasText: primaryColumnName,
        }).click());
        await expectRowOrder(block, [alpha.id, bravo.id, charlie.id]);

        const orderSelect = sortPanel.locator(`.b3-menu__item[data-id="${primaryColumnID}"] select`).last();
        await requestTransactionAndRender(page, async () => {
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
        await requestTransactionAndRender(page, () => filterMenu.locator(".b3-menu__item").filter({
            hasText: primaryColumnName,
        }).click());
        const filterInput = sortPanel.locator('.av__filter-row[data-column] [data-type="filterValue"]');
        await expect(filterInput).toBeVisible();
        await filterInput.fill("Bravo");
        await requestTransactionAndRender(page, () => filterInput.press("Enter"));
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
        await page.keyboard.press("ControlOrMeta+V");
        await Promise.all([pasteRowsResponse, pasteTransaction]);
        await expect.poll(() => getOrderedBlockContents(siyuanAPI, avID), {timeout: 30000}).toMatchObject({
            contents: pasteContents,
        });
        expect((await getOrderedBlockContents(siyuanAPI, avID)).itemIds).toHaveLength(130);

        await requestHistoryAction(page, reloadedBlock, UNDO_SHORTCUT, "undo");
        await expect.poll(() => getOrderedBlockContents(siyuanAPI, avID), {timeout: 30000}).toMatchObject({
            contents: seedContents,
        });
        expect((await getOrderedBlockContents(siyuanAPI, avID)).itemIds).toHaveLength(120);
    });

    test("replaces an existing select value when pasting an external HTML table", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View HTML Table Paste E2E", "Database seed");
        const {avID, block} = await insertAttributeView(page, document.editor);
        const row = await addRow(page, block, "0");
        const selectColumnID = await block.locator('.av__cell--header[data-dtype="select"]').getAttribute("data-col-id");
        expect(selectColumnID).toBeTruthy();
        const selectCell = row.row.locator(`[data-col-id="${selectColumnID}"]`);
        await editSelectCell(page, selectCell, ["0"]);

        const firstCell = row.row.locator('[data-dtype="block"]');
        await expect(block).not.toHaveAttribute("data-rendering", "true", {timeout: 30000});
        await firstCell.dispatchEvent("mousedown", {button: 0, buttons: 1});
        await firstCell.dispatchEvent("mouseup", {button: 0, buttons: 0});
        await expect(firstCell).toHaveClass(/av__cell--select/);

        const pasteRowsResponse = waitForResponse(page, "/api/av/getAttributeViewPasteRows");
        const pasteTransaction = waitForResponse(page, "/api/transactions");
        const pasteTarget = block.locator('.av__cursor[contenteditable="true"]').first();
        await pasteTarget.evaluate((element) => {
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", "q\tw\ne\tr\nt\ty");
            clipboardData.setData("text/html",
                "<table><tbody><tr><td>q</td><td>w</td></tr><tr><td>e</td><td>r</td></tr>" +
                "<tr><td>t</td><td>y</td></tr></tbody></table>");
            element.dispatchEvent(new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData,
            }));
        });
        await Promise.all([pasteRowsResponse, pasteTransaction]);

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const itemIds = av.views.find(view => view.id === av.viewID)?.itemIds || [];
            const primaryValues = av.keyValues.find(item => item.key.type === "block")?.values || [];
            const selectValues = av.keyValues.find(item => item.key.id === selectColumnID)?.values || [];
            return {
                primary: itemIds.map(itemID =>
                    primaryValues.find(value => value.blockID === itemID)?.block?.content),
                selected: itemIds.map(itemID =>
                    selectValues.find(value => value.blockID === itemID)?.mSelect?.map(option => option.content)),
            };
        }, {timeout: 30000}).toEqual({
            primary: ["q", "e", "t"],
            selected: [["w"], ["r"], ["y"]],
        });

        await requestHistoryAction(page, block, UNDO_SHORTCUT, "undo");
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const itemIds = av.views.find(view => view.id === av.viewID)?.itemIds || [];
            const primaryValues = av.keyValues.find(item => item.key.type === "block")?.values || [];
            const selectValues = av.keyValues.find(item => item.key.id === selectColumnID)?.values || [];
            return {
                primary: itemIds.map(itemID =>
                    primaryValues.find(value => value.blockID === itemID)?.block?.content),
                selected: itemIds.map(itemID =>
                    selectValues.find(value => value.blockID === itemID)?.mSelect?.map(option => option.content)),
            };
        }, {timeout: 30000}).toEqual({
            primary: ["0"],
            selected: [["0"]],
        });
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
