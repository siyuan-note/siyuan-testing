import {Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openWorkspace, showFileTree} from "./helpers/runtime";
import {getDocumentEditor} from "./helpers/testNotebook";
import {SiyuanAPI} from "./helpers/siyuanAPI";
import {getTitle, readTitle} from "./helpers/richTitle";

interface ISyDocument {
    ID: string;
    Spec: string;
    Properties: Record<string, string>;
    Children: unknown[];
}

const renameInEditor = async (page: Page, api: SiyuanAPI, id: string, title: string) => {
    await openWorkspace(page, `/?id=${id}`);
    await getDocumentEditor(page, id);
    const input = page.locator(`.protyle-title[data-node-id="${id}"]:visible .protyle-title__input`).last();
    await input.fill(title);
    await input.press("Tab");
    await expect.poll(async () => {
        const properties = (await api.readDocument<ISyDocument>(id)).Properties;
        return title === "" ? properties["custom-sy-title-empty"] === "true" :
            properties.title === title && properties["custom-sy-title-empty"] !== "true";
    }, {
        timeout: 15000,
    }).toBe(true);
    await page.reload();
    await getDocumentEditor(page, id);
    await expect(page.locator(`.protyle-title[data-node-id="${id}"]:visible .protyle-title__input`).last())
        .toHaveText(title);
};

