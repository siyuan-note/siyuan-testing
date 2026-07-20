import {expect, Locator, Page} from "@playwright/test";
import {ISiyuanResponse, ISearchResult, SiyuanAPI} from "./siyuanAPI";

const KEYWORD_METHOD_ICON = "#iconExact";

interface ISearchSession {
    dialog: Locator;
    input: Locator;
    results: Locator;
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

export const withKeywordSearch = async (page: Page, action: (session: ISearchSession) => Promise<void>) => {
    let session = await openSearch(page);
    const originalMethod = await getMethodIcon(session.dialog);
    if (originalMethod !== KEYWORD_METHOD_ICON) {
        await selectSearchMethod(page, session.dialog, KEYWORD_METHOD_ICON);
    }
    try {
        await action(session);
    } finally {
        if (originalMethod !== KEYWORD_METHOD_ICON) {
            if (!await session.dialog.isVisible()) {
                session = await openSearch(page);
            }
            await selectSearchMethod(page, session.dialog, originalMethod);
        }
        if (await session.dialog.isVisible()) {
            await page.keyboard.press("Escape");
            await expect(session.dialog).toHaveCount(0);
        }
    }
};

export const submitSearch = async (page: Page, session: ISearchSession, query: string) => {
    const responsePromise = page.waitForResponse((response) => {
        if (!response.url().endsWith("/api/search/fullTextSearchBlock") || response.request().method() !== "POST") {
            return false;
        }
        try {
            return response.request().postDataJSON().query === query;
        } catch {
            return false;
        }
    });
    await session.input.fill(query);
    const response = await responsePromise;
    const result = await response.json() as ISiyuanResponse<ISearchResult>;
    expect(result.code).toBe(0);
    await expect(session.dialog.locator(".fn__loading").last()).toHaveClass(/fn__none/);
    return result.data;
};

export const expectSearchIndex = async (api: SiyuanAPI, query: string, rootID: string, present = true) => {
    await expect.poll(async () => {
        const result = await api.searchBlocks(query);
        return result.blocks.some(block => block.rootID === rootID);
    }, {timeout: 15000}).toBe(present);
};
