import {expect, test} from "./fixtures";
import {openWorkspace, showFileTree} from "./helpers/runtime";
import {ISiyuanResponse} from "./helpers/siyuanAPI";
import {ensureTestNotebook, getDocumentEditor} from "./helpers/testNotebook";

const renderIndexedDocumentID = (prefix: string) =>
    `${prefix} .action{range queryBlocks "SELECT * FROM blocks WHERE id = '?' LIMIT 1" .id}` +
    ".action{.ID}.action{end}";

test.describe("document creation templates", () => {
    test("applies the configured template before a new blank document opens", async ({
        page,
        siyuanAPI,
        trackTestDocument,
    }) => {
        const notebookID = await ensureTestNotebook(siyuanAPI);
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const templateName = `default-document-${suffix}.md`;
        const templatePath = `/data/templates/${templateName}`;
        const originalFileTree = (await siyuanAPI.getConf()).conf.fileTree;
        const seedTitle = `Default template seed ${suffix}`;
        const seedID = await siyuanAPI.createDocument(notebookID, seedTitle, "Seed");
        trackTestDocument({id: seedID, notebookID, title: seedTitle});
        await siyuanAPI.writeWorkspaceFile(
            templatePath,
            templateName,
            "text/markdown",
            Buffer.from(renderIndexedDocumentID("Default template")),
        );

        try {
            const configuredFileTree = await siyuanAPI.setFileTree({
                ...originalFileTree,
                docCreateTemplatePath: templateName,
            });
            await openWorkspace(page);
            await page.evaluate(fileTree => {
                Object.assign(window.siyuan.config.fileTree, fileTree);
            }, configuredFileTree);

            const restoreFileTree = await showFileTree(page);
            try {
                const notebookRoot = page.locator(
                    `ul.b3-list[data-url="${notebookID}"] > li[data-type="navigation-root"]`,
                );
                await expect(notebookRoot).toBeVisible({timeout: 15000});
                await notebookRoot.hover();
                const createAction = notebookRoot.locator(':scope > [data-type="new"]');
                await expect(createAction).toBeVisible();
                const savePathResponsePromise = page.waitForResponse(response =>
                    new URL(response.url()).pathname === "/api/filetree/getDocCreateSavePath");
                const createResponsePromise = page.waitForResponse(response => {
                    if (new URL(response.url()).pathname !== "/api/filetree/createDoc") {
                        return false;
                    }
                    const request = response.request().postDataJSON() as {docCreateTemplatePath?: string};
                    return request.docCreateTemplatePath === `/${templateName}`;
                });
                await createAction.click();
                const savePathResponse = await savePathResponsePromise;
                const savePathResult = await savePathResponse.json() as ISiyuanResponse<{
                    docCreateTemplatePath: string;
                }>;
                expect(savePathResult.data.docCreateTemplatePath).toBe(`/${templateName}`);
                const response = await createResponsePromise;
                const result = await response.json() as ISiyuanResponse<{id: string}>;
                expect(result.code).toBe(0);
                const createRequest = response.request().postDataJSON() as {docCreateTemplatePath: string};
                expect(createRequest.docCreateTemplatePath).toBe(`/${templateName}`);
                const docID = result.data.id;
                trackTestDocument({id: docID, notebookID, title: `Default template ${suffix}`});

                const rows = await siyuanAPI.querySQL(
                    `SELECT content FROM blocks WHERE root_id = '${docID}' AND type = 'p'`,
                );
                expect(rows.map(row => row.content)).toContain(`Default template ${docID}`);
                await expect(await getDocumentEditor(page, docID)).toContainText(`Default template ${docID}`);
            } finally {
                await restoreFileTree();
            }
        } finally {
            const restoredFileTree = await siyuanAPI.setFileTree(originalFileTree);
            if (!page.isClosed() && page.url() !== "about:blank") {
                await page.evaluate(fileTree => {
                    Object.assign(window.siyuan.config.fileTree, fileTree);
                }, restoredFileTree);
            }
            await siyuanAPI.removeWorkspaceFile(templatePath);
        }
    });

    test("uses only the daily note template and returns after its content is indexed", async ({
        siyuanAPI,
        trackTestDocument,
    }) => {
        const notebookID = await ensureTestNotebook(siyuanAPI);
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const defaultTemplateName = `daily-conflict-default-${suffix}.md`;
        const dailyTemplateName = `daily-indexed-${suffix}.md`;
        const originalFileTree = (await siyuanAPI.getConf()).conf.fileTree;
        const originalNotebookConf = (await siyuanAPI.getNotebookConf(notebookID)).conf;
        await siyuanAPI.writeWorkspaceFile(
            `/data/templates/${defaultTemplateName}`,
            defaultTemplateName,
            "text/markdown",
            Buffer.from(renderIndexedDocumentID("Default template")),
        );
        await siyuanAPI.writeWorkspaceFile(
            `/data/templates/${dailyTemplateName}`,
            dailyTemplateName,
            "text/markdown",
            Buffer.from(renderIndexedDocumentID("Daily template")),
        );

        try {
            await siyuanAPI.setFileTree({
                ...originalFileTree,
                docCreateTemplatePath: defaultTemplateName,
            });
            await siyuanAPI.setNotebookConf(notebookID, {
                ...originalNotebookConf,
                dailyNoteSavePath: `/Daily template ${suffix}`,
                dailyNoteTemplatePath: dailyTemplateName,
            });

            const {id: docID} = await siyuanAPI.createDailyNote(notebookID);
            trackTestDocument({id: docID, notebookID, title: `Daily template ${suffix}`});
            const rows = await siyuanAPI.querySQL(
                `SELECT content FROM blocks WHERE root_id = '${docID}' AND type = 'p'`,
            );
            const contents = rows.map(row => row.content);
            expect(contents).toContain(`Daily template ${docID}`);
            expect(contents).not.toContain(`Default template ${docID}`);
        } finally {
            await siyuanAPI.setNotebookConf(notebookID, originalNotebookConf);
            await siyuanAPI.setFileTree(originalFileTree);
            await siyuanAPI.removeWorkspaceFile(`/data/templates/${defaultTemplateName}`);
            await siyuanAPI.removeWorkspaceFile(`/data/templates/${dailyTemplateName}`);
        }
    });
});
