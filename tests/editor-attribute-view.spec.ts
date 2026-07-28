import {JSHandle, Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";
import {waitForTransactionAction} from "./helpers/transactions";

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
        groups?: Array<{
            groupFolded: boolean;
            groupHidden: number;
            groupItemIds?: string[];
            groupVal?: {
                mSelect?: Array<{content: string}>;
            };
            id: string;
            name: string;
        }>;
        gallery?: {
            cardAspectRatio: number;
            cardAspectRatioValue?: number;
            cardSize: number;
            cardWidth?: number;
            coverFrom: number;
            coverFromAssetKeyID?: string;
            displayFieldName: boolean;
            fields: Array<{
                hidden: boolean;
                id: string;
                wrap: boolean;
            }>;
            fitImage: boolean;
            showIcon: boolean;
            wrapField: boolean;
        };
        id: string;
        itemIds?: string[];
        kanban?: {
            cardAspectRatio: number;
            cardAspectRatioValue?: number;
            cardSize: number;
            cardWidth?: number;
            coverFrom: number;
            coverFromAssetKeyID?: string;
            displayFieldName: boolean;
            fields: Array<{
                hidden: boolean;
                id: string;
                wrap: boolean;
            }>;
            fillColBackgroundColor: boolean;
            fitImage: boolean;
            showIcon: boolean;
            wrapField: boolean;
        };
        name: string;
        pageSize?: number;
        sorts?: Array<{
            column: string;
            order: string;
        }>;
        table?: {
            columns: Array<{
                hidden: boolean;
                id: string;
                pin: boolean;
                width: string;
                wrap: boolean;
            }>;
        };
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
    const transaction = waitForTransactionAction(page, "addAttrViewCol");
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

const editSelectCell = async (page: Page, cell: Locator, values: string[], waitForRender = true) => {
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
        const transaction = waitForTransactionAction(page, "updateAttrViewCell");
        if (type === "select" && waitForRender) {
            const render = waitForResponse(page, "/api/av/renderAttributeView", 30000);
            await input.press("Enter");
            await Promise.all([transaction, render]);
        } else {
            await input.press("Enter");
            await transaction;
        }
    }
    await expect(cell.locator(".b3-chip")).toHaveText(values, {timeout: 30000});
    if (waitForRender) {
        await expect(block).not.toHaveAttribute("data-rendering", "true", {timeout: 30000});
    }
    if (await input.count() > 0) {
        await input.locator(
            "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' av__panel ')][1]",
        ).evaluate(element => element.remove());
        await expect(input).toHaveCount(0);
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

const sortFieldBefore = async (page: Page, panel: Locator, sourceID: string, targetID: string) => {
    const source = panel.locator(`button[data-type="editCol"][data-id="${sourceID}"]`);
    const target = panel.locator(`button[data-type="editCol"][data-id="${targetID}"]`);
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
    const transaction = waitForTransactionAction(page, "sortAttrViewCol");
    await target.dispatchEvent("drop", {dataTransfer, ...point});
    await transaction;
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
    const timestamp = await page.evaluate(({dateValue, withoutTime}) => {
        if (!withoutTime) {
            return new Date(dateValue).getTime();
        }
        const [year, month, day] = dateValue.split("-").map(Number);
        return new Date(year, month - 1, day).getTime();
    }, {dateValue: value, withoutTime: isNotTime});
    await input.fill(value);
    await requestTransaction(page, () => input.press("Enter"));
    await expect(input).toHaveCount(0);
    return {isNotTime, timestamp};
};

const expectRenderedDateValue = async (cell: Locator, expected: {
    content: number;
    content2?: number;
    hasEndDate?: boolean;
    isNotEmpty: boolean;
    isNotEmpty2?: boolean;
    isNotTime: boolean;
}) => {
    const text = cell.locator(".av__celltext");
    await expect(text).not.toHaveText("");
    await expect.poll(async () => {
        const dataValue = await text.getAttribute("data-value");
        if (!dataValue) {
            return null;
        }
        const value = JSON.parse(dataValue) as {
            content?: number;
            content2?: number;
            hasEndDate?: boolean;
            isNotEmpty?: boolean;
            isNotEmpty2?: boolean;
            isNotTime?: boolean;
        };
        return {
            content: value.content,
            content2: value.content2,
            hasEndDate: value.hasEndDate,
            isNotEmpty: value.isNotEmpty,
            isNotEmpty2: value.isNotEmpty2,
            isNotTime: value.isNotTime,
        };
    }, {timeout: 30000}).toMatchObject(expected);
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

const convertToGroupedLayout = async (page: Page, block: Locator, fieldID: string,
                                      layout: "gallery" | "kanban") => {
    const panel = await openAttributeViewConfig(page, block);
    await panel.locator('[data-type="goGroups"]').click();
    await Promise.all([
        waitForResponse(page, "/api/av/setAttrViewGroup"),
        panel.locator(`[data-type="setGroupMethod"][data-id="${fieldID}"]`).click(),
    ]);
    await panel.locator('[data-type="go-config"]').click();
    await panel.locator('[data-type="go-layout"]').click();
    await Promise.all([
        waitForResponse(page, "/api/av/changeAttrViewLayout"),
        panel.locator(`[data-type="set-layout"][data-view-type="${layout}"]`).click(),
    ]);
    await expect(block).toHaveAttribute("data-av-type", layout);
    await page.locator(".av__panel").locator('[data-type="close"]').click({position: {x: 5, y: 5}});
    await expect(page.locator(".av__panel")).toHaveCount(0);
};

const setAttributeViewPageSize = async (page: Page, block: Locator, size: "5" | "all") => {
    const panel = await openAttributeViewConfig(page, block);
    await panel.locator('[data-type="go-layout"]').click();
    await panel.locator('[data-type="set-page-size"]').click();
    const menu = page.locator('#commonMenu[data-name="av-page-size"]:not(.fn__none)');
    await expect(menu).toBeVisible();
    const label = size === "all"
        ? await page.evaluate(() => window.siyuan.languages.all)
        : size;
    const transaction = waitForTransactionAction(page, "setAttrViewPageSize");
    await menu.locator(".b3-menu__item").filter({
        hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`),
    }).click();
    await transaction;
    await expect(page.locator(".av__panel")).toHaveCount(0);
};

const prepareKanban = async (page: Page, editor: Locator, docID: string, siyuanAPI: SiyuanAPI,
                             rows: Array<{content: string; status: string}>) => {
    const inserted = await insertAttributeView(page, editor);
    const {avID, blockID} = inserted;
    let block = inserted.block;
    const statusColumn = await addColumn(page, block, "select", "Status");
    const initial = await getAttributeView(siyuanAPI, avID);
    const blockKey = initial.keyValues.find(item => item.key.type === "block");
    expect(blockKey).toBeTruthy();
    await siyuanAPI.post("/api/av/appendAttributeViewDetachedBlocksWithValues", {
        avID,
        blocksValues: rows.map((row, index) => [{
            block: {content: row.content},
            keyID: blockKey!.key.id,
        }, {
            keyID: statusColumn.id,
            mSelect: [{
                color: ((index % 8) + 1).toString(),
                content: row.status,
            }],
        }]),
    });
    await expect.poll(async () => {
        const av = await getAttributeView(siyuanAPI, avID);
        const values = av.keyValues.find(item => item.key.type === "block")?.values || [];
        return rows.map(row => values.some(value => value.block?.content === row.content));
    }, {timeout: 30000}).toEqual(rows.map(() => true));

    await page.reload();
    let reloadedEditor = await getDocumentEditor(page, docID);
    block = reloadedEditor.locator(`:scope > [data-node-id="${blockID}"]`);
    await convertToGroupedLayout(page, block, statusColumn.id, "kanban");
    await page.reload();
    reloadedEditor = await getDocumentEditor(page, docID);
    block = reloadedEditor.locator(`:scope > [data-node-id="${blockID}"]`);
    await expect(block).toHaveAttribute("data-av-type", "kanban");

    const av = await getAttributeView(siyuanAPI, avID);
    const blockValues = av.keyValues.find(item => item.key.type === "block")?.values || [];
    const rowIDs = Object.fromEntries(rows.map(row => [
        row.content,
        blockValues.find(value => value.block?.content === row.content)?.blockID,
    ]));
    expect(Object.values(rowIDs).every(Boolean)).toBe(true);
    return {avID, block, blockID, rowIDs: rowIDs as Record<string, string>, statusColumn};
};

const prepareSearchTable = async (page: Page, editor: Locator, docID: string, siyuanAPI: SiyuanAPI,
                                  rows: Array<{content: string; notes?: string}>) => {
    const inserted = await insertAttributeView(page, editor);
    const {avID, blockID} = inserted;
    const notesColumn = await addColumn(page, inserted.block, "text", "Notes");
    await expectPersistedAttributeView(siyuanAPI, docID, blockID, avID);
    const initial = await getAttributeView(siyuanAPI, avID);
    const blockKey = initial.keyValues.find(item => item.key.type === "block");
    expect(blockKey).toBeTruthy();
    await siyuanAPI.post("/api/av/appendAttributeViewDetachedBlocksWithValues", {
        avID,
        blocksValues: rows.map(row => [{
            block: {content: row.content},
            keyID: blockKey!.key.id,
        }, ...(row.notes === undefined ? [] : [{
            keyID: notesColumn.id,
            text: {content: row.notes},
        }])]),
    });
    await expect.poll(async () => {
        const av = await getAttributeView(siyuanAPI, avID);
        return av.views.find(view => view.id === av.viewID)?.itemIds?.length;
    }, {timeout: 30000}).toBe(rows.length);
    await page.reload();
    const reloadedEditor = await getDocumentEditor(page, docID);
    const block = reloadedEditor.locator(`:scope > [data-node-id="${blockID}"]`);
    await expect(block).toBeVisible({timeout: 30000});
    const av = await getAttributeView(siyuanAPI, avID);
    const blockValues = av.keyValues.find(item => item.key.type === "block")?.values || [];
    const rowIDs = Object.fromEntries(rows.map(row => [
        row.content,
        blockValues.find(value => value.block?.content === row.content)?.blockID,
    ]));
    expect(Object.values(rowIDs).every(Boolean)).toBe(true);
    return {avID, block, blockID, notesColumn, rowIDs: rowIDs as Record<string, string>};
};

const getKanbanGroup = (block: Locator, label: string) => block.locator(".av__kanban-group").filter({
    has: block.page().locator(".av__group-title .b3-chip", {hasText: label}),
});

const dragKanbanCard = async (page: Page, source: Locator, target: Locator,
                              position: "top" | "bottom") => {
    const sourceID = await source.getAttribute("data-id");
    expect(sourceID).toBeTruthy();
    const targetBox = await target.boundingBox();
    expect(targetBox).not.toBeNull();
    const sourceGroupID = await source.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' av__body ')][1]",
    ).getAttribute("data-group-id");
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer()) as JSHandle<DataTransfer>;
    const dragType = `application/siyuan-gutterNodeAttributeView\u200bGalleryItem\u200b${sourceID}` +
        (sourceGroupID ? `@${sourceGroupID}` : "");
    await dataTransfer.evaluate((transfer, data) => transfer.setData(data.type, data.value), {
        type: dragType,
        value: await source.evaluate(element => element.outerHTML),
    });
    await source.evaluate(element => {
        element.classList.add("av__gallery-item--select");
        (window.siyuan as typeof window.siyuan & {dragElement?: HTMLElement}).dragElement = element as HTMLElement;
    });
    await source.dispatchEvent("dragstart", {dataTransfer});
    const point = {
        clientX: targetBox!.x + targetBox!.width / 2,
        clientY: position === "top" ? targetBox!.y + 2 : targetBox!.y + targetBox!.height - 2,
    };
    await target.dispatchEvent("dragenter", {dataTransfer, ...point});
    await target.dispatchEvent("dragover", {dataTransfer, ...point});
    await target.dispatchEvent("dragover", {dataTransfer, ...point});
    await expect(target).toHaveClass(new RegExp(`dragover__${position}`));
    const transaction = waitForTransactionAction(page, "sortAttrViewRow");
    await target.dispatchEvent("drop", {dataTransfer, ...point});
    const response = await transaction;
    await page.locator(`.av__gallery-item[data-id="${sourceID}"]`).first()
        .dispatchEvent("dragend", {dataTransfer});
    await dataTransfer.dispose();
    return response.request().postDataJSON();
};

const searchAttributeView = async (page: Page, block: Locator, query: string) => {
    const input = block.locator('[data-type="av-search"]');
    if (await input.evaluate(element => (element as HTMLElement).style.width === "0px")) {
        await block.locator('[data-type="av-search-icon"]').click();
    }
    await expect(input).toBeVisible();
    const render = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/av/renderAttributeView") {
            return false;
        }
        const payload = response.request().postDataJSON() as {query?: string};
        return payload.query === query;
    }, {timeout: 30000});
    await input.fill(query);
    await render;
    await expect(block).not.toHaveAttribute("data-rendering", "true", {timeout: 30000});
    await expect(block.locator('[data-type="av-search"]')).toHaveText(query);
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

    test("persists field visibility, order, width, pin, and wrap per view", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Field Display E2E", "Database seed");
        const inserted = await insertAttributeView(page, document.editor);
        const {avID, blockID} = inserted;
        let block = inserted.block;
        const notesColumn = await addColumn(page, block, "text", "Notes");
        const scoreColumn = await addColumn(page, block, "number", "Score");
        const statusColumn = await addColumn(page, block, "select", "Status");
        const editPanel = page.locator(".av__panel");
        await expect(editPanel).toHaveCount(0);

        const initial = await getAttributeView(siyuanAPI, avID);
        const sourceViewID = initial.viewID;
        const sourceColumns = initial.views.find(view => view.id === sourceViewID)?.table?.columns;
        expect(sourceColumns).toBeTruthy();
        const baselineColumns = sourceColumns!.map(column => ({...column}));
        const baselineOrder = baselineColumns.map(column => column.id);
        const duplicateViewID = await duplicateFocusedView(page, block);
        await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).viewID, {
            timeout: 30000,
        }).toBe(duplicateViewID);
        await page.reload();
        const duplicateEditor = await getDocumentEditor(page, document.docID);
        block = duplicateEditor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator(
            `.av__views .layout-tab-bar .item[data-id="${duplicateViewID}"]`,
        )).toHaveClass(/item--focus/);

        const switchView = async (viewID: string) => {
            const transaction = waitForTransactionAction(page, "setAttrViewBlockView");
            await block.locator(`.av__views .layout-tab-bar .item[data-id="${viewID}"]`).click();
            await transaction;
            await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).viewID, {
                timeout: 30000,
            }).toBe(viewID);
            await page.reload();
            const editor = await getDocumentEditor(page, document.docID);
            block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
            await expect(block.locator(
                `.av__views .layout-tab-bar .item[data-id="${viewID}"]`,
            )).toHaveClass(/item--focus/);
        };
        await switchView(sourceViewID);

        const panel = await openAttributeViewConfig(page, block);
        await panel.locator('[data-type="go-properties"]').click();
        await sortFieldBefore(page, panel, statusColumn.id, notesColumn.id);
        const expectedOrder = baselineOrder.filter(id => id !== statusColumn.id);
        expectedOrder.splice(expectedOrder.indexOf(notesColumn.id), 0, statusColumn.id);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === sourceViewID)?.table?.columns.map(column => column.id);
        }, {timeout: 30000}).toEqual(expectedOrder);

        const scoreField = () => panel.locator(
            `button[data-type="editCol"][data-id="${scoreColumn.id}"]`,
        );
        const readScoreHidden = async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === sourceViewID)?.table?.columns
                .find(column => column.id === scoreColumn.id)?.hidden;
        };
        let visibilityTransaction = waitForTransactionAction(page, "setAttrViewColHidden");
        await scoreField().locator('[data-type="hideCol"]').click();
        await visibilityTransaction;
        await expect.poll(readScoreHidden, {timeout: 30000}).toBe(true);
        await expect(block.locator(
            `.av__row--header .av__cell--header[data-col-id="${scoreColumn.id}"]`,
        )).toHaveCount(0);
        visibilityTransaction = waitForTransactionAction(page, "setAttrViewColHidden");
        await scoreField().locator('[data-type="showCol"]').click();
        await visibilityTransaction;
        await expect.poll(readScoreHidden, {timeout: 30000}).toBe(false);
        await expect(block.locator(
            `.av__row--header .av__cell--header[data-col-id="${scoreColumn.id}"]`,
        )).toBeVisible({timeout: 30000});
        visibilityTransaction = waitForTransactionAction(page, "setAttrViewColHidden");
        await scoreField().locator('[data-type="hideCol"]').click();
        await visibilityTransaction;
        await expect.poll(readScoreHidden, {timeout: 30000}).toBe(true);
        await expect(block.locator(
            `.av__row--header .av__cell--header[data-col-id="${scoreColumn.id}"]`,
        )).toHaveCount(0);
        await page.locator(".av__panel").locator('[data-type="close"]').click({position: {x: 5, y: 5}});
        await expect(page.locator(".av__panel")).toHaveCount(0);

        let notesHeader = block.locator(
            `.av__row--header .av__cell--header[data-col-id="${notesColumn.id}"]`,
        );
        const oldWidth = await notesHeader.evaluate(element => (element as HTMLElement).clientWidth);
        const widthHandle = notesHeader.locator(".av__widthdrag");
        const handleBox = await widthHandle.boundingBox();
        expect(handleBox).not.toBeNull();
        const widthTransaction = waitForTransactionAction(page, "setAttrViewColWidth");
        const resizePoint = {
            x: handleBox!.x + handleBox!.width / 2,
            y: handleBox!.y + handleBox!.height / 2,
        };
        await widthHandle.dispatchEvent("mousedown", {
            button: 0,
            clientX: resizePoint.x,
            clientY: resizePoint.y,
        });
        await page.evaluate(point => {
            globalThis.document.dispatchEvent(new MouseEvent("mousemove", {
                bubbles: true,
                clientX: point.x + 80,
                clientY: point.y,
            }));
            globalThis.document.dispatchEvent(new MouseEvent("mouseup", {
                bubbles: true,
                clientX: point.x + 80,
                clientY: point.y,
            }));
        }, resizePoint);
        const widthResponse = await widthTransaction;
        const widthPayload = widthResponse.request().postDataJSON() as {
            transactions: Array<{
                doOperations: Array<{
                    action: string;
                    data?: string;
                    id?: string;
                }>;
            }>;
        };
        const widthOperation = widthPayload.transactions.flatMap(item => item.doOperations)
            .find(operation => operation.action === "setAttrViewColWidth");
        expect(widthOperation?.id).toBe(notesColumn.id);
        expect(widthOperation?.data).toMatch(/^\d+px$/);
        expect(Number.parseInt(widthOperation!.data!, 10)).toBeGreaterThanOrEqual(oldWidth + 75);
        const notesWidth = widthOperation!.data!;
        await expect(notesHeader).toHaveAttribute("style", new RegExp(`width:\\s*${notesWidth}`));

        const openNotesHeaderMenu = async () => {
            const menu = page.locator('#commonMenu[data-name="av-header-cell"]:not(.fn__none)');
            await expect(async () => {
                if (await menu.isVisible()) {
                    return;
                }
                await notesHeader.dispatchEvent("click");
                await expect(menu).toBeVisible({timeout: 2000});
            }).toPass({timeout: 15000});
            return menu;
        };
        let headerMenu = await openNotesHeaderMenu();
        const pinTransaction = waitForTransactionAction(page, "setAttrViewColPin");
        await headerMenu.locator('[data-id="freezeCol"]').click();
        await pinTransaction;
        notesHeader = block.locator(
            `.av__row--header .av__cell--header[data-col-id="${notesColumn.id}"]`,
        );
        await expect(notesHeader).toHaveAttribute("data-pin", "true");

        headerMenu = await openNotesHeaderMenu();
        const wrap = headerMenu.locator("input.b3-switch");
        await expect(wrap).not.toBeChecked();
        const wrapTransaction = waitForTransactionAction(page, "setAttrViewColWrap");
        await wrap.click();
        await wrapTransaction;

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const source = av.views.find(view => view.id === sourceViewID)?.table?.columns;
            const duplicate = av.views.find(view => view.id === duplicateViewID)?.table?.columns;
            const notes = source?.find(column => column.id === notesColumn.id);
            const score = source?.find(column => column.id === scoreColumn.id);
            return {
                duplicate,
                source: source && {
                    notes: notes && {
                        hidden: notes.hidden,
                        pin: notes.pin,
                        width: notes.width,
                        wrap: notes.wrap,
                    },
                    order: source.map(column => column.id),
                    scoreHidden: score?.hidden,
                },
            };
        }, {timeout: 30000}).toEqual({
            duplicate: baselineColumns,
            source: {
                notes: {
                    hidden: false,
                    pin: true,
                    width: notesWidth,
                    wrap: true,
                },
                order: expectedOrder,
                scoreHidden: true,
            },
        });

        await page.reload();
        let editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        notesHeader = block.locator(
            `.av__row--header .av__cell--header[data-col-id="${notesColumn.id}"]`,
        );
        await expect(notesHeader).toHaveAttribute("data-pin", "true");
        await expect(notesHeader).toHaveAttribute("data-wrap", "true");
        await expect(notesHeader).toHaveAttribute("style", new RegExp(`width:\\s*${notesWidth}`));
        await expect(block.locator(
            `.av__row--header .av__cell--header[data-col-id="${scoreColumn.id}"]`,
        )).toHaveCount(0);
        await expect.poll(() => block.locator(
            ".av__row--header .av__cell--header",
        ).evaluateAll(headers => headers.map(header => header.getAttribute("data-col-id"))), {
            timeout: 30000,
        }).toEqual(expectedOrder.filter(id => id !== scoreColumn.id));

        await switchView(duplicateViewID);
        const duplicateHeaders = block.locator(".av__row--header .av__cell--header");
        await expect.poll(() => duplicateHeaders.evaluateAll(headers =>
            headers.map(header => header.getAttribute("data-col-id"))), {timeout: 30000}).toEqual(baselineOrder);
        const duplicateNotes = block.locator(
            `.av__row--header .av__cell--header[data-col-id="${notesColumn.id}"]`,
        );
        await expect(block.locator(
            `.av__row--header .av__cell--header[data-col-id="${scoreColumn.id}"]`,
        )).toBeVisible();
        await expect(duplicateNotes).toHaveAttribute("data-pin", "false");
        await expect(duplicateNotes).toHaveAttribute("data-wrap", "false");
        await expect(duplicateNotes).toHaveAttribute("style", /width:\s*200px/);

        await switchView(sourceViewID);
        await expect(block.locator(
            `.av__row--header .av__cell--header[data-col-id="${scoreColumn.id}"]`,
        )).toHaveCount(0);
        await expect(block.locator(
            `.av__row--header .av__cell--header[data-col-id="${notesColumn.id}"]`,
        )).toHaveAttribute("data-pin", "true");
    });

    test("persists gallery cover, card, and field display settings per view", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Gallery Settings E2E", "Database seed");
        const inserted = await insertAttributeView(page, document.editor);
        const {avID, blockID} = inserted;
        let block = inserted.block;
        const row = await addRow(page, block, "Gallery item");
        const coverColumn = await addColumn(page, block, "mAsset", "Cover", "assets");
        const detailsColumn = await addColumn(page, block, "text", "Details");
        await editCell(page, row.row.locator(`[data-col-id="${detailsColumn.id}"]`),
            "A detailed gallery description that should wrap across multiple lines.");
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
        );
        const assetPath = await uploadAssetCell(page, row.row.locator(`[data-col-id="${coverColumn.id}"]`), {
            buffer: png,
            mimeType: "image/png",
            name: `gallery-cover-${Date.now()}.png`,
        });
        expect(assetPath).toMatch(/^assets\/.+\.png$/);
        const assetPanel = page.locator(".av__panel");
        if (await assetPanel.count() > 0) {
            await assetPanel.locator('[data-type="close"]').click({force: true});
            await expect(assetPanel).toHaveCount(0);
        }

        const sourceViewID = await addAttributeViewView(page, block, "gallery");
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const source = av.views.find(view => view.id === sourceViewID);
            return {
                current: av.viewID,
                gallery: source?.gallery && {
                    cardAspectRatio: source.gallery.cardAspectRatio,
                    cardSize: source.gallery.cardSize,
                    coverFrom: source.gallery.coverFrom,
                    displayFieldName: source.gallery.displayFieldName,
                    fitImage: source.gallery.fitImage,
                    showIcon: source.gallery.showIcon,
                    wrapField: source.gallery.wrapField,
                },
                type: source?.type,
            };
        }, {timeout: 30000}).toEqual({
            current: sourceViewID,
            gallery: {
                cardAspectRatio: 0,
                cardSize: 1,
                coverFrom: 1,
                displayFieldName: false,
                fitImage: false,
                showIcon: true,
                wrapField: false,
            },
            type: "gallery",
        });
        await page.reload();
        let editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block).toHaveAttribute("data-av-type", "gallery");

        const duplicateViewID = await duplicateFocusedView(page, block);
        await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).viewID, {
            timeout: 30000,
        }).toBe(duplicateViewID);
        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator(
            `.av__views .layout-tab-bar .item[data-id="${duplicateViewID}"]`,
        )).toHaveClass(/item--focus/);

        const readGallery = async (viewID: string) => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === viewID)?.gallery;
        };
        const duplicateBaseline = await readGallery(duplicateViewID);
        expect(duplicateBaseline).toBeTruthy();
        const baselineSummary = {
            cardAspectRatio: duplicateBaseline!.cardAspectRatio,
            cardAspectRatioValue: duplicateBaseline!.cardAspectRatioValue,
            cardSize: duplicateBaseline!.cardSize,
            cardWidth: duplicateBaseline!.cardWidth,
            coverFrom: duplicateBaseline!.coverFrom,
            coverFromAssetKeyID: duplicateBaseline!.coverFromAssetKeyID,
            displayFieldName: duplicateBaseline!.displayFieldName,
            fields: duplicateBaseline!.fields.map(field => ({...field})),
            fitImage: duplicateBaseline!.fitImage,
            showIcon: duplicateBaseline!.showIcon,
            wrapField: duplicateBaseline!.wrapField,
        };
        const switchView = async (viewID: string) => {
            const transaction = waitForTransactionAction(page, "setAttrViewBlockView");
            await block.locator(`.av__views .layout-tab-bar .item[data-id="${viewID}"]`).click();
            await transaction;
            await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).viewID, {
                timeout: 30000,
            }).toBe(viewID);
            await page.reload();
            const reloadedEditor = await getDocumentEditor(page, document.docID);
            block = reloadedEditor.locator(`:scope > [data-node-id="${blockID}"]`);
            await expect(block.locator(
                `.av__views .layout-tab-bar .item[data-id="${viewID}"]`,
            )).toHaveClass(/item--focus/);
            await expect(block).toHaveAttribute("data-av-type", "gallery");
        };
        await switchView(sourceViewID);

        const panel = await openAttributeViewConfig(page, block);
        await panel.locator('[data-type="go-layout"]').click();
        const chooseLayoutOption = async (trigger: string, action: string, label: string) => {
            await panel.locator(`[data-type="${trigger}"]`).click();
            const menu = page.locator("#commonMenu:not(.fn__none)");
            await expect(menu).toBeVisible();
            const transaction = waitForTransactionAction(page, action);
            await menu.locator(".b3-menu__item").filter({
                has: page.locator(".b3-menu__label", {hasText: label}),
            }).click();
            await transaction;
        };
        await chooseLayoutOption("set-gallery-cover", "setAttrViewCoverFromAssetKeyID", "Cover");
        const largeLabel = await page.evaluate(() => window.siyuan.languages.large);
        await chooseLayoutOption("set-gallery-size", "setAttrViewCardWidth", largeLabel);
        await chooseLayoutOption("set-gallery-ratio", "setAttrViewCardAspectRatioValue", "1:1");

        const toggleSetting = async (type: string, action: string, checked: boolean) => {
            const input = panel.locator(`input[data-type="${type}"]`);
            await expect(input).toBeChecked({checked: !checked});
            const transaction = waitForTransactionAction(page, action);
            await input.click();
            await transaction;
            await expect(input).toBeChecked({checked});
        };
        await toggleSetting("toggle-gallery-fit", "setAttrViewFitImage", true);
        await toggleSetting("toggle-gallery-name", "setAttrViewDisplayFieldName", true);
        await toggleSetting("toggle-entries-icons", "setAttrViewShowIcon", false);
        await toggleSetting("toggle-entries-wrap", "setAttrViewWrapField", true);

        await panel.locator('[data-type="go-config"]').click();
        await panel.locator('[data-type="go-properties"]').click();
        const detailsField = () => panel.locator(
            `button[data-type="editCol"][data-id="${detailsColumn.id}"]`,
        );
        const hideTransaction = waitForTransactionAction(page, "setAttrViewColHidden");
        await detailsField().locator('[data-type="hideCol"]').click();
        await hideTransaction;
        await expect.poll(async () => {
            const gallery = await readGallery(sourceViewID);
            return gallery?.fields.find(field => field.id === detailsColumn.id)?.hidden;
        }, {timeout: 30000}).toBe(true);
        await page.locator(".av__panel").locator('[data-type="close"]').click({position: {x: 5, y: 5}});
        await expect(page.locator(".av__panel")).toHaveCount(0);

        await expect.poll(async () => {
            const source = await readGallery(sourceViewID);
            const duplicate = await readGallery(duplicateViewID);
            return {
                duplicate: duplicate && {
                    cardAspectRatio: duplicate.cardAspectRatio,
                    cardAspectRatioValue: duplicate.cardAspectRatioValue,
                    cardSize: duplicate.cardSize,
                    cardWidth: duplicate.cardWidth,
                    coverFrom: duplicate.coverFrom,
                    coverFromAssetKeyID: duplicate.coverFromAssetKeyID,
                    displayFieldName: duplicate.displayFieldName,
                    fields: duplicate.fields,
                    fitImage: duplicate.fitImage,
                    showIcon: duplicate.showIcon,
                    wrapField: duplicate.wrapField,
                },
                source: source && {
                    cardAspectRatio: source.cardAspectRatio,
                    cardAspectRatioValue: source.cardAspectRatioValue,
                    cardSize: source.cardSize,
                    cardWidth: source.cardWidth,
                    coverFrom: source.coverFrom,
                    coverFromAssetKeyID: source.coverFromAssetKeyID,
                    detailsHidden: source.fields.find(field => field.id === detailsColumn.id)?.hidden,
                    displayFieldName: source.displayFieldName,
                    fieldsWrapped: source.fields.every(field => field.wrap),
                    fitImage: source.fitImage,
                    showIcon: source.showIcon,
                    wrapField: source.wrapField,
                },
            };
        }, {timeout: 30000}).toEqual({
            duplicate: baselineSummary,
            source: {
                cardAspectRatio: 0,
                cardAspectRatioValue: 1,
                cardSize: 1,
                cardWidth: 320,
                coverFrom: 2,
                coverFromAssetKeyID: coverColumn.id,
                detailsHidden: true,
                displayFieldName: true,
                fieldsWrapped: true,
                fitImage: true,
                showIcon: false,
                wrapField: true,
            },
        });

        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        const sourceCard = block.locator(`.av__gallery-item[data-id="${row.id}"]`);
        await expect.poll(() => block.locator(".av__gallery").evaluate(element => ({
            ratio: getComputedStyle(element).getPropertyValue("--b3-av-card-aspect-ratio").trim(),
            width: getComputedStyle(element).getPropertyValue("--b3-av-card-width").trim(),
        })), {timeout: 30000}).toEqual({ratio: "1", width: "320px"});
        const coverImage = sourceCard.locator(".av__gallery-img");
        await expect(coverImage).toHaveClass(/av__gallery-img--fit/);
        await expect(coverImage).toHaveAttribute("src", new RegExp(assetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        await expect(sourceCard.locator(".av__gallery-field--name")).not.toHaveCount(0);
        await expect(sourceCard.locator(
            `.av__cell[data-field-id="${detailsColumn.id}"]`,
        )).toHaveCount(0);
        await expect.poll(() => sourceCard.locator(".av__cell").evaluateAll(cells =>
            cells.map(cell => cell.getAttribute("data-wrap"))), {timeout: 30000})
            .toEqual(["true", "true", "true"]);

        await switchView(duplicateViewID);
        const duplicateCard = block.locator(`.av__gallery-item[data-id="${row.id}"]`);
        await expect.poll(() => block.locator(".av__gallery").evaluate(element => ({
            ratio: getComputedStyle(element).getPropertyValue("--b3-av-card-aspect-ratio").trim(),
            width: getComputedStyle(element).getPropertyValue("--b3-av-card-width").trim(),
        })), {timeout: 30000}).toEqual({ratio: `${16 / 9}`, width: "260px"});
        await expect(duplicateCard.locator(".av__gallery-cover")).toHaveClass(/av__gallery-cover--0/);
        await expect(duplicateCard.locator(".av__gallery-field--name")).toHaveCount(0);
        await expect(duplicateCard.locator(
            `.av__cell[data-field-id="${detailsColumn.id}"]`,
        )).toBeVisible();
        await expect.poll(() => duplicateCard.locator(".av__cell").evaluateAll(cells =>
            cells.map(cell => cell.getAttribute("data-wrap"))), {timeout: 30000})
            .toEqual(["false", "false", "false", "false"]);

        await switchView(sourceViewID);
        await expect.poll(() => block.locator(".av__gallery").evaluate(element => ({
            ratio: getComputedStyle(element).getPropertyValue("--b3-av-card-aspect-ratio").trim(),
            width: getComputedStyle(element).getPropertyValue("--b3-av-card-width").trim(),
        })), {timeout: 30000}).toEqual({ratio: "1", width: "320px"});
        await expect(block.locator(`.av__gallery-item[data-id="${row.id}"] .av__gallery-img`))
            .toHaveClass(/av__gallery-img--fit/);
    });

    test("persists kanban cover, card, field, and background settings per view", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Kanban Settings E2E", "Database seed");
        const inserted = await insertAttributeView(page, document.editor);
        const {avID, blockID} = inserted;
        let block = inserted.block;
        const planned = await addRow(page, block, "Planned card");
        const done = await addRow(page, block, "Done card");
        const statusColumn = await addColumn(page, block, "select", "Status");
        const coverColumn = await addColumn(page, block, "mAsset", "Cover", "assets");
        const detailsColumn = await addColumn(page, block, "text", "Details");
        await editCell(page, planned.row.locator(`[data-col-id="${detailsColumn.id}"]`),
            "A detailed Kanban description that should wrap across multiple lines.");
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
        );
        const assetPath = await uploadAssetCell(page, planned.row.locator(`[data-col-id="${coverColumn.id}"]`), {
            buffer: png,
            mimeType: "image/png",
            name: `kanban-cover-${Date.now()}.png`,
        });
        expect(assetPath).toMatch(/^assets\/.+\.png$/);
        const assetPanel = page.locator(".av__panel");
        if (await assetPanel.count() > 0) {
            await assetPanel.locator('[data-type="close"]').click({force: true});
            await expect(assetPanel).toHaveCount(0);
        }
        await editSelectCell(page, planned.row.locator(`[data-col-id="${statusColumn.id}"]`), ["Planned"], false);
        await page.reload();
        let editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await editSelectCell(page, block.locator(
            `.av__row[data-id="${done.id}"] [data-col-id="${statusColumn.id}"]`,
        ), ["Done"], false);
        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);

        const sourceViewID = (await getAttributeView(siyuanAPI, avID)).viewID;
        expect(sourceViewID).toBeTruthy();
        const setupPanel = await openAttributeViewConfig(page, block);
        await setupPanel.locator('[data-type="goGroups"]').click();
        await Promise.all([
            waitForResponse(page, "/api/av/setAttrViewGroup"),
            setupPanel.locator(`[data-type="setGroupMethod"][data-id="${statusColumn.id}"]`).click(),
        ]);
        await setupPanel.locator('[data-type="go-config"]').click();
        await setupPanel.locator('[data-type="go-layout"]').click();
        await Promise.all([
            waitForResponse(page, "/api/av/changeAttrViewLayout"),
            setupPanel.locator('[data-type="set-layout"][data-view-type="kanban"]').click(),
        ]);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const source = av.views.find(view => view.id === sourceViewID);
            return {
                current: av.viewID,
                group: source?.group && {
                    field: source.group.field,
                    hideEmpty: source.group.hideEmpty,
                    method: source.group.method,
                    order: source.group.order,
                },
                kanban: source?.kanban && {
                    cardAspectRatio: source.kanban.cardAspectRatio,
                    cardSize: source.kanban.cardSize,
                    coverFrom: source.kanban.coverFrom,
                    displayFieldName: source.kanban.displayFieldName,
                    fillColBackgroundColor: source.kanban.fillColBackgroundColor,
                    fitImage: source.kanban.fitImage,
                    showIcon: source.kanban.showIcon,
                    wrapField: source.kanban.wrapField,
                },
                type: source?.type,
            };
        }, {timeout: 30000}).toEqual({
            current: sourceViewID,
            group: {
                field: statusColumn.id,
                hideEmpty: true,
                method: 0,
                order: 3,
            },
            kanban: {
                cardAspectRatio: 0,
                cardSize: 1,
                coverFrom: 1,
                displayFieldName: false,
                fillColBackgroundColor: false,
                fitImage: false,
                showIcon: true,
                wrapField: false,
            },
            type: "kanban",
        });
        await page.locator(".av__panel").locator('[data-type="close"]').click({position: {x: 5, y: 5}});
        await expect(page.locator(".av__panel")).toHaveCount(0);
        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block).toHaveAttribute("data-av-type", "kanban");
        await expect(block.locator(".av__kanban-group")).toHaveCount(2);

        const duplicateViewID = await duplicateFocusedView(page, block);
        await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).viewID, {
            timeout: 30000,
        }).toBe(duplicateViewID);
        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator(
            `.av__views .layout-tab-bar .item[data-id="${duplicateViewID}"]`,
        )).toHaveClass(/item--focus/);

        const readKanban = async (viewID: string) => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === viewID)?.kanban;
        };
        const duplicateBaseline = await readKanban(duplicateViewID);
        expect(duplicateBaseline).toBeTruthy();
        const baselineSummary = {
            cardAspectRatio: duplicateBaseline!.cardAspectRatio,
            cardAspectRatioValue: duplicateBaseline!.cardAspectRatioValue,
            cardSize: duplicateBaseline!.cardSize,
            cardWidth: duplicateBaseline!.cardWidth,
            coverFrom: duplicateBaseline!.coverFrom,
            coverFromAssetKeyID: duplicateBaseline!.coverFromAssetKeyID,
            displayFieldName: duplicateBaseline!.displayFieldName,
            fields: duplicateBaseline!.fields.map(field => ({...field})),
            fillColBackgroundColor: duplicateBaseline!.fillColBackgroundColor,
            fitImage: duplicateBaseline!.fitImage,
            showIcon: duplicateBaseline!.showIcon,
            wrapField: duplicateBaseline!.wrapField,
        };
        const switchView = async (viewID: string) => {
            const transaction = waitForTransactionAction(page, "setAttrViewBlockView");
            await block.locator(`.av__views .layout-tab-bar .item[data-id="${viewID}"]`).click();
            await transaction;
            await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).viewID, {
                timeout: 30000,
            }).toBe(viewID);
            await page.reload();
            const reloadedEditor = await getDocumentEditor(page, document.docID);
            block = reloadedEditor.locator(`:scope > [data-node-id="${blockID}"]`);
            await expect(block.locator(
                `.av__views .layout-tab-bar .item[data-id="${viewID}"]`,
            )).toHaveClass(/item--focus/);
            await expect(block).toHaveAttribute("data-av-type", "kanban");
        };
        await switchView(sourceViewID);

        const panel = await openAttributeViewConfig(page, block);
        await panel.locator('[data-type="go-layout"]').click();
        const chooseLayoutOption = async (trigger: string, action: string, label: string) => {
            await panel.locator(`[data-type="${trigger}"]`).click();
            const menu = page.locator("#commonMenu:not(.fn__none)");
            await expect(menu).toBeVisible();
            const transaction = waitForTransactionAction(page, action);
            await menu.locator(".b3-menu__item").filter({
                has: page.locator(".b3-menu__label", {hasText: label}),
            }).click();
            await transaction;
        };
        await chooseLayoutOption("set-gallery-cover", "setAttrViewCoverFromAssetKeyID", "Cover");
        const smallLabel = await page.evaluate(() => window.siyuan.languages.small);
        await chooseLayoutOption("set-gallery-size", "setAttrViewCardWidth", smallLabel);
        await chooseLayoutOption("set-gallery-ratio", "setAttrViewCardAspectRatioValue", "3:4");

        const toggleSetting = async (type: string, action: string, checked: boolean) => {
            const input = panel.locator(`input[data-type="${type}"]`);
            await expect(input).toBeChecked({checked: !checked});
            const transaction = waitForTransactionAction(page, action);
            await input.click();
            await transaction;
            await expect(input).toBeChecked({checked});
        };
        await toggleSetting("toggle-gallery-fit", "setAttrViewFitImage", true);
        await toggleSetting("toggle-gallery-name", "setAttrViewDisplayFieldName", true);
        await toggleSetting("toggle-entries-icons", "setAttrViewShowIcon", false);
        await toggleSetting("toggle-entries-wrap", "setAttrViewWrapField", true);
        await toggleSetting("toggle-kanban-bg", "setAttrViewFillColBackgroundColor", true);
        await page.locator(".av__panel").locator('[data-type="close"]').click({position: {x: 5, y: 5}});
        await expect(page.locator(".av__panel")).toHaveCount(0);

        await expect.poll(async () => {
            const source = await readKanban(sourceViewID);
            const duplicate = await readKanban(duplicateViewID);
            return {
                duplicate: duplicate && {
                    cardAspectRatio: duplicate.cardAspectRatio,
                    cardAspectRatioValue: duplicate.cardAspectRatioValue,
                    cardSize: duplicate.cardSize,
                    cardWidth: duplicate.cardWidth,
                    coverFrom: duplicate.coverFrom,
                    coverFromAssetKeyID: duplicate.coverFromAssetKeyID,
                    displayFieldName: duplicate.displayFieldName,
                    fields: duplicate.fields,
                    fillColBackgroundColor: duplicate.fillColBackgroundColor,
                    fitImage: duplicate.fitImage,
                    showIcon: duplicate.showIcon,
                    wrapField: duplicate.wrapField,
                },
                source: source && {
                    cardAspectRatio: source.cardAspectRatio,
                    cardAspectRatioValue: source.cardAspectRatioValue,
                    cardSize: source.cardSize,
                    cardWidth: source.cardWidth,
                    coverFrom: source.coverFrom,
                    coverFromAssetKeyID: source.coverFromAssetKeyID,
                    displayFieldName: source.displayFieldName,
                    fieldsWrapped: source.fields.every(field => field.wrap),
                    fillColBackgroundColor: source.fillColBackgroundColor,
                    fitImage: source.fitImage,
                    showIcon: source.showIcon,
                    wrapField: source.wrapField,
                },
            };
        }, {timeout: 30000}).toEqual({
            duplicate: baselineSummary,
            source: {
                cardAspectRatio: 0,
                cardAspectRatioValue: 0.75,
                cardSize: 1,
                cardWidth: 180,
                coverFrom: 2,
                coverFromAssetKeyID: coverColumn.id,
                displayFieldName: true,
                fieldsWrapped: true,
                fillColBackgroundColor: true,
                fitImage: true,
                showIcon: false,
                wrapField: true,
            },
        });

        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        const sourceGroups = block.locator(".av__kanban-group");
        const sourceCard = block.locator(`.av__gallery-item[data-id="${planned.id}"]`);
        await expect(sourceGroups).toHaveCount(2);
        await expect.poll(() => block.locator(".av__kanban").evaluate(element => ({
            ratio: getComputedStyle(element).getPropertyValue("--b3-av-card-aspect-ratio").trim(),
            width: getComputedStyle(element).getPropertyValue("--b3-av-card-width").trim(),
        })), {timeout: 30000}).toEqual({ratio: "0.75", width: "180px"});
        await expect(block.locator(".av__kanban")).toHaveClass(/av__kanban--bg/);
        await expect.poll(() => sourceGroups.evaluateAll(groups =>
            groups.map(group => group.getAttribute("style")?.includes("--b3-av-kanban-background") || false)),
        {timeout: 30000}).toEqual([true, true]);
        const coverImage = sourceCard.locator(".av__gallery-img");
        await expect(coverImage).toHaveClass(/av__gallery-img--fit/);
        await expect(coverImage).toHaveAttribute("src", new RegExp(assetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        await expect(sourceCard.locator(".av__gallery-field--name")).not.toHaveCount(0);
        await expect(sourceCard.locator(
            `.av__cell[data-field-id="${detailsColumn.id}"]`,
        )).toHaveAttribute("data-wrap", "true");

        await switchView(duplicateViewID);
        const duplicateGroups = block.locator(".av__kanban-group");
        const duplicateCard = block.locator(`.av__gallery-item[data-id="${planned.id}"]`);
        await expect(duplicateGroups).toHaveCount(2);
        await expect.poll(() => block.locator(".av__kanban").evaluate(element => ({
            ratio: getComputedStyle(element).getPropertyValue("--b3-av-card-aspect-ratio").trim(),
            width: getComputedStyle(element).getPropertyValue("--b3-av-card-width").trim(),
        })), {timeout: 30000}).toEqual({ratio: `${16 / 9}`, width: "260px"});
        await expect(block.locator(".av__kanban")).not.toHaveClass(/av__kanban--bg/);
        await expect.poll(() => duplicateGroups.evaluateAll(groups =>
            groups.map(group => group.getAttribute("style")?.includes("--b3-av-kanban-background") || false)),
        {timeout: 30000}).toEqual([false, false]);
        await expect(duplicateCard.locator(".av__gallery-cover")).toHaveCount(0);
        await expect(duplicateCard.locator(".av__gallery-field--name")).toHaveCount(0);
        await expect(duplicateCard.locator(
            `.av__cell[data-field-id="${detailsColumn.id}"]`,
        )).toHaveAttribute("data-wrap", "false");

        await switchView(sourceViewID);
        await expect(block.locator(".av__kanban")).toHaveClass(/av__kanban--bg/);
        await expect(block.locator(`.av__gallery-item[data-id="${planned.id}"] .av__gallery-img`))
            .toHaveClass(/av__gallery-img--fit/);
    });

    test("moves a Kanban card across select groups with reverse, reapply, and reload persistence", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Kanban Cross Group E2E", "Database seed");
        const prepared = await prepareKanban(page, document.editor, document.docID, siyuanAPI, [
            {content: "Planned card", status: "Planned"},
            {content: "Done card", status: "Done"},
        ]);
        const {avID, blockID, rowIDs, statusColumn} = prepared;
        let block = prepared.block;
        const plannedGroup = getKanbanGroup(block, "Planned");
        const doneGroup = getKanbanGroup(block, "Done");
        await expect(plannedGroup).toHaveCount(1);
        await expect(doneGroup).toHaveCount(1);
        const plannedCard = plannedGroup.locator(`.av__gallery-item[data-id="${rowIDs["Planned card"]}"]`);
        const doneCard = doneGroup.locator(`.av__gallery-item[data-id="${rowIDs["Done card"]}"]`);

        const dragPayload = await dragKanbanCard(page, plannedCard, doneCard, "bottom") as {
            app: string;
            session: string;
            transactions: Array<{
                doOperations: Array<Record<string, unknown>>;
                undoOperations: Array<Record<string, unknown>>;
            }>;
        };
        await expect(plannedGroup.locator(`.av__gallery-item[data-id="${rowIDs["Planned card"]}"]`)).toHaveCount(0);
        await expect.poll(() => doneGroup.locator(".av__gallery-item").evaluateAll(cards =>
            cards.map(card => card.getAttribute("data-id"))), {timeout: 30000})
            .toEqual([rowIDs["Done card"], rowIDs["Planned card"]]);

        const readMoveState = async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const view = av.views.find(item => item.id === av.viewID);
            const status = av.keyValues.find(item => item.key.id === statusColumn.id)?.values
                ?.find(value => value.blockID === rowIDs["Planned card"])?.mSelect?.map(option => option.content);
            return {
                done: view?.groups?.find(group =>
                    group.groupVal?.mSelect?.[0]?.content === "Done")?.groupItemIds,
                planned: view?.groups?.find(group =>
                    group.groupVal?.mSelect?.[0]?.content === "Planned")?.groupItemIds,
                status,
            };
        };
        await expect.poll(readMoveState, {timeout: 30000}).toEqual({
            done: [rowIDs["Done card"], rowIDs["Planned card"]],
            planned: [],
            status: ["Done"],
        });

        const dragTransaction = dragPayload.transactions[0];
        expect(dragTransaction.doOperations).toHaveLength(1);
        expect(dragTransaction.undoOperations).toHaveLength(1);
        expect(dragTransaction.undoOperations[0]).toMatchObject({
            action: "sortAttrViewRow",
            id: rowIDs["Planned card"],
            previousID: "",
        });
        await siyuanAPI.post("/api/transactions", {
            app: dragPayload.app,
            reqId: Date.now(),
            session: dragPayload.session,
            transactions: [{
                doOperations: dragTransaction.undoOperations,
                undoOperations: dragTransaction.doOperations,
            }],
        });
        await expect.poll(readMoveState, {timeout: 30000}).toEqual({
            done: [rowIDs["Done card"]],
            planned: [rowIDs["Planned card"]],
            status: ["Planned"],
        });
        await siyuanAPI.post("/api/transactions", {
            app: dragPayload.app,
            reqId: Date.now(),
            session: dragPayload.session,
            transactions: [{
                doOperations: dragTransaction.doOperations,
                undoOperations: dragTransaction.undoOperations,
            }],
        });
        await expect.poll(readMoveState, {timeout: 30000}).toEqual({
            done: [rowIDs["Done card"], rowIDs["Planned card"]],
            planned: [],
            status: ["Done"],
        });

        await page.reload();
        const editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        const reloadedDone = getKanbanGroup(block, "Done");
        await expect.poll(() => reloadedDone.locator(".av__gallery-item").evaluateAll(cards =>
            cards.map(card => card.getAttribute("data-id"))), {timeout: 30000})
            .toEqual([rowIDs["Done card"], rowIDs["Planned card"]]);
        await expect(block.locator(`.av__gallery-item[data-id="${rowIDs["Planned card"]}"]`)).toHaveCount(1);
    });

    test("reorders Kanban cards within a group and restores the order after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Kanban Reorder E2E", "Database seed");
        const prepared = await prepareKanban(page, document.editor, document.docID, siyuanAPI, [
            {content: "First card", status: "Planned"},
            {content: "Second card", status: "Planned"},
            {content: "Third card", status: "Planned"},
        ]);
        const {avID, blockID, rowIDs} = prepared;
        let block = prepared.block;
        let plannedGroup = getKanbanGroup(block, "Planned");
        const firstCard = plannedGroup.locator(`.av__gallery-item[data-id="${rowIDs["First card"]}"]`);
        const thirdCard = plannedGroup.locator(`.av__gallery-item[data-id="${rowIDs["Third card"]}"]`);

        await dragKanbanCard(page, thirdCard, firstCard, "top");
        const expectedOrder = [rowIDs["Third card"], rowIDs["First card"], rowIDs["Second card"]];
        await expect.poll(() => plannedGroup.locator(".av__gallery-item").evaluateAll(cards =>
            cards.map(card => card.getAttribute("data-id"))), {timeout: 30000}).toEqual(expectedOrder);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const view = av.views.find(item => item.id === av.viewID);
            return view?.groups?.find(group =>
                group.groupVal?.mSelect?.[0]?.content === "Planned")?.groupItemIds;
        }, {timeout: 30000}).toEqual(expectedOrder);

        await page.reload();
        const editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        plannedGroup = getKanbanGroup(block, "Planned");
        await expect.poll(() => plannedGroup.locator(".av__gallery-item").evaluateAll(cards =>
            cards.map(card => card.getAttribute("data-id"))), {timeout: 30000}).toEqual(expectedOrder);
    });

    test("adds a Kanban card from a group and assigns that group's select value", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Kanban Group Add E2E", "Database seed");
        const prepared = await prepareKanban(page, document.editor, document.docID, siyuanAPI, [
            {content: "Existing planned", status: "Planned"},
            {content: "Existing done", status: "Done"},
        ]);
        const {avID, blockID, statusColumn} = prepared;
        let block = prepared.block;
        let plannedGroup = getKanbanGroup(block, "Planned");
        const oldCount = await plannedGroup.locator(".av__gallery-item").count();
        await requestTransaction(page, () => plannedGroup.locator('[data-type="av-add-top"]').click());
        await expect(plannedGroup.locator(".av__gallery-item")).toHaveCount(oldCount + 1, {timeout: 30000});
        const input = page.locator(".av__mask .b3-text-field");
        await expect(input).toBeVisible();
        await input.fill("New planned card");
        await requestTransaction(page, () => input.press("Enter"));

        let newRowID = "";
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const blockValue = av.keyValues.find(item => item.key.type === "block")?.values
                ?.find(value => value.block?.content === "New planned card");
            newRowID = blockValue?.blockID || "";
            const status = av.keyValues.find(item => item.key.id === statusColumn.id)?.values
                ?.find(value => value.blockID === newRowID)?.mSelect?.map(option => option.content);
            const view = av.views.find(item => item.id === av.viewID);
            return {
                firstInGroup: view?.groups?.find(group =>
                    group.groupVal?.mSelect?.[0]?.content === "Planned")?.groupItemIds?.[0],
                status,
            };
        }, {timeout: 30000}).toEqual({
            firstInGroup: expect.any(String),
            status: ["Planned"],
        });
        expect(newRowID).toBeTruthy();
        const state = await getAttributeView(siyuanAPI, avID);
        expect(state.views.find(item => item.id === state.viewID)?.groups?.find(group =>
            group.groupVal?.mSelect?.[0]?.content === "Planned")?.groupItemIds?.[0]).toBe(newRowID);

        await page.reload();
        const editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        plannedGroup = getKanbanGroup(block, "Planned");
        await expect(plannedGroup.locator(".av__gallery-item").first()).toHaveAttribute("data-id", newRowID);
        await expect(plannedGroup.locator(`.av__gallery-item[data-id="${newRowID}"]`))
            .toContainText("New planned card");
    });

    test("loads Gallery pages incrementally and uses a bounded virtual window for large data", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Gallery Pagination E2E", "Database seed");
        const inserted = await insertAttributeView(page, document.editor);
        const {avID, blockID} = inserted;
        await expectPersistedAttributeView(siyuanAPI, document.docID, blockID, avID);
        const initial = await getAttributeView(siyuanAPI, avID);
        const blockKey = initial.keyValues.find(item => item.key.type === "block");
        expect(blockKey).toBeTruthy();
        const contents = Array.from({length: 120}, (_, index) =>
            `Gallery item ${index.toString().padStart(3, "0")}`);
        await siyuanAPI.post("/api/av/appendAttributeViewDetachedBlocksWithValues", {
            avID,
            blocksValues: contents.map(content => [{
                block: {content},
                keyID: blockKey!.key.id,
            }]),
        });
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === av.viewID)?.itemIds?.length;
        }, {timeout: 30000}).toBe(contents.length);

        await page.reload();
        let editor = await getDocumentEditor(page, document.docID);
        let block = editor.locator(`:scope > [data-av-id="${avID}"]`);
        await expect(block).toBeVisible({timeout: 30000});
        const galleryViewID = await addAttributeViewView(page, block, "gallery");
        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-av-id="${avID}"]`);
        await setAttributeViewPageSize(page, block, "5");
        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-av-id="${avID}"]`);
        const cards = block.locator(".av__body .av__gallery-item");
        const loadMore = block.locator(".av__body [data-type=\"av-load-more\"]");
        await expect(cards).toHaveCount(5);
        await expect(loadMore).toBeVisible();
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const view = av.views.find(item => item.id === galleryViewID);
            return {current: av.viewID, pageSize: view?.pageSize, type: view?.type};
        }, {timeout: 30000}).toEqual({
            current: galleryViewID,
            pageSize: 5,
            type: "gallery",
        });

        let render = waitForResponse(page, "/api/av/renderAttributeView", 30000);
        await loadMore.click();
        await render;
        await expect(cards).toHaveCount(10);
        await expect(loadMore).toBeVisible();
        await expect(block.locator(".av__body")).toHaveAttribute("data-page-size", "10");

        render = waitForResponse(page, "/api/av/renderAttributeView", 30000);
        await loadMore.click();
        await render;
        await expect(cards).toHaveCount(15);
        await expect(block.locator(".av__body")).toHaveAttribute("data-page-size", "15");

        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-av-id="${avID}"]`);
        await expect(block.locator(".av__body .av__gallery-item")).toHaveCount(5);
        await expect(block.locator(".av__body")).toHaveAttribute("data-page-size", "5");

        await setAttributeViewPageSize(page, block, "all");
        await expect(block).toHaveAttribute("data-v-scroll", "true", {timeout: 30000});
        await expect(block.locator(".av__body .av__gallery-item")).toHaveCount(100);
        await expect.poll(() => block.locator(
            ".av__body .av__gallery-item .av__cell[data-dtype=\"block\"]",
        ).evaluateAll(items => items.map(item => item.textContent?.trim() || "")), {timeout: 30000}).toEqual(
            contents.slice(0, 100),
        );
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return {
                itemCount: av.views.find(view => view.id === galleryViewID)?.itemIds?.length,
                pageSize: av.views.find(view => view.id === galleryViewID)?.pageSize,
            };
        }, {timeout: 30000}).toEqual({
            itemCount: 120,
            pageSize: 102400,
        });
    });

    test("loads Kanban groups independently and restores the persisted page size after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Kanban Pagination E2E", "Database seed");
        const rows = [
            ...Array.from({length: 8}, (_, index) => ({
                content: `Planned ${index.toString().padStart(2, "0")}`,
                status: "Planned",
            })),
            ...Array.from({length: 7}, (_, index) => ({
                content: `Done ${index.toString().padStart(2, "0")}`,
                status: "Done",
            })),
        ];
        const prepared = await prepareKanban(page, document.editor, document.docID, siyuanAPI, rows);
        const {avID, blockID} = prepared;
        let block = prepared.block;
        await setAttributeViewPageSize(page, block, "5");
        await page.reload();
        let editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        let plannedGroup = getKanbanGroup(block, "Planned");
        let doneGroup = getKanbanGroup(block, "Done");
        await expect(plannedGroup.locator(".av__gallery-item")).toHaveCount(5);
        await expect(doneGroup.locator(".av__gallery-item")).toHaveCount(5);
        const plannedLoadMore = plannedGroup.locator('[data-type="av-load-more"]');
        const doneLoadMore = doneGroup.locator('[data-type="av-load-more"]');
        await expect(plannedLoadMore).toBeVisible();
        await expect(doneLoadMore).toBeVisible();

        const render = waitForResponse(page, "/api/av/renderAttributeView", 30000);
        await plannedLoadMore.click();
        await render;
        await expect(plannedGroup.locator(".av__gallery-item")).toHaveCount(8);
        await expect(doneGroup.locator(".av__gallery-item")).toHaveCount(5);
        await expect(plannedLoadMore).toBeHidden();
        await expect(doneLoadMore).toBeVisible();
        await expect(plannedGroup.locator(".av__body")).toHaveAttribute("data-page-size", "10");
        await expect(doneGroup.locator(".av__body")).toHaveAttribute("data-page-size", "5");
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === av.viewID)?.pageSize;
        }, {timeout: 30000}).toBe(5);

        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        plannedGroup = getKanbanGroup(block, "Planned");
        doneGroup = getKanbanGroup(block, "Done");
        await expect(plannedGroup.locator(".av__gallery-item")).toHaveCount(5);
        await expect(doneGroup.locator(".av__gallery-item")).toHaveCount(5);
        await expect(plannedGroup.locator(".av__body")).toHaveAttribute("data-page-size", "5");
        await expect(doneGroup.locator(".av__body")).toHaveAttribute("data-page-size", "5");
    });

    test("searches literal special text across fields and restores rows with empty values", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Search Boundary E2E", "Database seed");
        const literal = "Literal %_[] ' OR 1=1 --";
        const prepared = await prepareSearchTable(page, document.editor, document.docID, siyuanAPI, [
            {content: "Alpha row", notes: "Contains the unique needle"},
            {content: "Empty notes row"},
            {content: literal, notes: ""},
        ]);
        const {avID, block, notesColumn, rowIDs} = prepared;
        const rows = block.locator(".av__body .av__row[data-id]");

        await searchAttributeView(page, block, "unique needle");
        await expect.poll(() => rows.evaluateAll(items =>
            items.map(item => item.getAttribute("data-id"))), {timeout: 30000})
            .toEqual([rowIDs["Alpha row"]]);

        await searchAttributeView(page, block, "%_[]");
        await expect.poll(() => rows.evaluateAll(items =>
            items.map(item => item.getAttribute("data-id"))), {timeout: 30000})
            .toEqual([rowIDs[literal]]);
        await expect(rows.first().locator('[data-dtype="block"]')).toContainText(literal);

        await searchAttributeView(page, block, "missing-value");
        await expect(rows).toHaveCount(0);
        await expect(block.locator(".av__row--util [data-type=\"av-add-bottom\"]")).toBeVisible();

        await searchAttributeView(page, block, "");
        await expect.poll(() => rows.evaluateAll(items =>
            items.map(item => item.getAttribute("data-id"))), {timeout: 30000}).toEqual([
            rowIDs["Alpha row"],
            rowIDs["Empty notes row"],
            rowIDs[literal],
        ]);
        const emptyNotes = block.locator(
            `.av__row[data-id="${rowIDs["Empty notes row"]}"] [data-col-id="${notesColumn.id}"]`,
        );
        await expect(emptyNotes).toHaveText("");
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.keyValues.find(item => item.key.id === notesColumn.id)?.values
                ?.some(value => value.blockID === rowIDs["Empty notes row"]) || false;
        }, {timeout: 30000}).toBe(false);
    });

    test("removes a filtered row without losing the active Attribute View search", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Search Delete E2E", "Database seed");
        const prepared = await prepareSearchTable(page, document.editor, document.docID, siyuanAPI, [
            {content: "First match", notes: "shared needle"},
            {content: "Second match", notes: "shared needle"},
            {content: "Empty survivor"},
        ]);
        const {avID, blockID, rowIDs} = prepared;
        let block = prepared.block;
        await searchAttributeView(page, block, "shared needle");
        let rows = block.locator(".av__body .av__row[data-id]");
        await expect.poll(() => rows.evaluateAll(items =>
            items.map(item => item.getAttribute("data-id"))), {timeout: 30000}).toEqual([
            rowIDs["First match"],
            rowIDs["Second match"],
        ]);

        const firstMatch = block.locator(`.av__row[data-id="${rowIDs["First match"]}"]`);
        await firstMatch.locator(".av__firstcol").click();
        await expect(firstMatch).toHaveClass(/av__row--select/);
        const removeTransaction = waitForTransactionAction(page, "removeAttrViewBlock");
        await page.keyboard.press("Backspace");
        await removeTransaction;
        await expect(block.locator('[data-type="av-search"]')).toHaveText("shared needle");
        rows = block.locator(".av__body .av__row[data-id]");
        await expect.poll(() => rows.evaluateAll(items =>
            items.map(item => item.getAttribute("data-id"))), {timeout: 30000})
            .toEqual([rowIDs["Second match"]]);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const view = av.views.find(item => item.id === av.viewID);
            return {
                itemCount: view?.itemIds?.length,
                removed: view?.itemIds?.includes(rowIDs["First match"]) || false,
            };
        }, {timeout: 30000}).toEqual({
            itemCount: 2,
            removed: false,
        });

        await searchAttributeView(page, block, "");
        await expect.poll(() => rows.evaluateAll(items =>
            items.map(item => item.getAttribute("data-id"))), {timeout: 30000}).toEqual([
            rowIDs["Second match"],
            rowIDs["Empty survivor"],
        ]);
        await page.reload();
        const editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator('[data-type="av-search"]')).toHaveText("");
        await expect.poll(() => block.locator(".av__body .av__row[data-id]").evaluateAll(items =>
            items.map(item => item.getAttribute("data-id"))), {timeout: 30000}).toEqual([
            rowIDs["Second match"],
            rowIDs["Empty survivor"],
        ]);
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

        const {id: rowID, row: dataRow} = await addRow(page, block, "First item");
        const primaryColumnID = await block.locator('.av__row--header [data-dtype="block"]')
            .getAttribute("data-col-id");
        expect(primaryColumnID).toBeTruthy();

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
                rowIncluded: av.views.find(view => view.id === av.viewID)?.itemIds?.includes(rowID),
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
        await expectRenderedDateValue(dateCell, {
            content: date.timestamp,
            isNotEmpty: true,
            isNotTime: date.isNotTime,
        });

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const fields = Object.fromEntries(av.keyValues.map(item => [item.key.name, item]));
            const selectValue = fields.Status?.values?.find(value => value.blockID === row.id);
            const multiSelectValue = fields.Labels?.values?.find(value => value.blockID === row.id);
            const dateValue = fields["Due date"]?.values?.find(value => value.blockID === row.id);
            return {
                dateContent: dateValue?.date?.content,
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
            dateContent: date.timestamp,
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
        await expectRenderedDateValue(reloadedRow.locator(`[data-col-id="${dateColumn.id}"]`), {
            content: date.timestamp,
            isNotEmpty: true,
            isNotTime: date.isNotTime,
        });
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
        await expectRenderedDateValue(cell, {
            content: firstTimestamps.start,
            content2: firstTimestamps.end,
            hasEndDate: true,
            isNotEmpty: true,
            isNotEmpty2: true,
            isNotTime: false,
        });

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
        await expectRenderedDateValue(reloadedCell, {
            content: finalTimestamps.start,
            content2: finalTimestamps.end,
            hasEndDate: true,
            isNotEmpty: true,
            isNotEmpty2: true,
            isNotTime: false,
        });
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
        const {id: rowID, row} = await addRow(page, block, "History item");

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
            return av.views.find(view => view.id === av.viewID)?.itemIds?.includes(rowID) ?? false;
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
        expect(final.views.find(view => view.id === final.viewID)?.itemIds?.includes(rowID) ?? false).toBe(false);

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

    test("combines multi-field sorting and nested OR filters across views", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        test.slow();
        const document = await createTestDocument("Attribute View Advanced Rules E2E", "Database seed");
        const inserted = await insertAttributeView(page, document.editor);
        const {avID, blockID} = inserted;
        let block = inserted.block;
        const alphaLow = await addRow(page, block, "Alpha");
        const alphaHigh = await addRow(page, block, "Alpha");
        const bravo = await addRow(page, block, "Bravo");
        const charlie = await addRow(page, block, "Charlie");
        const scoreColumn = await addColumn(page, block, "number", "Score");
        await editCell(page, alphaLow.row.locator(`[data-col-id="${scoreColumn.id}"]`), "10");
        await editCell(page, alphaHigh.row.locator(`[data-col-id="${scoreColumn.id}"]`), "20");
        await editCell(page, bravo.row.locator(`[data-col-id="${scoreColumn.id}"]`), "15");
        await editCell(page, charlie.row.locator(`[data-col-id="${scoreColumn.id}"]`), "99");
        const primaryColumn = block.locator('.av__row--header [data-dtype="block"]');
        const primaryColumnID = await primaryColumn.getAttribute("data-col-id");
        const primaryColumnName = await primaryColumn.locator(".av__celltext").innerText();
        expect(primaryColumnID).toBeTruthy();

        await block.locator('[data-type="av-sort"]').click();
        const panel = page.locator(".av__panel .b3-menu");
        await expect(panel).toBeVisible({timeout: 15000});
        await panel.locator('[data-type="addSort"]').click();
        let menu = page.locator('#commonMenu[data-name="av-add-sort"]:not(.fn__none)');
        await expect(menu).toBeVisible();
        await requestTransaction(page, () => menu.locator(".b3-menu__item").filter({
            hasText: primaryColumnName,
        }).click());

        await panel.locator('[data-type="addSort"]').click();
        menu = page.locator('#commonMenu[data-name="av-add-sort"]:not(.fn__none)');
        await expect(menu).toBeVisible();
        await requestTransaction(page, () => menu.locator(".b3-menu__item").filter({
            hasText: "Score",
        }).click());
        const scoreSort = panel.locator(`.b3-menu__item[data-id="${scoreColumn.id}"]`);
        await requestTransaction(page, async () => {
            await scoreSort.locator("select").last().selectOption("DESC");
        });

        await panel.locator('[data-type="go-config"]').click();
        await panel.locator('[data-type="goFilters"]').click();
        await panel.locator('[data-type="addFilterCondition"][data-path=""]').click();
        let conditionMenu = page.locator('#commonMenu[data-name="addFilterCondition"]:not(.fn__none)');
        await expect(conditionMenu).toBeVisible();
        await requestTransaction(page, () => conditionMenu.locator(".b3-menu__item").nth(1).click());

        const nestedGroup = panel.locator('.av__filter-group-item[data-path="0"]');
        await expect(nestedGroup).toBeVisible();
        await nestedGroup.locator('[data-type="addFilterCondition"][data-path="0"]').click();
        conditionMenu = page.locator('#commonMenu[data-name="addFilterCondition"]:not(.fn__none)');
        await expect(conditionMenu).toBeVisible();
        await conditionMenu.locator(".b3-menu__item").first().click();
        const filterMenu = page.locator('#commonMenu[data-name="av-add-filter"]:not(.fn__none)');
        await expect(filterMenu).toBeVisible();
        await requestTransaction(page, () => filterMenu.locator(".b3-menu__item").filter({
            hasText: primaryColumnName,
        }).click());

        const combination = panel.locator('[data-type="toggleCombination"][data-path="0"]');
        await expect(combination).toBeVisible();
        await requestTransaction(page, async () => {
            await combination.selectOption("or");
        });
        const alphaFilter = panel.locator('.av__filter-row[data-path="0,0"] [data-type="filterValue"]');
        const bravoFilter = panel.locator('.av__filter-row[data-path="0,1"] [data-type="filterValue"]');
        await alphaFilter.fill("Alpha");
        await requestTransaction(page, () => alphaFilter.press("Enter"));
        await bravoFilter.fill("Bravo");
        await requestTransaction(page, () => bravoFilter.press("Enter"));

        const readCurrentRules = async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const view = av.views.find(item => item.id === av.viewID);
            const root = view?.filters?.[0] as {
                combination?: string;
                filters?: Array<{
                    combination?: string;
                    filters?: Array<{
                        column?: string;
                        operator?: string;
                        value?: {block?: {content?: string}};
                    }>;
                }>;
            };
            const nested = root?.filters?.[0];
            return {
                combination: nested?.combination,
                filters: nested?.filters?.map(filter => ({
                    column: filter.column,
                    operator: filter.operator,
                    value: filter.value?.block?.content,
                })),
                sorts: view?.sorts,
                viewID: av.viewID,
            };
        };
        const originalViewID = (await getAttributeView(siyuanAPI, avID)).viewID;
        await expect.poll(readCurrentRules, {timeout: 30000}).toEqual({
            combination: "or",
            filters: [
                {column: primaryColumnID, operator: "Contains", value: "Alpha"},
                {column: primaryColumnID, operator: "Contains", value: "Bravo"},
            ],
            sorts: [
                {column: primaryColumnID, order: "ASC"},
                {column: scoreColumn.id, order: "DESC"},
            ],
            viewID: originalViewID,
        });

        await page.reload();
        let editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expectRowOrder(block, [alphaHigh.id, alphaLow.id, bravo.id]);
        const isolatedViewID = await addAttributeViewView(page, block, "table");
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const view = av.views.find(item => item.id === isolatedViewID);
            const countFilterLeaves = (filters: Array<{column?: string; filters?: unknown[]}> = []): number =>
                filters.reduce((count, filter) => count + (filter.filters
                    ? countFilterLeaves(filter.filters as Array<{column?: string; filters?: unknown[]}>)
                    : (filter.column ? 1 : 0)), 0);
            return {
                current: av.viewID,
                filterLeaves: countFilterLeaves(view?.filters),
                sortCount: view?.sorts?.length || 0,
            };
        }, {timeout: 30000}).toEqual({
            current: isolatedViewID,
            filterLeaves: 0,
            sortCount: 0,
        });

        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expectRowOrder(block, [alphaLow.id, alphaHigh.id, bravo.id, charlie.id]);
        await requestTransaction(page, () => block.locator(
            `.av__views .layout-tab-bar .item[data-id="${originalViewID}"]`,
        ).click());
        await expect.poll(async () => (await getAttributeView(siyuanAPI, avID)).viewID, {
            timeout: 30000,
        }).toBe(originalViewID);

        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator('[data-type="av-sort"]')).toHaveClass(/block__icon--active/);
        await expect(block.locator('[data-type="av-filter"]')).toHaveClass(/block__icon--active/);
        await expectRowOrder(block, [alphaHigh.id, alphaLow.id, bravo.id]);
        await expect.poll(readCurrentRules, {timeout: 30000}).toMatchObject({
            combination: "or",
            viewID: originalViewID,
        });
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

    test("sorts, hides, folds, and removes attribute view groups", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Group State E2E", "Database seed");
        const inserted = await insertAttributeView(page, document.editor);
        const {avID, blockID} = inserted;
        let block = inserted.block;
        const planned = await addRow(page, block, "Planned item");
        const done = await addRow(page, block, "Done item");
        const empty = await addRow(page, block, "Unassigned item");
        const statusColumn = await addColumn(page, block, "select", "Status");
        await statusColumn.header.click();
        const headerMenu = page.locator('#commonMenu[data-name="av-header-cell"]:not(.fn__none)');
        await expect(headerMenu).toBeVisible();
        await headerMenu.locator('[data-id="edit"]').click();
        const columnPanel = page.locator(".av__panel");
        const addOptionInput = columnPanel.locator('[data-type="addOption"]');
        await expect(addOptionInput).toBeVisible();
        await addOptionInput.fill("Deferred");
        await requestTransaction(page, () => addOptionInput.press("Enter"));
        await columnPanel.locator('[data-type="close"]').click({position: {x: 5, y: 5}});
        await expect(columnPanel).toHaveCount(0);
        await editSelectCell(page, planned.row.locator(`[data-col-id="${statusColumn.id}"]`), ["Planned"]);
        await editSelectCell(page, done.row.locator(`[data-col-id="${statusColumn.id}"]`), ["Done"]);

        let panel = await openAttributeViewConfig(page, block);
        await panel.locator('[data-type="goGroups"]').click();
        await Promise.all([
            waitForResponse(page, "/api/av/setAttrViewGroup"),
            panel.locator(`[data-type="setGroupMethod"][data-id="${statusColumn.id}"]`).click(),
        ]);
        await expect(block.locator(".av__body[data-group-id]")).toHaveCount(3, {timeout: 30000});

        const hideEmpty = panel.locator('input[type="checkbox"]');
        await expect(hideEmpty).toBeChecked();
        await Promise.all([
            waitForResponse(page, "/api/av/setAttrViewGroup"),
            hideEmpty.click(),
        ]);
        await expect(block.locator(".av__body[data-group-id]")).toHaveCount(4, {timeout: 30000});

        await panel.locator('[data-type="goGroupsSort"]').click();
        let menu = page.locator('#commonMenu[data-name="avGroupSort"]:not(.fn__none)');
        await expect(menu).toBeVisible();
        const descendingLabel = await page.evaluate(() => window.siyuan.languages.desc);
        await Promise.all([
            waitForResponse(page, "/api/av/setAttrViewGroup"),
            menu.locator(".b3-menu__item").filter({
                has: page.locator(".b3-menu__label", {hasText: descendingLabel}),
            }).click(),
        ]);
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(item => item.id === av.viewID)?.group?.order;
        }, {timeout: 30000}).toBe(1);
        await page.reload();
        let editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect.poll(() => block.locator(".av__group-title .b3-chip").evaluateAll(chips =>
            chips.map(chip => chip.textContent?.trim() || "")), {timeout: 30000})
            .toEqual(["Planned", "Done", "Deferred"]);

        panel = await openAttributeViewConfig(page, block);
        await panel.locator('[data-type="goGroups"]').click();
        const doneMenuItem = panel.locator("button.b3-menu__item[data-id]").filter({hasText: "Done"});
        const doneGroupID = await doneMenuItem.getAttribute("data-id");
        expect(doneGroupID).toBeTruthy();
        const doneVisibility = doneMenuItem.locator('[data-type="hideGroup"]');
        const toggleDoneVisibility = async () => {
            const transaction = waitForTransactionAction(page, "hideAttrViewGroup");
            await doneVisibility.click();
            const response = await transaction;
            const payload = response.request().postDataJSON() as {
                transactions: Array<{
                    doOperations: Array<{
                        action: string;
                        data?: number;
                        id?: string;
                    }>;
                }>;
            };
            return payload.transactions.flatMap(item => item.doOperations)
                .find(operation => operation.action === "hideAttrViewGroup");
        };
        if (await doneVisibility.locator("use").getAttribute("xlink:href") !== "#iconEye") {
            expect(await toggleDoneVisibility()).toMatchObject({data: 0, id: doneGroupID});
            await expect.poll(async () => {
                const av = await getAttributeView(siyuanAPI, avID);
                const view = av.views.find(item => item.id === av.viewID);
                return view?.groups?.find(group =>
                    group.groupVal?.mSelect?.[0]?.content === "Done")?.groupHidden;
            }, {timeout: 30000}).toBe(0);
        }
        expect(await toggleDoneVisibility()).toMatchObject({data: 2, id: doneGroupID});
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const view = av.views.find(item => item.id === av.viewID);
            return view?.groups?.find(group =>
                group.groupVal?.mSelect?.[0]?.content === "Done")?.groupHidden;
        }, {timeout: 30000}).toBe(2);

        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator(".av__group-title").filter({hasText: "Done"})).toHaveCount(0);
        const plannedTitle = block.locator(".av__group-title").filter({hasText: "Planned"});
        const plannedFold = plannedTitle.locator('[data-type="av-group-fold"]');
        const foldTransaction = waitForTransactionAction(page, "foldAttrViewGroup");
        await plannedFold.click();
        await foldTransaction;
        await expect(plannedTitle.locator("xpath=following-sibling::*[1]")).toHaveClass(/fn__none/);

        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            const view = av.views.find(item => item.id === av.viewID);
            const groups = new Map(view?.groups?.map(group => [
                group.groupVal?.mSelect?.[0]?.content || "",
                {
                    folded: group.groupFolded,
                    hidden: group.groupHidden,
                },
            ]));
            return {
                doneHidden: groups.get("Done")?.hidden,
                group: view?.group && {
                    field: view.group.field,
                    hideEmpty: view.group.hideEmpty,
                    method: view.group.method,
                    order: view.group.order,
                },
                plannedFolded: groups.get("Planned")?.folded,
            };
        }, {timeout: 30000}).toEqual({
            doneHidden: 2,
            group: {
                field: statusColumn.id,
                hideEmpty: false,
                method: 0,
                order: 1,
            },
            plannedFolded: true,
        });

        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        const reloadedPlannedTitle = block.locator(".av__group-title").filter({hasText: "Planned"});
        await expect(reloadedPlannedTitle.locator("xpath=following-sibling::*[1]")).toHaveClass(/fn__none/);
        await expect(block.locator(".av__group-title").filter({hasText: "Done"})).toHaveCount(0);
        await expect(block.locator(".av__body[data-group-id]")).toHaveCount(3);

        panel = await openAttributeViewConfig(page, block);
        await panel.locator('[data-type="goGroups"]').click();
        const removeTransaction = waitForTransactionAction(page, "removeAttrViewGroup");
        await panel.locator('[data-type="removeGroups"]').click();
        await removeTransaction;
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(item => item.id === av.viewID)?.group || null;
        }, {timeout: 30000}).toBeNull();

        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block.locator(".av__group-title")).toHaveCount(0);
        await expectRowOrder(block, [planned.id, done.id, empty.id]);
    });

    test("pastes beyond existing rows while the database uses virtual scrolling", async ({
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

        const pasteContents = Array.from({length: 130}, (_, index) =>
            `Pasted ${index.toString().padStart(3, "0")}`);
        const firstCell = reloadedBlock.locator(".av__body .av__row[data-id] [data-dtype=block]").first();
        await firstCell.click();
        await page.keyboard.press("Escape");
        await expect(firstCell).toHaveClass(/av__cell--select/);
        const pasteTarget = reloadedBlock.locator('.av__cursor[contenteditable="true"]').first();
        await pasteTarget.evaluate((element) => {
            element.focus();
            const range = element.ownerDocument.createRange();
            range.selectNodeContents(element);
            range.collapse(false);
            const selection = element.ownerDocument.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
        });
        await expect(firstCell).toHaveClass(/av__cell--select/);
        const pasteRowsResponse = waitForResponse(page, "/api/av/getAttributeViewPasteRows");
        const pasteTransaction = waitForResponse(page, "/api/transactions");
        await pasteTarget.evaluate((element, text) => {
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", text);
            element.dispatchEvent(new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData,
            }));
        }, pasteContents.join("\n"));
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
        await expect(block.locator(".av__cell--select")).toHaveCount(1);

        const pasteTarget = block.locator('.av__cursor[contenteditable="true"]').first();
        await pasteTarget.evaluate((element) => {
            element.focus();
            const range = element.ownerDocument.createRange();
            range.selectNodeContents(element);
            range.collapse(false);
            const selection = element.ownerDocument.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
        });
        await expect(firstCell).toHaveClass(/av__cell--select/);
        await expect(block.locator(".av__cell--select")).toHaveCount(1);

        const pasteRowsResponse = waitForResponse(page, "/api/av/getAttributeViewPasteRows");
        const pasteTransaction = waitForResponse(page, "/api/transactions");
        await pasteTarget.evaluate((element) => {
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", "q\tw\ne\tr\nt\ty");
            clipboardData.setData("text/html",
                "<table><thead><tr><th>q</th><th>w</th></tr></thead><tbody><tr><td>e</td><td>r</td></tr>" +
                "<tr><td>t</td><td>y</td></tr></tbody></table>");
            element.dispatchEvent(new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData,
            }));
        });
        const pasteAsData = page.locator('.b3-dialog button[data-action="data"]:visible');
        await expect(pasteAsData).toBeVisible();
        await pasteAsData.click();
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

    test("supports database range selection across virtual rows and pastes into every selected row", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Range Selection Virtual E2E", "Database seed");
        const {avID, blockID} = await insertAttributeView(page, document.editor);
        await expectPersistedAttributeView(siyuanAPI, document.docID, blockID, avID);
        const blockKey = (await getAttributeView(siyuanAPI, avID)).keyValues.find(item => item.key.type === "block");
        expect(blockKey).toBeTruthy();
        const seedContents = Array.from({length: 120}, (_, index) =>
            `Range seed ${index.toString().padStart(3, "0")}`);
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
        const editor = await getDocumentEditor(page, document.docID);
        const block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await setAttributeViewPageSize(page, block, "all");
        await expect(block).toHaveAttribute("data-v-scroll", "true", {timeout: 30000});
        const itemIDs = (await getOrderedBlockContents(siyuanAPI, avID)).itemIds;
        expect(itemIDs).toHaveLength(seedContents.length);

        const firstRow = block.locator(`.av__row[data-id="${itemIDs[0]}"]`);
        await firstRow.locator(".av__firstcol").click();
        await expect(firstRow).toHaveClass(/av__row--select/);

        const content = block.locator(
            "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle-content ')][1]",
        );
        const lastRow = block.locator(`.av__row[data-id="${itemIDs.at(-1)}"]`);
        await expect(async () => {
            await content.evaluate(element => {
                element.scrollTop = element.scrollHeight;
                element.dispatchEvent(new Event("scroll"));
            });
            await expect(lastRow).toHaveCount(1, {timeout: 2000});
            await lastRow.locator(".av__firstcol").dispatchEvent("click", {
                button: 0,
                shiftKey: true,
            });
            await expect(lastRow).toHaveClass(/av__row--select/, {timeout: 2000});
        }).toPass({timeout: 30000});

        const selectionCount = block.locator(".av__views--selection .av__selection-count");
        await expect(selectionCount).toContainText("120");
        await block.locator('[data-type="av-selection-more"]').click();
        const fieldsMenuItem = page.locator('.b3-menu [data-id="fields"]');
        await expect(fieldsMenuItem).toBeVisible();
        await expect(selectionCount).toContainText("120");
        await page.keyboard.press("Escape");
        await expect(fieldsMenuItem).toHaveCount(0);

        const pasteTarget = block.locator('.av__cursor[contenteditable="true"]').first();
        await pasteTarget.evaluate(element => {
            element.focus();
            const range = element.ownerDocument.createRange();
            range.selectNodeContents(element);
            range.collapse(false);
            const selection = element.ownerDocument.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
        });
        const transaction = waitForResponse(page, "/api/transactions", 30000);
        await pasteTarget.evaluate((element, text) => {
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", text);
            element.dispatchEvent(new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData,
            }));
        }, "Range pasted");
        await transaction;
        await expect.poll(() => getOrderedBlockContents(siyuanAPI, avID), {timeout: 30000}).toMatchObject({
            contents: seedContents.map(() => "Range pasted"),
        });
        await expect(lastRow.locator('[data-dtype="block"]')).toContainText("Range pasted", {timeout: 30000});
        await expect(block).not.toHaveAttribute("data-rendering", "true", {timeout: 30000});
        await expect(selectionCount).toContainText("120");

        await block.locator(".av__title").click();
        await expect(selectionCount).toHaveCount(0);
        await searchAttributeView(page, block, "does-not-match-range-selection");
        await searchAttributeView(page, block, "");
        await expect(block.locator(".av__row--select[data-id]")).toHaveCount(0);
    });

    test("uses the exact duplicate card occurrence as the database range selection anchor", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Attribute View Range Selection Grouped Gallery E2E",
            "Database seed");
        const inserted = await insertAttributeView(page, document.editor);
        const {avID, blockID} = inserted;
        const statusColumn = await addColumn(page, inserted.block, "mSelect", "Status", "multiSelect");
        await expectPersistedAttributeView(siyuanAPI, document.docID, blockID, avID);
        const blockKey = (await getAttributeView(siyuanAPI, avID)).keyValues.find(item => item.key.type === "block");
        expect(blockKey).toBeTruthy();
        await siyuanAPI.post("/api/av/appendAttributeViewDetachedBlocksWithValues", {
            avID,
            blocksValues: [[{
                block: {content: "Duplicate card"},
                keyID: blockKey!.key.id,
            }, {
                keyID: statusColumn.id,
                mSelect: [
                    {color: "1", content: "Alpha"},
                    {color: "2", content: "Beta"},
                ],
            }]],
        });
        await siyuanAPI.post("/api/av/appendAttributeViewDetachedBlocksWithValues", {
            avID,
            blocksValues: [
                [{
                    block: {content: "Alpha target"},
                    keyID: blockKey!.key.id,
                }, {
                    keyID: statusColumn.id,
                    mSelect: [{color: "1", content: "Alpha"}],
                }],
                [{
                    block: {content: "Beta target"},
                    keyID: blockKey!.key.id,
                }, {
                    keyID: statusColumn.id,
                    mSelect: [{color: "2", content: "Beta"}],
                }],
            ],
        });
        await expect.poll(async () => {
            const av = await getAttributeView(siyuanAPI, avID);
            return av.views.find(view => view.id === av.viewID)?.itemIds?.length;
        }, {timeout: 30000}).toBe(3);

        await page.reload();
        let editor = await getDocumentEditor(page, document.docID);
        let block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await convertToGroupedLayout(page, block, statusColumn.id, "gallery");
        await page.reload();
        editor = await getDocumentEditor(page, document.docID);
        block = editor.locator(`:scope > [data-node-id="${blockID}"]`);
        await expect(block).toHaveAttribute("data-av-type", "gallery");

        const av = await getAttributeView(siyuanAPI, avID);
        const blockValues = av.keyValues.find(item => item.key.type === "block")?.values || [];
        const duplicateID = blockValues.find(value => value.block?.content === "Duplicate card")?.blockID;
        const betaTargetID = blockValues.find(value => value.block?.content === "Beta target")?.blockID;
        expect(duplicateID).toBeTruthy();
        expect(betaTargetID).toBeTruthy();
        const alphaBody = block.locator(".av__group-title").filter({hasText: "Alpha"})
            .locator("xpath=following-sibling::*[1]");
        const betaBody = block.locator(".av__group-title").filter({hasText: "Beta"})
            .locator("xpath=following-sibling::*[1]");
        const alphaDuplicate = alphaBody.locator(`.av__gallery-item[data-id="${duplicateID}"]`);
        const betaDuplicate = betaBody.locator(`.av__gallery-item[data-id="${duplicateID}"]`);
        const betaTarget = betaBody.locator(`.av__gallery-item[data-id="${betaTargetID}"]`);
        await expect(alphaDuplicate).toBeVisible();
        await expect(betaDuplicate).toBeVisible();
        await expect(betaTarget).toBeVisible();

        const toggleModifier = process.platform === "darwin" ? "Meta" as const : "Control" as const;
        await betaDuplicate.click({modifiers: [toggleModifier]});
        await expect(betaDuplicate).toHaveClass(/av__gallery-item--select/);
        await expect(alphaDuplicate).not.toHaveClass(/av__gallery-item--select/);
        await betaTarget.click({modifiers: ["Shift"]});

        await expect(betaDuplicate).toHaveClass(/av__gallery-item--select/);
        await expect(betaTarget).toHaveClass(/av__gallery-item--select/);
        await expect(alphaDuplicate).not.toHaveClass(/av__gallery-item--select/);
        await expect(block.locator(".av__counter:not(.fn__none)").first()).toContainText("2");
    });

    test("collapses a database cell range to its anchor after fields are reordered", async ({
        createTestDocument,
        page,
    }) => {
        const document = await createTestDocument("Attribute View Range Selection Column Sort E2E", "Database seed");
        const inserted = await insertAttributeView(page, document.editor);
        const notesColumn = await addColumn(page, inserted.block, "text", "Range notes");
        const extraColumn = await addColumn(page, inserted.block, "text", "Reordered field");
        const rows = [
            await addRow(page, inserted.block, "First row"),
            await addRow(page, inserted.block, "Second row"),
            await addRow(page, inserted.block, "Third row"),
        ];
        const anchorCell = rows[0].row.locator(`[data-col-id="${notesColumn.id}"]`);
        const focusCell = rows[2].row.locator(`[data-col-id="${notesColumn.id}"]`);
        await anchorCell.dispatchEvent("mousedown", {button: 0, buttons: 1});
        await anchorCell.dispatchEvent("mouseup", {button: 0, buttons: 0});
        await expect(anchorCell).toHaveClass(/av__cell--select/);
        await focusCell.click({modifiers: ["Shift"]});
        await expect(inserted.block.locator(
            `.av__cell--active[data-col-id="${notesColumn.id}"]`,
        )).toHaveCount(3);

        const sourceHeader = inserted.block.locator(
            `.av__cell--header[data-col-id="${extraColumn.id}"]`,
        );
        const targetHeader = inserted.block.locator(
            `.av__cell--header[data-col-id="${notesColumn.id}"]`,
        );
        const targetBox = await targetHeader.boundingBox();
        expect(targetBox).not.toBeNull();
        await expect(inserted.block).not.toHaveAttribute("data-rendering", "true", {timeout: 30000});
        let dataTransfer: JSHandle<DataTransfer> | undefined;
        await expect(async () => {
            dataTransfer = await page.evaluateHandle(() => new DataTransfer()) as JSHandle<DataTransfer>;
            await sourceHeader.dispatchEvent("dragstart", {dataTransfer});
            const point = {
                clientX: targetBox!.x + 2,
                clientY: targetBox!.y + targetBox!.height / 2,
            };
            await targetHeader.dispatchEvent("dragenter", {dataTransfer, ...point});
            await targetHeader.dispatchEvent("dragover", {dataTransfer, ...point});
            await targetHeader.dispatchEvent("dragover", {dataTransfer, ...point});
            try {
                await expect(targetHeader).toHaveClass(/dragover__left/, {timeout: 2000});
            } catch (error) {
                await sourceHeader.dispatchEvent("dragend", {dataTransfer});
                await dataTransfer.dispose();
                dataTransfer = undefined;
                throw error;
            }
        }).toPass({timeout: 30000});
        const sortTransaction = waitForTransactionAction(page, "sortAttrViewCol");
        await targetHeader.dispatchEvent("drop", {
            dataTransfer,
            clientX: targetBox!.x + 2,
            clientY: targetBox!.y + targetBox!.height / 2,
        });
        await sortTransaction;
        await sourceHeader.dispatchEvent("dragend", {dataTransfer});
        await dataTransfer!.dispose();

        await expect(inserted.block.locator(".av__cell--active")).toHaveCount(1);
        await expect(rows[0].row.locator(`[data-col-id="${notesColumn.id}"]`))
            .toHaveClass(/av__cell--active/);
        await expect(rows[0].row.locator(`[data-col-id="${notesColumn.id}"]`))
            .toHaveClass(/av__cell--select/);
    });
});
