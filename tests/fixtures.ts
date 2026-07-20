import {expect, test as base} from "@playwright/test";
import {
    createTestDocument,
    ICreatedTestDocument,
    preserveFailedTestDocuments,
    removeCreatedTestDocuments,
    TestDocumentFactory,
} from "./helpers/testNotebook";
import {IAppearanceSettings, SiyuanAPI} from "./helpers/siyuanAPI";
import {openWorkspace} from "./helpers/runtime";

interface IGlobalSettings {
    appearance: IAppearanceSettings;
}

interface ITestFixtures {
    siyuanAPI: SiyuanAPI;
    createTestDocument: TestDocumentFactory;
    globalSettings: IGlobalSettings;
    testDocumentCleanup: void;
}

interface IInternalFixtures {
    createdTestDocuments: ICreatedTestDocument[];
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
    createTestDocument: async ({page, siyuanAPI, createdTestDocuments}, use) => {
        await use((titlePrefix, markdown) =>
            createTestDocument(page, siyuanAPI, createdTestDocuments, titlePrefix, markdown));
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
            await preserveFailedTestDocuments(siyuanAPI, createdTestDocuments, testInfo);
        }
    }, {auto: true}],
});

export {expect};
