import {expect, Locator, Page} from "@playwright/test";
import {SiyuanAPI} from "./siyuanAPI";

export interface ITitleSource {
    text: string;
    empty: boolean;
    revision: string;
    blockDOM: string;
    source: {spec: number; format: string; content: string} | null;
}

export const getTitle = (page: Page, id: string) => page.locator(
    `.protyle-title[data-node-id="${id}"]:visible .protyle-title__rich .protyle-title__input`,
).last();

export const readTitle = (api: SiyuanAPI, id: string) => api.post<ITitleSource>("/api/block/getDocTitle", {id});

export const setTitleSource = async (api: SiyuanAPI, id: string, nodes: Array<Record<string, unknown>>) => {
    const before = await readTitle(api, id);
    await api.post("/api/transactions", {
        app: "siyuan-testing", session: id, reqId: Date.now(),
        transactions: [{doOperations: [{action: "setDocTitle", id, data: {
            source: {spec: 1, format: "inline-ast", content: JSON.stringify(nodes)},
            expectedRevision: before.revision,
        }}]}],
    });
    return readTitle(api, id);
};

export const pasteParagraphIntoTitle = async (source: Locator, title: Locator, clear = false) => {
    await source.focus();
    const clipboard = await source.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        const data = new DataTransfer();
        element.dispatchEvent(new ClipboardEvent("copy", {bubbles: true, cancelable: true, clipboardData: data}));
        return Object.fromEntries(Array.from(data.types, type => [type, data.getData(type)]));
    });
    expect(clipboard["text/html"]).toBeTruthy();
    // Clear first so a pasted single dynamic reference does not become a static selection label.
    if (clear) await title.fill("");
    await title.focus();
    await title.evaluate((element, clipboard) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        const data = new DataTransfer();
        Object.entries(clipboard).forEach(([type, value]) => data.setData(type, value));
        element.dispatchEvent(new ClipboardEvent("paste", {bubbles: true, cancelable: true, clipboardData: data}));
    }, clipboard);
    await title.press("Tab");
};
