import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";
import {openWorkspace} from "./helpers/runtime";

const focusEditable = async (editable: Locator) => {
    await expect(editable).toBeVisible();
    await expect(async () => {
        await editable.click();
        expect(await editable.evaluate(element => element.contains(getSelection()?.anchorNode || null))).toBe(true);
    }).toPass({timeout: 5000});
};

test("persists rapid input across concurrent editors", async ({
    context,
    createTestDocument,
    page,
    siyuanAPI,
    trackTestDocument,
}) => {
    const firstDocument = await createTestDocument("Concurrent Editor Input E2E");
    const editors: {docID: string; editor: Locator; page: Page}[] = [{
        docID: firstDocument.docID,
        editor: firstDocument.editor,
        page,
    }];
    const extraPages: Page[] = [];

    try {
        for (let index = 1; index < 3; index++) {
            const title = `Concurrent Editor Input E2E ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            const docID = await siyuanAPI.createDocument(firstDocument.notebookID, title);
            trackTestDocument({id: docID, notebookID: firstDocument.notebookID, title});
            const extraPage = await context.newPage();
            extraPages.push(extraPage);
            await openWorkspace(extraPage, `/?id=${docID}`);
            editors.push({docID, editor: await getDocumentEditor(extraPage, docID), page: extraPage});
        }

        const unexpectedReloads: unknown[] = [];
        editors.forEach(item => {
            item.page.on("request", request => {
                if (request.url().endsWith("/api/filetree/getDoc") && request.postDataJSON()?.highlight === false) {
                    unexpectedReloads.push(request.postDataJSON());
                }
            });
        });

        await Promise.all(editors.map(async (item, index) => {
            const content = `rapid concurrent input ${index + 1}`;
            const editable = item.editor.locator(":scope > [data-node-id] > [contenteditable=true]").first();
            await focusEditable(editable);
            await item.page.keyboard.type(content, {delay: 5});
            await expect(editable).toHaveText(content);
            await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(item.docID)), {
                timeout: 10000,
            }).toContain(content);
        }));

        expect(unexpectedReloads).toEqual([]);
    } finally {
        await Promise.all(extraPages.map(extraPage => extraPage.close()));
    }
});
