import {expect, Page} from "@playwright/test";

interface INotebook {
    id: string;
    name: string;
    closed: boolean;
}

interface IAPIResponse<T> {
    code: number;
    msg: string;
    data: T;
}

export const ensureTestNotebook = async (page: Page) => {
    const response = await page.evaluate(async () => {
        const post = async <T>(path: string, body: object) => {
            const request = await fetch(path, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(body),
            });
            return request.json() as Promise<IAPIResponse<T>>;
        };
        const notebooksResponse = await post<{notebooks: INotebook[]}>("/api/notebook/lsNotebooks", {});
        if (notebooksResponse.code !== 0) {
            return notebooksResponse as IAPIResponse<unknown>;
        }
        let notebook = notebooksResponse.data.notebooks.find(item => item.name === "Test");
        if (!notebook) {
            const createResponse = await post<{notebook: INotebook}>("/api/notebook/createNotebook", {name: "Test"});
            if (createResponse.code !== 0) {
                return createResponse as IAPIResponse<unknown>;
            }
            notebook = createResponse.data.notebook;
        } else if (notebook.closed) {
            const openResponse = await post<null>("/api/notebook/openNotebook", {notebook: notebook.id});
            if (openResponse.code !== 0) {
                return openResponse as IAPIResponse<unknown>;
            }
        }
        return {code: 0, msg: "", data: notebook.id} as IAPIResponse<string>;
    });
    expect(response, response.msg).toMatchObject({code: 0});
    return response.data as string;
};

export const createTestDocument = async (page: Page, titlePrefix: string, markdown = "") => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);
    const notebookID = await ensureTestNotebook(page);
    const title = `${titlePrefix} ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const response = await page.evaluate(async ({notebook, path, content}) => {
        const request = await fetch("/api/filetree/createDocWithMd", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({notebook, path, markdown: content}),
        });
        return request.json() as Promise<IAPIResponse<string>>;
    }, {notebook: notebookID, path: `/${title}`, content: markdown});
    expect(response, response.msg).toMatchObject({code: 0});
    const docID = response.data;

    await page.goto(`http://127.0.0.1:6806/?id=${docID}`);
    const titleElement = page.locator(`.protyle-title[data-node-id="${docID}"]`);
    await expect(titleElement).toBeAttached({timeout: 15000});
    const editor = page.locator(".protyle-wysiwyg").last();
    await editor.waitFor({state: "attached", timeout: 10000});
    return {docID, editor, notebookID, title};
};
