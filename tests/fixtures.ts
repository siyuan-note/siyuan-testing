import {expect, test as base} from "@playwright/test";
import {preserveFailedTestDocument, removeCreatedTestDocuments} from "./helpers/testNotebook";

interface ICleanupFixtures {
    testDocumentCleanup: void;
}

export const test = base.extend<ICleanupFixtures>({
    testDocumentCleanup: [async ({page}, use, testInfo) => {
        await use();
        if (testInfo.status === "passed") {
            await removeCreatedTestDocuments(page);
        } else {
            await preserveFailedTestDocument(page, testInfo.title);
        }
    }, {auto: true}],
});

export {expect};