test.describe("structured document titles", () => {
    test("preserves Unicode title source beyond the legacy plain-text length boundary", async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const document = await createTestDocument("Structured Title Unicode Limit");
        const title = "😀".repeat(512);
        await renameInEditor(page, siyuanAPI, document.docID, title);
        const input = page.locator(`.protyle-title[data-node-id="${document.docID}"]:visible .protyle-title__input`).last();
        await input.fill(`${title}😀`);
        await input.press("Tab");
        await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe(`${title}😀`);
        await page.reload();
        await getDocumentEditor(page, document.docID);
        await expect(input).toHaveText(`${title}😀`);
        const source = await siyuanAPI.readDocument<ISyDocument>(document.docID);
        expect(source.Properties.title).toBe(`${title}😀`);
        expect(Array.from(source.Properties.title)).toHaveLength(513);
        expect((await readTitle(siyuanAPI, document.docID)).source!.content).toContain(`${title}😀`);
    });

    test("preserves title characters through editor input and reload", async ({page, createTestDocument, siyuanAPI}) => {
        test.setTimeout(120000);
        const document = await createTestDocument("Structured Title Characters", "Title character fixture");
        for (const title of ["A/B", "A//B", "A／B", "A%2FB", ".", "..", "文档/测试 🚀", ""]) {
            await test.step(JSON.stringify(title), async () => {
                await renameInEditor(page, siyuanAPI, document.docID, title);
                const source = await siyuanAPI.readDocument<ISyDocument>(document.docID);
                expect(source.ID).toBe(document.docID);
                expect(source.Properties.id).toBe(document.docID);
                expect(Number(source.Spec)).toBeGreaterThanOrEqual(6);
                const [path] = (await siyuanAPI.getDocumentPaths(document.notebookID, [document.docID])).documents;
                expect(path.title.empty).toBe(title === "");
                expect(path.title.text).toBe(source.Properties.title);
            });
        }
    });

    test("parses newly entered inline Markdown without changing the document body", async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const document = await createTestDocument("Structured Title Markdown", "Markdown title body fixture");
        const before = await siyuanAPI.readDocument<ISyDocument>(document.docID);
        const input = getTitle(page, document.docID);
        await input.fill("**Title** / [text](link)");
        await input.press("Tab");
        await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe("Title / text");
        await page.reload();
        await getDocumentEditor(page, document.docID);
        await expect(input.locator('[data-type~="strong"]')).toHaveText("Title");
        await expect(input.locator('[data-type~="a"]')).toHaveText("text");
        await expect(input.locator('[data-type~="a"]')).toHaveAttribute("data-href", "link");
        expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(before.Children);
    });

    test("keeps legacy literal Markdown titles literal when editing and reloading", async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const document = await createTestDocument("**Title** / [text](link) Legacy Title", "Legacy title body fixture");
        const before = await siyuanAPI.readDocument<ISyDocument>(document.docID);
        expect((await readTitle(siyuanAPI, document.docID)).source).toBeNull();
        const input = getTitle(page, document.docID);
        await expect(input).toHaveText(document.title);
        await expect(input.locator('[data-type~="strong"], [data-type~="a"]')).toHaveCount(0);
        await input.evaluate(element => {
            element.focus();
            const range = window.document.createRange();
            range.selectNodeContents(element);
            range.collapse(false);
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await page.keyboard.insertText(" appended");
        await input.press("Tab");
        await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text)
            .toBe(`${document.title} appended`);
        await page.reload();
        await getDocumentEditor(page, document.docID);
        await expect(input).toHaveText(`${document.title} appended`);
        await expect(input.locator('[data-type~="strong"], [data-type~="a"]')).toHaveCount(0);
        expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(before.Children);
    });

    test("distinguishes a literal slash title from a parent and child with the same display path", async ({
        page, createTestDocument, siyuanAPI, trackTestDocument,
    }, testInfo) => {
        const root = await createTestDocument("Structured Title Hierarchy", "Independent hierarchy fixture");
        const create = async (title: string, parentID = root.docID) => {
            const id = await siyuanAPI.createDocument(root.notebookID, title, `Content of ${title}`, parentID);
            trackTestDocument({id, notebookID: root.notebookID, title});
            return id;
        };
        const literal = await create("A/B");
        const parent = await create("A");
        const child = await create("B", parent);
        const wide = await create("A／B");
        const escaped = await create("A%2FB");
        const paths = await siyuanAPI.getDocumentPaths(root.notebookID, [literal, parent, child, wide, escaped]);
        expect(paths.missingIDs).toEqual([]);
        const byID = new Map(paths.documents.map(document => [document.id, document]));
        expect(byID.get(literal)?.segments.map(segment => segment.text)).toEqual([root.title, "A/B"]);
        expect(byID.get(child)?.segments.map(segment => segment.text)).toEqual([root.title, "A", "B"]);
        expect(byID.get(literal)?.depth).toBe(2);
        expect(byID.get(child)?.depth).toBe(3);
        expect(byID.get(literal)?.parentID).toBe(root.docID);
        expect(byID.get(child)?.parentID).toBe(parent);
        expect(byID.get(literal)?.displayPath).toBe(byID.get(child)?.displayPath);
        for (const [title, id] of [["A/B", literal], ["A／B", wide], ["A%2FB", escaped]]) {
            const resolved = await siyuanAPI.resolveDocumentPath(root.notebookID, [root.title, title]);
            expect(resolved.status).toBe("resolved");
            expect(resolved.resolved?.id).toBe(id);
        }
        expect((await siyuanAPI.resolveDocumentPath(root.notebookID, [root.title, "A", "B"])).resolved?.id)
            .toBe(child);
        for (const [id, title] of [[literal, "A/B"], [child, "B"]]) {
            await openWorkspace(page, `/?id=${id}`);
            await expect(await getDocumentEditor(page, id)).toContainText(`Content of ${title}`);
            await expect(page.locator(`.protyle-title[data-node-id="${id}"]:visible .protyle-title__input`).last())
                .toHaveText(title);
            await expect(page.locator(`.protyle-breadcrumb__item[data-node-id="${id}"]:visible`).last())
                .toBeVisible();
            const persisted = await siyuanAPI.readDocument<ISyDocument>(id);
            expect(persisted.ID).toBe(id);
            expect(persisted.Properties).toMatchObject({id, title});
        }
        await testInfo.attach("hierarchy", {body: JSON.stringify(paths, null, 2), contentType: "application/json"});
        await testInfo.attach("desktop", {body: await page.screenshot(), contentType: "image/png"});
    });

    test("creates a subdocument from the file tree under a slash title", async ({
        page, createTestDocument, siyuanAPI, trackTestDocument,
    }) => {
        const parent = await createTestDocument("Structured Title UI Creation");
        const parentTitle = `${parent.title}/Parent`;
        await renameInEditor(page, siyuanAPI, parent.docID, parentTitle);
        const restoreFileTree = await showFileTree(page);
        try {
            // Locate the open document through the public UI: virtualized rows need not exist before locating.
            const tree = page.locator(".sy__file:visible");
            await tree.locator(".block__logo").hover();
            await tree.locator('[data-type="focus"]').click();
            const item = tree.locator(`li[data-type="navigation-file"][data-node-id="${parent.docID}"]`);
            await expect(item).toBeVisible();
            await item.hover();
            const responsePromise = page.waitForResponse(response =>
                new URL(response.url()).pathname === "/api/filetree/createDocByParent");
            await item.locator(':scope > [data-type="new"]').click();
            const response = await responsePromise;
            const result = await response.json() as {code: number; data: {id: string}};
            expect(result.code).toBe(0);
            const childID = result.data.id;
            trackTestDocument({id: childID, notebookID: parent.notebookID, title: "UI created child"});
            expect(response.request().postDataJSON().parentID).toBe(parent.docID);
            await renameInEditor(page, siyuanAPI, childID, "Child/Title");
            const [child] = (await siyuanAPI.getDocumentPaths(parent.notebookID, [childID])).documents;
            expect(child.parentID).toBe(parent.docID);
            expect(child.segments.map(segment => segment.text)).toEqual([parentTitle, "Child/Title"]);
            expect(child.path).toBe(`/${parent.docID}/${childID}.sy`);
        } finally {
            await restoreFileTree();
        }
    });

    test("keeps references and child identity after moving and renaming a slash-title parent", async ({
        page, createTestDocument, siyuanAPI, trackTestDocument,
    }) => {
        const parent = await createTestDocument("Structured Title Move Parent");
        const destination = await createTestDocument("Structured Title Move Destination");
        const query = `StructuredRef${Date.now()}`;
        const childTitle = `${query}/Child`;
        const childID = await siyuanAPI.createDocument(parent.notebookID, childTitle, "Referenced content", parent.docID);
        trackTestDocument({id: childID, notebookID: parent.notebookID, title: childTitle});
        const reference = await createTestDocument("Structured Title Reference");
        const paragraph = reference.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const paragraphID = await paragraph.getAttribute("data-node-id");
        // 文档创建与引用搜索索引异步完成，候选就绪后再触发编辑器搜索。
        await expect.poll(async () => {
            const result = await siyuanAPI.post<{blocks: Array<{id: string}> | null}>("/api/search/searchRefBlock", {
                id: paragraphID, rootID: reference.docID, k: query, beforeLen: 48,
            });
            return result.blocks?.some(block => block.id === childID) ?? false;
        }, {message: "waiting for the child document reference candidate", timeout: 30000}).toBe(true);
        await paragraph.locator('[contenteditable="true"]').click();
        await page.keyboard.type(`((${query}`, {delay: 10});
        const option = page.locator(`.protyle-hint:not(.fn__none) button:has([data-node-id="${childID}"])`).first();
        await expect(option).toBeVisible({timeout: 15000});
        await option.click();
        await expect(reference.editor.locator(`[data-type~="block-ref"][data-id="${childID}"]`))
            .toHaveText(childTitle);
        // Commit the editor interaction before moving the target and navigating to another document.
        await getTitle(page, reference.docID).click();
        await expect.poll(async () => JSON.stringify(
            (await siyuanAPI.readDocument<ISyDocument>(reference.docID)).Children,
        ), {message: "waiting for the inserted reference to persist", timeout: 15000}).toContain(childID);
        await siyuanAPI.moveDocuments([parent.docID], destination.docID);
        await renameInEditor(page, siyuanAPI, parent.docID, "Moved/Parent");
        await expect.poll(async () => {
            const [child] = (await siyuanAPI.getDocumentPaths(parent.notebookID, [childID])).documents;
            return {path: child.path, parentID: child.parentID, titles: child.segments.map(segment => segment.text)};
        }, {timeout: 30000}).toEqual({path: `/${destination.docID}/${parent.docID}/${childID}.sy`,
            parentID: parent.docID, titles: [destination.title, "Moved/Parent", childTitle]});
        await openWorkspace(page, `/?id=${reference.docID}`);
        const editor = await getDocumentEditor(page, reference.docID);
        await expect(editor.locator(`[data-type~="block-ref"][data-id="${childID}"]`)).toHaveText(childTitle);
        await openWorkspace(page, `/?id=${childID}`);
        await expect(await getDocumentEditor(page, childID)).toContainText("Referenced content");
    });
});
