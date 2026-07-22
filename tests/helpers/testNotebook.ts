import {expect, Locator, Page, TestInfo} from "@playwright/test";
import {SiyuanAPI} from "./siyuanAPI";
import {openWorkspace} from "./runtime";

export const TEST_NOTEBOOK_NAME = "SiYuan Testing";
export const TEMP_TEST_NOTEBOOK_PREFIX = "SiYuan Testing Notebook";

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

export interface ICreatedTestNotebook {
    id: string;
    name: string;
}

export type TestDocumentFactory = (titlePrefix: string, markdown?: string) => Promise<ITestDocument>;
export type TestDocumentTracker = (document: ICreatedTestDocument) => void;
export type TestNotebookFactory = (namePrefix: string) => Promise<ICreatedTestNotebook>;

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

export const createTestNotebook = async (api: SiyuanAPI, createdNotebooks: ICreatedTestNotebook[],
                                         namePrefix: string) => {
    const name = `${TEMP_TEST_NOTEBOOK_PREFIX} ${namePrefix} ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const notebook = await api.createNotebook(name);
    const created = {id: notebook.id, name};
    createdNotebooks.push(created);
    return created;
};

export const removeCreatedTestDocuments = async (page: Page, api: SiyuanAPI,
                                                  documents: ICreatedTestDocument[]) => {
    if (documents.length === 0) {
        return;
    }
    await page.goto("about:blank");
    await api.flushTransactions();
    const notebookIDs = [...new Set(documents.map(document => document.notebookID))];
    const documentDepths = new Map<string, number>();
    for (const notebookID of notebookIDs) {
        for (const document of await api.listAllDocuments(notebookID)) {
            documentDepths.set(document.id, document.path.split("/").filter(Boolean).length);
        }
    }
    const orderedDocuments = documents.map(document => ({
        depth: documentDepths.get(document.id) || 0,
        document,
    })).sort((left, right) => right.depth - left.depth);
    let absentSince = 0;
    const deletionRequested = new Set<string>();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const existingDocumentIDs = new Set<string>();
        for (const notebookID of notebookIDs) {
            for (const document of await api.listAllDocuments(notebookID)) {
                existingDocumentIDs.add(document.id);
            }
        }
        let found = false;
        for (const {document} of orderedDocuments) {
            if (!existingDocumentIDs.has(document.id)) {
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

export const preserveFailedTestDocuments = async (documents: ICreatedTestDocument[], testInfo: TestInfo) => {
    if (documents.length === 0) {
        return;
    }
    await testInfo.attach("preserved-test-documents", {
        body: Buffer.from(JSON.stringify(documents, null, 2)),
        contentType: "application/json",
    });
};

export const removeCreatedTestNotebooks = async (page: Page, api: SiyuanAPI,
                                                 notebooks: ICreatedTestNotebook[]) => {
    if (notebooks.length === 0) {
        return;
    }
    await page.goto("about:blank");
    await api.flushTransactions();
    for (const notebook of notebooks) {
        let absentSince = 0;
        let lastRemoval = 0;
        let removalVerified = false;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const existing = (await api.listNotebooks()).find(item => item.id === notebook.id);
            if (existing) {
                absentSince = 0;
                if (!removalVerified &&
                    (existing.encrypted || !existing.name.startsWith(`${TEMP_TEST_NOTEBOOK_PREFIX} `))) {
                    throw new Error(`refusing to remove unverified test notebook ${notebook.id}`);
                }
                removalVerified = true;
                if (Date.now() - lastRemoval >= 1000) {
                    await api.removeNotebook(notebook.id);
                    lastRemoval = Date.now();
                }
            } else if (absentSince === 0) {
                absentSince = Date.now();
            } else if (Date.now() - absentSince >= 1000) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (absentSince === 0 || Date.now() - absentSince < 1000) {
            throw new Error(`test notebook was recreated after deletion: ${notebook.id}`);
        }
    }
};

export const preserveFailedTestNotebooks = async (notebooks: ICreatedTestNotebook[], testInfo: TestInfo) => {
    if (notebooks.length === 0) {
        return;
    }
    await testInfo.attach("preserved-test-notebooks", {
        body: Buffer.from(JSON.stringify(notebooks, null, 2)),
        contentType: "application/json",
    });
};
