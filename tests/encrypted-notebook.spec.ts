import {expect, test} from "./fixtures";
import {openWorkspace} from "./helpers/runtime";
import {IDocumentContent} from "./helpers/siyuanAPI";
import {getDocumentEditor} from "./helpers/testNotebook";

test.describe("encrypted notebook", () => {
    test("isolates content while locked and restores it after unlocking", async ({
        page,
        siyuanAPI,
    }, testInfo) => {
        const password = process.env.SIYUAN_TEST_ENCRYPTION_PASSWORD;
        test.skip(!password, "Set SIYUAN_TEST_ENCRYPTION_PASSWORD to run encrypted notebook lifecycle tests.");
        if (!password) {
            return;
        }

        const initialStatus = await siyuanAPI.getEncryptedNotebookStatus();
        test.skip(!initialStatus.enabled, "Encrypted notebooks must already be enabled by the test workspace owner.");
        if (!initialStatus.enabled) {
            return;
        }

        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const notebookName = `SiYuan Testing Encrypted ${suffix}`;
        const documentTitle = `Encrypted Lifecycle ${suffix}`;
        const marker = `encrypted-lifecycle-${suffix}`;
        let notebookID = "";

        try {
            const notebook = await siyuanAPI.createEncryptedNotebook(notebookName, password);
            notebookID = notebook.id;
            expect(notebook).toMatchObject({
                closed: false,
                encrypted: true,
                name: notebookName,
                unlocked: true,
            });

            const docID = await siyuanAPI.createDocument(notebookID, documentTitle, marker);
            await expect.poll(async () => {
                const result = await siyuanAPI.searchBlocks(marker, notebookID);
                return result.blocks.some(block => block.rootID === docID);
            }, {timeout: 30000}).toBe(true);

            const globalSearch = await siyuanAPI.searchBlocks(marker);
            expect(globalSearch.blocks).toEqual([]);

            const content = await siyuanAPI.getDocumentContent(docID, notebookID);
            expect(content).toMatchObject({box: notebookID, id: docID, rootID: docID});
            expect(content.content).toContain(marker);

            const rawFile = await siyuanAPI.postResult<null>("/api/file/getFile", {
                path: `/data/${notebookID}${content.path}`,
            });
            expect(rawFile.code).toBe(-3);

            await openWorkspace(page, `/?id=${docID}`);
            await expect(await getDocumentEditor(page, docID)).toContainText(marker);
            await page.waitForLoadState("networkidle");
            await page.goto("about:blank");

            await siyuanAPI.lockNotebook(notebookID);
            await expect.poll(async () => {
                const status = await siyuanAPI.getEncryptedNotebookStatus();
                return status.boxes.find(box => box.id === notebookID)?.unlocked;
            }).toBe(false);

            const lockedSearch = await siyuanAPI.searchBlocksResult(marker, notebookID);
            expect(lockedSearch).toMatchObject({code: -1, msg: "encrypted notebook locked"});

            const lockedDocument = await siyuanAPI.postResult<IDocumentContent>("/api/filetree/getDoc", {
                highlight: false,
                id: docID,
                notebook: notebookID,
            });
            expect(lockedDocument.code).not.toBe(0);

            const wrongPassword = await siyuanAPI.postResult<null>("/api/notebook/unlockAndOpenNotebook", {
                notebook: notebookID,
                password: `${password}-incorrect-${suffix}`,
            });
            expect(wrongPassword.code).toBe(-1);
            expect((await siyuanAPI.getEncryptedNotebookStatus()).boxes.find(
                box => box.id === notebookID,
            )?.unlocked).toBe(false);

            await siyuanAPI.unlockAndOpenNotebook(notebookID, password);
            await expect.poll(async () => {
                const status = await siyuanAPI.getEncryptedNotebookStatus();
                return status.boxes.find(box => box.id === notebookID)?.unlocked;
            }).toBe(true);

            const restoredContent = await siyuanAPI.getDocumentContent(docID, notebookID);
            expect(restoredContent.content).toContain(marker);
            await expect.poll(async () => {
                const result = await siyuanAPI.searchBlocks(marker, notebookID);
                return result.blocks.some(block => block.rootID === docID);
            }, {timeout: 30000}).toBe(true);

            await openWorkspace(page, `/?id=${docID}`);
            await expect(await getDocumentEditor(page, docID)).toContainText(marker);
            await page.reload();
            await expect(await getDocumentEditor(page, docID)).toContainText(marker);
            await page.waitForLoadState("networkidle");
            await page.goto("about:blank");

            await siyuanAPI.removeNotebook(notebookID);
            await expect.poll(async () => {
                const status = await siyuanAPI.getEncryptedNotebookStatus();
                return status.boxes.some(box => box.id === notebookID);
            }).toBe(false);

            const finalStatus = await siyuanAPI.getEncryptedNotebookStatus();
            expect(finalStatus.boxes.map(box => box.id).sort()).toEqual(
                initialStatus.boxes.map(box => box.id).sort(),
            );
            notebookID = "";
        } catch (error) {
            if (notebookID) {
                await page.goto("about:blank").catch(() => undefined);
                const status = await siyuanAPI.getEncryptedNotebookStatus().catch(() => undefined);
                const testBox = status?.boxes.find(box => box.id === notebookID);
                if (testBox?.unlocked) {
                    await siyuanAPI.lockNotebook(notebookID).catch(() => undefined);
                }
                await testInfo.attach("preserved-encrypted-notebook", {
                    body: Buffer.from(JSON.stringify({id: notebookID, name: notebookName}, null, 2)),
                    contentType: "application/json",
                });
            }
            throw error;
        }
    });
});
