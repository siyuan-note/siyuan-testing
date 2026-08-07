import {expect, test} from "./fixtures";
import {openWorkspace, showFileTree} from "./helpers/runtime";
import {getDocumentEditor} from "./helpers/testNotebook";

interface ISyNode {
    Children?: ISyNode[];
    ID?: string;
    TextMarkBlockRefID?: string;
    Type: string;
}

const flattenNodes = (root: ISyNode) => {
    const nodes: ISyNode[] = [];
    const visit = (node: ISyNode) => {
        nodes.push(node);
        node.Children?.forEach(visit);
    };
    visit(root);
    return nodes;
};

test.describe("document import", () => {
    test("round-trips Markdown through an exported ZIP", {tag: "@smoke"}, async ({
        createTestDocument,
        page,
        siyuanAPI,
        trackTestDocument,
    }) => {
        const marker = `Markdown round trip ${Date.now()}`;
        const source = await createTestDocument("Markdown Round Trip E2E", [
            `**${marker}** 中文 🚀`,
            "",
            "```javascript",
            "const roundTrip = true;",
            "```",
        ].join("\n"));
        const exported = await siyuanAPI.post<{name: string; zip: string}>("/api/export/exportMd", {
            addTitle: true,
            id: source.docID,
            includeRelatedDocs: false,
            includeSubDocs: false,
            markdownYFM: false,
        });
        const archive = await siyuanAPI.downloadFile(exported.zip);
        expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

        await siyuanAPI.removeDocument(source.docID);
        await expect.poll(() => siyuanAPI.findDocumentPath(source.docID)).toBeUndefined();
        await siyuanAPI.importArchive(
            "/api/import/importZipMd",
            archive,
            `${exported.name || source.title}.zip`,
            source.notebookID,
        );

        let importedRootID = "";
        await expect.poll(async () => {
            const result = await siyuanAPI.searchBlocks(marker);
            importedRootID = result.blocks.find(block => block.rootID !== source.docID)?.rootID || "";
            return importedRootID;
        }, {timeout: 30000}).not.toBe("");
        const documents = await siyuanAPI.listAllDocuments(source.notebookID);
        const imported = documents.find(item => item.id === importedRootID);
        expect(imported).toBeTruthy();
        const topLevelID = imported!.path.split("/").filter(Boolean)[0].replace(/\.sy$/, "");
        const topLevel = documents.find(item => item.id === topLevelID);
        expect(topLevel).toBeTruthy();
        trackTestDocument({id: topLevelID, notebookID: source.notebookID, title: topLevel!.name});

        await openWorkspace(page, `/?id=${importedRootID}`);
        const editor = await getDocumentEditor(page, importedRootID);
        await expect(editor).toContainText(marker);
        await expect(editor).toContainText("const roundTrip = true;");
        await page.reload();
        await expect(await getDocumentEditor(page, importedRootID)).toContainText(marker);
    });

    test("uploads a Markdown ZIP from the notebook import menu", async ({
        createTestDocument,
        page,
        siyuanAPI,
        trackTestDocument,
    }) => {
        const marker = `Markdown UI import ${Date.now()}`;
        const source = await createTestDocument("Markdown UI Import E2E", `${marker}\n\nImported through the file picker`);
        const exported = await siyuanAPI.post<{name: string; zip: string}>("/api/export/exportMd", {
            addTitle: true,
            id: source.docID,
            includeRelatedDocs: false,
            includeSubDocs: false,
            markdownYFM: false,
        });
        const archive = await siyuanAPI.downloadFile(exported.zip);
        expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

        await siyuanAPI.removeDocument(source.docID);
        await expect.poll(() => siyuanAPI.findDocumentPath(source.docID)).toBeUndefined();
        await openWorkspace(page);
        const restoreFileTree = await showFileTree(page);
        try {
            const notebookRoot = page.locator(
                `ul.b3-list[data-url="${source.notebookID}"] > li[data-type="navigation-root"]`,
            );
            await expect(notebookRoot).toBeVisible();
            // 长文件树加载后会平滑滚动恢复位置，滚动动画期间坐标会漂移导致点击落空，
            // 这里等待滚动稳定后再交互
            const fileTree = page.locator(".sy__file");
            await expect.poll(async () => {
                const first = await fileTree.evaluate(element => element.scrollTop);
                await page.waitForTimeout(50);
                const second = await fileTree.evaluate(element => element.scrollTop);
                return first === second;
            }, {timeout: 5000}).toBe(true);
            await notebookRoot.hover({force: true});
            await notebookRoot.locator(':scope > [data-type="more-root"]').click({force: true});

            const menu = page.locator("#commonMenu:not(.fn__none)");
            await expect(menu).toBeVisible();
            const importItem = menu.locator('[data-id="import"]');
            await expect(importItem).toBeVisible();
            await importItem.hover();
            const markdownImport = importItem.locator('[data-id="importMarkdownZip"]');
            await expect(markdownImport).toBeVisible();
            const uploadInput = markdownImport.locator('input[type="file"]');
            await expect(uploadInput).toBeAttached();

            const importResponse = page.waitForResponse(response =>
                new URL(response.url()).pathname === "/api/import/importZipMd", {timeout: 30000});
            await uploadInput.setInputFiles({
                name: `${exported.name || source.title}.zip`,
                mimeType: "application/zip",
                buffer: archive,
            });
            const response = await importResponse;
            const result = await response.json() as {code: number; msg: string};
            expect(result).toMatchObject({code: 0});
        } finally {
            await restoreFileTree();
        }

        let importedRootID = "";
        await expect.poll(async () => {
            const search = await siyuanAPI.searchBlocks(marker);
            importedRootID = search.blocks.find(block => block.rootID !== source.docID)?.rootID || "";
            return importedRootID;
        }, {timeout: 30000}).not.toBe("");
        const documents = await siyuanAPI.listAllDocuments(source.notebookID);
        const imported = documents.find(item => item.id === importedRootID);
        expect(imported).toBeTruthy();
        const topLevelID = imported!.path.split("/").filter(Boolean)[0].replace(/\.sy$/, "");
        const topLevel = documents.find(item => item.id === topLevelID);
        expect(topLevel).toBeTruthy();
        trackTestDocument({id: topLevelID, notebookID: source.notebookID, title: topLevel!.name});

        await openWorkspace(page, `/?id=${importedRootID}`);
        const editor = await getDocumentEditor(page, importedRootID);
        await expect(editor).toContainText(marker);
        await expect(editor).toContainText("Imported through the file picker");
        await page.reload();
        await expect(await getDocumentEditor(page, importedRootID)).toContainText(marker);
    });

    test("round-trips SiYuan documents with hierarchy, references, and assets", async ({
        createTestDocument,
        page,
        siyuanAPI,
        trackTestDocument,
    }) => {
        test.slow();
        const parentMarker = `SiYuan round trip parent ${Date.now()}`;
        const childMarker = `SiYuan round trip child ${Date.now()}`;
        const parent = await createTestDocument("SiYuan Round Trip Parent E2E", "Parent seed");
        const parentBlockID = await parent.editor.locator(':scope > [data-type="NodeParagraph"]').first()
            .getAttribute("data-node-id");
        const child = await createTestDocument("SiYuan Round Trip Child E2E", childMarker);
        const childBlockID = await child.editor.locator(':scope > [data-type="NodeParagraph"]').first()
            .getAttribute("data-node-id");
        await siyuanAPI.moveDocuments([child.docID], parent.docID);
        await expect.poll(async () => (await siyuanAPI.getDocumentPath(child.docID)).path)
            .toBe(`/${parent.docID}/${child.docID}.sy`);

        expect(childBlockID).toBeTruthy();
        expect(parentBlockID).toBeTruthy();
        const assetName = `migration-${Date.now()}.txt`;
        const assetContent = `SiYuan migration asset ${Date.now()} 中文 🚀`;
        const upload = await siyuanAPI.uploadAsset(
            parent.docID,
            assetName,
            "text/plain",
            Buffer.from(assetContent),
        );
        const assetPath = upload.succMap[assetName];
        expect(assetPath).toMatch(/^assets\/.+\.txt$/);
        const parentMarkdown = `${parentMarker} [${assetName}](${assetPath}) ` +
            `((${childBlockID} "Imported child"))`;
        await siyuanAPI.updateBlock(parentBlockID!, parentMarkdown);
        await openWorkspace(page, `/?id=${parent.docID}`);
        const sourceParentEditor = await getDocumentEditor(page, parent.docID);
        await expect(sourceParentEditor).toContainText(parentMarker);
        await expect(sourceParentEditor.locator(
            `[data-type~="block-ref"][data-id="${childBlockID}"]`,
        )).toBeVisible();
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument<unknown>(parent.docID)), {
            timeout: 30000,
        }).toContain(assetPath);

        const exported = await siyuanAPI.post<{zip: string}>("/api/export/exportSYs", {
            ids: [parent.docID, child.docID],
        });
        const archive = await siyuanAPI.downloadFile(exported.zip);
        expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

        await siyuanAPI.removeDocument(parent.docID);
        await expect.poll(() => siyuanAPI.findDocumentPath(parent.docID)).toBeUndefined();
        await expect.poll(() => siyuanAPI.findDocumentPath(child.docID)).toBeUndefined();
        await siyuanAPI.removeWorkspaceFile(`/data/${assetPath}`);
        await siyuanAPI.importArchive(
            "/api/import/importSY",
            archive,
            `${parent.title}.sy.zip`,
            parent.notebookID,
        );

        let importedParentID = "";
        let importedChildID = "";
        await expect.poll(async () => {
            const documents = await siyuanAPI.listAllDocuments(parent.notebookID);
            importedParentID = documents.find(item => item.name === parent.title && item.id !== parent.docID)?.id || "";
            importedChildID = documents.find(item => item.name === child.title && item.id !== child.docID &&
                item.path.startsWith(`/${importedParentID}/`))?.id || "";
            return {child: importedChildID, parent: importedParentID};
        }, {timeout: 30000}).toEqual({
            child: expect.stringMatching(/^\d{14}-[a-z0-9]{7}$/),
            parent: expect.stringMatching(/^\d{14}-[a-z0-9]{7}$/),
        });
        trackTestDocument({id: importedParentID, notebookID: parent.notebookID, title: parent.title});
        expect(importedParentID).not.toBe(parent.docID);
        expect(importedChildID).not.toBe(child.docID);
        expect(importedParentID.slice(0, 14)).toBe(parent.docID.slice(0, 14));
        expect(importedChildID.slice(0, 14)).toBe(child.docID.slice(0, 14));

        const importedParent = await siyuanAPI.readDocument<ISyNode>(importedParentID);
        const importedChild = await siyuanAPI.readDocument<ISyNode>(importedChildID);
        const importedChildBlock = flattenNodes(importedChild).find(node => node.Type === "NodeParagraph");
        expect(importedChildBlock?.ID).toBeTruthy();
        const importedReference = flattenNodes(importedParent).find(node => node.Type === "NodeTextMark" &&
            node.TextMarkBlockRefID);
        expect(importedReference?.TextMarkBlockRefID).toBe(importedChildBlock!.ID);
        expect(importedReference?.TextMarkBlockRefID).not.toBe(childBlockID);
        expect(JSON.stringify(importedParent)).toContain(assetPath);
        expect(JSON.stringify(importedChild)).toContain(childMarker);
        expect(await siyuanAPI.readWorkspaceText(`/data/${assetPath}`)).toBe(assetContent);

        await openWorkspace(page, `/?id=${importedParentID}`);
        const editor = await getDocumentEditor(page, importedParentID);
        await expect(editor).toContainText(parentMarker);
        await expect(editor.locator(
            `[data-type~="block-ref"][data-id="${importedChildBlock!.ID}"]`,
        )).toBeVisible();
        await page.reload();
        await expect(await getDocumentEditor(page, importedParentID)).toContainText(parentMarker);
        await expect.poll(async () => {
            const result = await siyuanAPI.searchBlocks(childMarker);
            return result.blocks.some(block => block.rootID === importedChildID);
        }, {timeout: 60000}).toBe(true);

        await siyuanAPI.removeWorkspaceFile(`/data/${assetPath}`);
    });
});
