import {expect, Page} from "@playwright/test";
import {SiyuanAPI} from "./siyuanAPI";
import {ensureTestNotebook, TestDocumentTracker} from "./testNotebook";

export const mobileEditor = (page: Page) => page.locator("#editor .protyle-wysiwyg:visible");

export const openMobileDocument = async (page: Page, id: string) => {
    await page.goto(`/stage/build/mobile/?id=${id}`);
    await expect(page.locator("#toolbarName")).toBeVisible({timeout: 30000});
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
