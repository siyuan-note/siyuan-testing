import {expect, Locator, Page, Route} from "@playwright/test";
import {ISiyuanResponse, ISearchResult, SiyuanAPI} from "./siyuanAPI";

const KEYWORD_METHOD_ICON = "#iconExact";
const SEARCH_STORAGE_KEYS = ["local-searchdata", "local-searchkeys", "local-movepath"];

export interface ISearchSession {
    dialog: Locator;
    input: Locator;
    results: Locator;
}

export interface ISearchRequest {
    query: string;
    method: number;
    paths: string[];
    types?: Record<string, boolean>;
}

interface ISearchResponse {
    data: ISearchResult;
    request: ISearchRequest;
}

const getMethodIcon = (dialog: Locator) => dialog.locator("#searchSyntaxCheck use").evaluate((element) =>
    element.getAttribute("href") || element.getAttribute("xlink:href") || "");

const selectSearchMethod = async (page: Page, dialog: Locator, icon: string) => {
    await dialog.locator("#searchSyntaxCheck").click();
    const items = page.locator(".b3-menu:not(.fn__none) .b3-menu__item");
    let selected = false;
    for (let index = 0; index < await items.count(); index++) {
        const item = items.nth(index);
        const use = item.locator("use").first();
        if (await use.count() === 0) {
            continue;
        }
        const itemIcon = await use.evaluate((element) =>
            element.getAttribute("href") || element.getAttribute("xlink:href") || "");
        if (itemIcon === icon) {
            await item.click();
            selected = true;
            break;
        }
    }
    expect(selected, `search method ${icon} is available`).toBe(true);
    await expect.poll(() => getMethodIcon(dialog)).toBe(icon);
};

const openSearch = async (page: Page) => {
    await page.locator("#barSearch").click();
    const input = page.locator(".b3-dialog--open #searchInput").first();
    await expect(input).toBeVisible();
    const dialog = input.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' b3-dialog--open ')][1]",
    );
    return {dialog, input, results: dialog.locator("#searchList")};
};

export const withSearchMethod = async (page: Page, methodIcon: string,
                                       action: (session: ISearchSession) => Promise<void>) => {
    const originalStorage = await page.evaluate((keys) => Object.fromEntries(keys.map(key => [
        key,
        structuredClone(window.siyuan.storage[key]),
    ])), SEARCH_STORAGE_KEYS);
    await page.evaluate(() => {
        const config = window.siyuan.storage["local-searchdata"] as {
            removed: boolean;
            page: number;
            sort: number;
            group: number;
            hasReplace: boolean;
            hPath: string;
            idPath: string[];
            k: string;
            r: string;
            types: Record<string, boolean>;
            subTypes: Record<string, boolean>;
            replaceTypes: Record<string, boolean>;
        };
        Object.assign(config, {
            removed: true,
            page: 1,
            sort: 0,
            group: 0,
            hasReplace: false,
            hPath: "",
            idPath: [],
            k: "",
            r: "",
        });
        Object.keys(config.types).forEach(type => {
            config.types[type] = true;
        });
        Object.keys(config.subTypes).forEach(type => {
            config.subTypes[type] = false;
        });
        config.replaceTypes.text = true;
    });
    const storageRoute = async (route: Route) => {
        const request = route.request();
        let key = "";
        try {
            key = request.postDataJSON().key;
        } catch {
            await route.continue();
            return;
        }
        if (!SEARCH_STORAGE_KEYS.includes(key)) {
            await route.continue();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({code: 0, msg: "", data: null}),
        });
    };
    await page.route("**/api/storage/setLocalStorageVal", storageRoute);
    let session = await openSearch(page);
    if (await getMethodIcon(session.dialog) !== methodIcon) {
        await selectSearchMethod(page, session.dialog, methodIcon);
    }
    try {
        await action(session);
    } finally {
        if (await session.dialog.isVisible()) {
            await page.keyboard.press("Escape");
            await expect(session.dialog).toHaveCount(0);
        }
        await page.evaluate(({keys, storage}) => {
            keys.forEach(key => {
                window.siyuan.storage[key] = structuredClone(storage[key]);
            });
        }, {keys: SEARCH_STORAGE_KEYS, storage: originalStorage});
        await page.unroute("**/api/storage/setLocalStorageVal", storageRoute);
    }
};

export const withKeywordSearch = async (page: Page, action: (session: ISearchSession) => Promise<void>) =>
    withSearchMethod(page, KEYWORD_METHOD_ICON, action);

export const runAndWaitForSearch = async (page: Page, session: ISearchSession,
                                          matches: (request: ISearchRequest) => boolean,
                                          action: () => Promise<void>): Promise<ISearchResponse> => {
    const responsePromise = page.waitForResponse((response) => {
        if (!response.url().endsWith("/api/search/fullTextSearchBlock") || response.request().method() !== "POST") {
            return false;
        }
        try {
            return matches(response.request().postDataJSON() as ISearchRequest);
        } catch {
            return false;
        }
    }, {timeout: 30000});
    await action();
    const response = await responsePromise;
    const result = await response.json() as ISiyuanResponse<ISearchResult>;
    expect(result.code).toBe(0);
    await expect(session.dialog.locator(".fn__loading").last()).toHaveClass(/fn__none/);
    return {
        data: result.data,
        request: response.request().postDataJSON() as ISearchRequest,
    };
};

export const submitSearch = async (page: Page, session: ISearchSession, query: string) => {
    const response = await runAndWaitForSearch(page, session, request => request.query === query,
        () => session.input.fill(query));
    return response.data;
};

export const expectSearchIndex = async (api: SiyuanAPI, query: string, rootID: string, present = true) => {
    await expect.poll(async () => {
        const result = await api.searchBlocks(query);
        return result.blocks.some(block => block.rootID === rootID);
    }, {timeout: 15000}).toBe(present);
};
