import {expect, test as base} from "@playwright/test";
import {
    createTestDocument,
    createTestNotebook,
    ICreatedTestDocument,
    ICreatedTestNotebook,
    preserveFailedTestDocuments,
    preserveFailedTestNotebooks,
    removeCreatedTestDocuments,
    removeCreatedTestNotebooks,
    TestDocumentFactory,
    TestDocumentTracker,
    TestNotebookFactory,
} from "./helpers/testNotebook";
import {IAppearanceSettings, SiyuanAPI} from "./helpers/siyuanAPI";
import {openWorkspace} from "./helpers/runtime";

interface IGlobalSettings {
    appearance: IAppearanceSettings;
}

interface ITestFixtures {
    siyuanAPI: SiyuanAPI;
    createTestDocument: TestDocumentFactory;
    createTestNotebook: TestNotebookFactory;
    trackTestDocument: TestDocumentTracker;
    globalSettings: IGlobalSettings;
    testDocumentCleanup: void;
    testNotebookCleanup: void;
}

interface IInternalFixtures {
    createdTestDocuments: ICreatedTestDocument[];
    createdTestNotebooks: ICreatedTestNotebook[];
}

export const test = base.extend<ITestFixtures & IInternalFixtures>({
    siyuanAPI: async ({request, baseURL}, use) => {
        if (!baseURL) {
            throw new Error("playwright.config.ts must define use.baseURL");
        }
        await use(new SiyuanAPI(request, baseURL));
    },
    createdTestDocuments: async ({}, use) => {
        await use([]);
    },
    createdTestNotebooks: async ({}, use) => {
        await use([]);
    },
    createTestDocument: async ({page, siyuanAPI, createdTestDocuments}, use) => {
        await use((titlePrefix, markdown) =>
            createTestDocument(page, siyuanAPI, createdTestDocuments, titlePrefix, markdown));
    },
    createTestNotebook: async ({siyuanAPI, createdTestNotebooks}, use) => {
        await use(namePrefix => createTestNotebook(siyuanAPI, createdTestNotebooks, namePrefix));
    },
    trackTestDocument: async ({createdTestDocuments}, use) => {
        await use((document) => {
            if (!createdTestDocuments.some(item => item.id === document.id)) {
                createdTestDocuments.push(document);
            }
        });
    },
    globalSettings: async ({page, siyuanAPI}, use) => {
        await openWorkspace(page);
        const appearance = (await siyuanAPI.getConf()).conf.appearance;
        try {
            await use({appearance});
        } finally {
            await siyuanAPI.setAppearance(appearance);
            await expect.poll(() => page.evaluate(() => ({
                mode: window.siyuan.config.appearance.mode,
                modeOS: window.siyuan.config.appearance.modeOS,
            }))).toEqual({mode: appearance.mode, modeOS: appearance.modeOS});
        }
    },
    testDocumentCleanup: [async ({page, siyuanAPI, createdTestDocuments}, use, testInfo) => {
        await use();
        if (testInfo.status === "passed") {
            await removeCreatedTestDocuments(page, siyuanAPI, createdTestDocuments);
        } else {
            await preserveFailedTestDocuments(createdTestDocuments, testInfo);
        }
    }, {auto: true}],
    testNotebookCleanup: [async ({page, siyuanAPI, createdTestNotebooks}, use, testInfo) => {
        await use();
        if (testInfo.status === "passed") {
            await removeCreatedTestNotebooks(page, siyuanAPI, createdTestNotebooks);
        } else {
            await preserveFailedTestNotebooks(createdTestNotebooks, testInfo);
        }
    }, {auto: true}],
});

export {expect};
