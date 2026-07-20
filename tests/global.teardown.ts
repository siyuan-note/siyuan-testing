import {test} from "@playwright/test";
import {TEST_NOTEBOOK_NAME} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";

test(`remove empty ${TEST_NOTEBOOK_NAME} notebook`, async ({request, baseURL}) => {
    if (!baseURL) {
        throw new Error("playwright.config.ts must define use.baseURL");
    }
    const api = new SiyuanAPI(request, baseURL);
    const notebook = (await api.listNotebooks()).find(item => item.name === TEST_NOTEBOOK_NAME);
    if (!notebook) {
        return;
    }
    const documents = await api.listAllDocuments(notebook.id);
    if (documents.length === 0) {
        await api.removeNotebook(notebook.id);
    }
});
