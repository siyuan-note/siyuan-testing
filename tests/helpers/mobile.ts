import {expect, Page} from "@playwright/test";
import {SiyuanAPI} from "./siyuanAPI";
import {ensureTestNotebook, TestDocumentTracker} from "./testNotebook";

export const mobileEditor = (page: Page) => page.locator("#editor > .protyle-content > .protyle-wysiwyg:visible");

export const mobileTitle = (page: Page, id: string) => page.locator(
    `#toolbarNameReadonly > [data-document-title-id="${id}"]`,
);

export const openMobileTitleEditor = async (page: Page, id: string) => {
    const title = mobileTitle(page, id);
    await expect(title).toBeVisible();
    const input = title.locator(".protyle-title__input");
    if (!await input.isVisible()) {
        await page.locator("#toolbarNameReadonly").tap();
    }
    await expect(input).toBeEditable();
    return input;
};

export const openMobileDocument = async (page: Page, id: string) => {
    await page.goto(`/stage/build/mobile/?id=${id}`);
    await expect(mobileTitle(page, id)).toBeVisible({timeout: 30000});
    await expect(mobileEditor(page)).toBeVisible({timeout: 15000});
    await expect(page.locator("#editor")).toHaveAttribute("data-loading", "finished");
    await expect.poll(() => page.evaluate(() => {
        const runtime = window.siyuan as typeof window.siyuan & {ws?: {ws?: WebSocket}};
        return runtime.ws?.ws?.readyState;
    }), {timeout: 15000}).toBe(1);
    await expect(page.locator("#errorLog")).toHaveCount(0);
    return mobileEditor(page);
};

export const createMobileTestDocument = async (page: Page, api: SiyuanAPI, track: TestDocumentTracker,
                                                titlePrefix: string, markdown: string) => {
    const notebookID = await ensureTestNotebook(api);
    const title = `${titlePrefix} ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const docID = await api.createDocument(notebookID, title, markdown);
    track({id: docID, notebookID, title});
    const editor = await openMobileDocument(page, docID);
    return {docID, notebookID, title, editor};
};
