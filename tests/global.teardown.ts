import {expect, test} from "@playwright/test";
import {TEST_NOTEBOOK_NAME} from "./helpers/testNotebook";

interface INotebook {
    id: string;
    name: string;
}

interface IAPIResponse<T> {
    code: number;
    msg: string;
    data: T;
}

test(`remove empty ${TEST_NOTEBOOK_NAME} notebook`, async ({page}) => {
    await page.goto("http://127.0.0.1:6806");
    const response = await page.evaluate(async (notebookName) => {
        const post = async <T>(path: string, body: object) => {
            const request = await fetch(path, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(body),
            });
            return request.json() as Promise<IAPIResponse<T>>;
        };
        const notebooks = await post<{notebooks: INotebook[]}>("/api/notebook/lsNotebooks", {});
        if (notebooks.code !== 0) {
            return notebooks as IAPIResponse<unknown>;
        }
        const notebook = notebooks.data.notebooks.find(item => item.name === notebookName);
        if (!notebook) {
            return {code: 0, msg: "", data: null} as IAPIResponse<null>;
        }
        const docs = await post<{files: unknown[]}>("/api/filetree/listDocsByPath", {
            notebook: notebook.id,
            path: "/",
        });
        if (docs.code !== 0) {
            return docs as IAPIResponse<unknown>;
        }
        if (docs.data.files.length > 0) {
            return {code: 0, msg: "", data: null} as IAPIResponse<null>;
        }
        return post<null>("/api/notebook/removeNotebook", {notebook: notebook.id});
    }, TEST_NOTEBOOK_NAME);
    expect(response, response.msg).toMatchObject({code: 0});
});
