import {expect, Locator, Page, TestInfo} from "@playwright/test";
import {SiyuanAPI} from "./siyuanAPI";
import {openWorkspace} from "./runtime";

export const TEST_NOTEBOOK_NAME = "SiYuan Testing";

export interface ICreatedTestDocument {
    id: string;
    notebookID: string;
    title: string;
}

export interface ITestDocument {
    docID: string;
    editor: Locator;
    notebookID: string;
    title: string;
}

export type TestDocumentFactory = (titlePrefix: string, markdown?: string) => Promise<ITestDocument>;
export type TestDocumentTracker = (document: ICreatedTestDocument) => void;

export const ensureTestNotebook = async (api: SiyuanAPI) => {
    const notebooks = await api.listNotebooks();
    let notebook = notebooks.find(item => item.name === TEST_NOTEBOOK_NAME);
    if (!notebook) {
        notebook = await api.createNotebook(TEST_NOTEBOOK_NAME);
    } else if (notebook.closed) {
        await api.openNotebook(notebook.id);
    }
    return notebook.id;
};

export const getDocumentEditor = async (page: Page, docID: string) => {
    const titleSelector = `.protyle-title[data-node-id="${docID}"]`;
    const titleElements = page.locator(titleSelector);
    await expect(page.locator(`${titleSelector}:visible`).last()).toBeVisible({timeout: 15000});
    const visibleTitleIndex = await titleElements.evaluateAll(elements => {
        let index = -1;
        elements.forEach((element, currentIndex) => {
            if (element.getClientRects().length > 0) {
                index = currentIndex;
            }
        });
        return index;
    });
    const titleElement = titleElements.nth(visibleTitleIndex);
    await expect(titleElement).toBeVisible({timeout: 15000});
    const protyle = titleElement.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle ')][1]",
    );
    await expect(protyle).toHaveAttribute("data-loading", "finished", {timeout: 15000});
    const editor = protyle.locator(".protyle-wysiwyg");
    await expect(editor).toBeVisible({timeout: 10000});
    return editor;
};

export const createTestDocument = async (page: Page, api: SiyuanAPI,
                                         createdDocuments: ICreatedTestDocument[], titlePrefix: string,
                                         markdown = "") => {
    const notebookID = await ensureTestNotebook(api);
    const title = `${titlePrefix} ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const docID = await api.createDocument(notebookID, title, markdown);
    createdDocuments.push({id: docID, notebookID, title});

    await openWorkspace(page, `/?id=${docID}`);
    const editor = await getDocumentEditor(page, docID);
    return {docID, editor, notebookID, title};
};

export const removeCreatedTestDocuments = async (page: Page, api: SiyuanAPI,
                                                  documents: ICreatedTestDocument[]) => {
    if (documents.length === 0) {
        return;
    }
    await page.goto("about:blank");
    let absentSince = 0;
    const deletionRequested = new Set<string>();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        let found = false;
        for (const document of documents) {
            if (!await api.findDocumentPath(document.id)) {
                continue;
            }
            found = true;
            if (!deletionRequested.has(document.id)) {
                await api.removeDocument(document.id);
                deletionRequested.add(document.id);
            }
        }
        if (found) {
            absentSince = 0;
        } else if (absentSince === 0) {
            absentSince = Date.now();
        } else if (Date.now() - absentSince >= 1000) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`test documents were recreated after deletion: ${documents.map(item => item.id).join(", ")}`);
};

export const preserveFailedTestDocuments = async (api: SiyuanAPI, documents: ICreatedTestDocument[],
                                                   testInfo: TestInfo) => {
    let hasExistingDocument = false;
    try {
        for (const document of documents) {
            if (await api.findDocumentPath(document.id)) {
                hasExistingDocument = true;
                break;
            }
        }
    } catch {
        hasExistingDocument = documents.length > 0;
    }
    if (!hasExistingDocument) {
        const notebookID = await ensureTestNotebook(api);
        const safeTitle = testInfo.title.replace(/[^\w -]/g, " ");
        const title = `FAILED ${safeTitle} ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const id = await api.createDocument(notebookID, title);
        documents.push({id, notebookID, title});
    }
    await testInfo.attach("preserved-test-documents", {
        body: Buffer.from(JSON.stringify(documents, null, 2)),
        contentType: "application/json",
    });
};
