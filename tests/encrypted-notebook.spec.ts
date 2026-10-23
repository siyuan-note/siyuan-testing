import {expect, test} from "./fixtures";
import {openWorkspace} from "./helpers/runtime";
import {IDocumentContent, INotebook} from "./helpers/siyuanAPI";
import {getDocumentEditor} from "./helpers/testNotebook";
import {readZipEntries} from "./helpers/zip";

test.describe("encrypted notebook", () => {
    test("isolates slash-title content while locked and restores it after unlocking", async ({
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
            const renamedTitle = `${documentTitle}/Private 🚀`;
            const titleInput = page.locator(`.protyle-title[data-node-id="${docID}"]:visible .protyle-title__input`).last();
            await titleInput.fill(renamedTitle);
            await titleInput.press("Tab");
            await expect.poll(async () => {
                const [document] = (await siyuanAPI.getDocumentPaths(notebookID, [docID])).documents;
                return document?.title.text;
            }, {timeout: 15000}).toBe(renamedTitle);
            const [renamed] = (await siyuanAPI.getDocumentPaths(notebookID, [docID])).documents;
            expect(renamed).toMatchObject({id: docID, parentID: null, depth: 1, path: content.path});
            expect(renamed.segments.map(segment => segment.text)).toEqual([renamedTitle]);
            await page.reload();
            await expect(await getDocumentEditor(page, docID)).toContainText(marker);
            await expect(titleInput).toHaveText(renamedTitle);
            await page.waitForLoadState("networkidle");
            await page.goto("about:blank");

            await siyuanAPI.lockNotebook(notebookID);
            await expect.poll(async () => {
                const status = await siyuanAPI.getEncryptedNotebookStatus();
                return status.boxes.find(box => box.id === notebookID)?.unlocked;
            }).toBe(false);

            const lockedSearch = await siyuanAPI.searchBlocksResult(marker, notebookID);
            expect(lockedSearch).toMatchObject({
                code: -1, msg: "encrypted notebook is locked, please unlock it first",
            });

            const lockedPaths = await siyuanAPI.postResult<null>("/api/filetree/getDocPaths", {
                notebook: notebookID, ids: [docID],
            });
            expect(lockedPaths.code).not.toBe(0);

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
            await expect(titleInput).toHaveText(renamedTitle);
            const restored = await siyuanAPI.resolveDocumentPath(notebookID, [renamedTitle]);
            expect(restored.status).toBe("resolved");
            expect(restored.resolved).toMatchObject({id: docID, path: content.path, depth: 1});
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

    test("round-trips colliding title paths between encrypted notebooks", async ({
        page, request, baseURL, siyuanAPI,
    }, testInfo) => {
        test.setTimeout(120000);
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
        const marker = `encrypted-title-archive-${suffix}`;
        const notebooks: INotebook[] = [];
        try {
            const source = await siyuanAPI.createEncryptedNotebook(`SiYuan Testing Encrypted Source ${suffix}`, password);
            notebooks.push(source);
            const target = await siyuanAPI.createEncryptedNotebook(`SiYuan Testing Encrypted Target ${suffix}`, password);
            notebooks.push(target);
            const rootTitle = `Encrypted Archive ${suffix}`;
            const rootID = await siyuanAPI.createDocument(source.id, rootTitle, `${marker} root`);
            const parentID = await siyuanAPI.createDocument(source.id, "A", `${marker} parent`, rootID);
            const childID = await siyuanAPI.createDocument(source.id, "B", `${marker} child`, parentID);
            const literalID = await siyuanAPI.createDocument(source.id, "A/B", `${marker} literal`, rootID);
            const expected = [
                {id: rootID, title: rootTitle, kind: "root"},
                {id: parentID, title: "A", kind: "parent"},
                {id: childID, title: "B", kind: "child"},
                {id: literalID, title: "A/B", kind: "literal"},
            ];
            const paths = await siyuanAPI.getDocumentPaths(source.id, expected.map(document => document.id));
            expect(paths.missingIDs).toEqual([]);
            const sourcePaths = new Map(paths.documents.map(document => [document.id, document]));
            expect(sourcePaths.get(literalID)?.displayPath).toBe(sourcePaths.get(childID)?.displayPath);
            expect(sourcePaths.get(literalID)?.depth).toBe(2);
            expect(sourcePaths.get(childID)?.depth).toBe(3);

            const markdownExport = await siyuanAPI.post<{zip: string}>("/api/export/exportMd", {
                id: rootID, addTitle: true, includeSubDocs: true, includeRelatedDocs: false, markdownYFM: false,
            });
            const markdown = [...readZipEntries(await siyuanAPI.downloadFile(markdownExport.zip))]
                .filter(([name]) => name.endsWith(".md"));
            expect(markdown).toHaveLength(4);
            expect(new Set(markdown.map(([name]) => name.toLocaleLowerCase())).size).toBe(4);
            for (const document of expected) {
                const entries = markdown.filter(([, content]) => content.toString("utf8").includes(
                    `${marker} ${document.kind}`,
                ));
                expect(entries).toHaveLength(1);
                expect(entries[0][1].toString("utf8")).toContain(`# ${document.title}`);
            }

            const nativeExport = await siyuanAPI.post<{zip: string}>("/api/export/exportSYs", {ids: [rootID]});
            const archive = await siyuanAPI.downloadFile(nativeExport.zip);
            const nativeDocuments = [...readZipEntries(archive)].filter(([name]) => name.endsWith(".sy"))
                .map(([, content]) => JSON.parse(content.toString("utf8")) as {
                    ID: string; Spec: string; Properties: {title: string};
                });
            expect(nativeDocuments).toHaveLength(4);
            for (const document of expected) {
                const native = nativeDocuments.find(item => item.ID === document.id);
                expect(native?.Properties.title).toBe(document.title);
                if (document.id === literalID) {
                    expect(Number(native?.Spec)).toBeGreaterThanOrEqual(6);
                }
            }
            await siyuanAPI.importArchive("/api/import/importSY", archive, "encrypted-titles.sy.zip", target.id);
            await expect.poll(async () => (await siyuanAPI.listAllDocuments(target.id)).length, {
                timeout: 30000,
            }).toBe(4);
            await expect.poll(async () => (await siyuanAPI.getNotebookConf(target.id)).documentCapabilities?.indexState, {
                timeout: 30000,
            }).toBe("ready");
            const importedIDs = new Map<string, string>();
            for (const document of expected) {
                const original = sourcePaths.get(document.id)!;
                const resolved = await siyuanAPI.resolveDocumentPath(target.id, original.segments.map(segment => segment.text));
                expect(resolved.status).toBe("resolved");
                const imported = resolved.resolved!;
                expect(imported.id).not.toBe(document.id);
                expect(imported.title.text).toBe(document.title);
                expect(imported.depth).toBe(original.depth);
                expect(imported.parentID).toBe(original.parentID ? importedIDs.get(original.parentID) : null);
                importedIDs.set(document.id, imported.id);
                expect((await siyuanAPI.getDocumentContent(imported.id, target.id)).content)
                    .toContain(`${marker} ${document.kind}`);
                expect((await siyuanAPI.getDocumentContent(document.id, source.id)).content)
                    .toContain(`${marker} ${document.kind}`);
            }
            expect((await siyuanAPI.searchBlocks(marker)).blocks).toEqual([]);
            const importedLiteralID = importedIDs.get(literalID)!;
            await openWorkspace(page, `/?id=${importedLiteralID}`);
            await expect(await getDocumentEditor(page, importedLiteralID)).toContainText(`${marker} literal`);
            await expect(page.locator(`.protyle-title[data-node-id="${importedLiteralID}"]:visible .protyle-title__input`).last())
                .toHaveText("A/B");
            await page.reload();
            await expect(await getDocumentEditor(page, importedLiteralID)).toContainText(`${marker} literal`);
            await page.waitForLoadState("networkidle");
            await page.goto("about:blank");

            await siyuanAPI.lockNotebook(source.id);
            for (const uri of [markdownExport.zip, nativeExport.zip]) {
                const response = await request.get(new URL(uri, baseURL).toString());
                expect(response.status()).toBe(404);
            }
            expect((await siyuanAPI.resolveDocumentPath(target.id, [rootTitle, "A/B"])).resolved?.id)
                .toBe(importedLiteralID);
            await siyuanAPI.unlockAndOpenNotebook(source.id, password);
            while (notebooks.length > 0) {
                await siyuanAPI.removeNotebook(notebooks[notebooks.length - 1].id);
                notebooks.pop();
            }
            expect((await siyuanAPI.getEncryptedNotebookStatus()).boxes.map(box => box.id).sort())
                .toEqual(initialStatus.boxes.map(box => box.id).sort());
        } catch (error) {
            await page.goto("about:blank").catch(() => undefined);
            const status = await siyuanAPI.getEncryptedNotebookStatus().catch(() => undefined);
            for (const notebook of notebooks) {
                if (status?.boxes.find(box => box.id === notebook.id)?.unlocked) {
                    await siyuanAPI.lockNotebook(notebook.id).catch(() => undefined);
                }
            }
            await testInfo.attach("preserved-encrypted-notebooks", {
                body: Buffer.from(JSON.stringify(notebooks.map(({id, name}) => ({id, name})), null, 2)),
                contentType: "application/json",
            });
            throw error;
        }
    });
});
