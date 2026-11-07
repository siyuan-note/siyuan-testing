import {getNotebookTreeItem} from "./helpers/fileTree";
import {devices} from "@playwright/test";
import {expect, test} from "./fixtures";
import {createMobileTestDocument, mobileEditor, mobileTitle, openMobileDocument, openMobileTitleEditor} from "./helpers/mobile";
import {readTitle} from "./helpers/richTitle";

test.use({...devices["iPhone 13"], defaultBrowserType: "chromium"});

test.describe("mobile document titles", () => {
    test("preserves literal title characters and empty titles after Enter and reload", async ({
        page, siyuanAPI, trackTestDocument,
    }, testInfo) => {
        test.setTimeout(120000);
        const marker = `mobile-title-characters-${Date.now()}`;
        const document = await createMobileTestDocument(page, siyuanAPI, trackTestDocument,
            "Mobile Title Characters", marker);
        const untitled = await page.evaluate(() => window.siyuan.languages._kernel[16]);
        for (const title of ["A/B", "A//B", "A／B", "A%2FB", ".", "..", "文档/测试 🚀", ""]) {
            await test.step(JSON.stringify(title), async () => {
                const input = await openMobileTitleEditor(page, document.docID);
                await input.fill(title);
                await input.press("Enter");
                await expect.poll(async () => {
                    const [saved] = (await siyuanAPI.getDocumentPaths(document.notebookID, [document.docID])).documents;
                    return title ? saved?.title.text : saved?.title.empty;
                }, {timeout: 15000}).toBe(title || true);
                const source = await siyuanAPI.readDocument<{
                    ID: string; Spec: string; Properties: Record<string, string>;
                }>(document.docID);
                expect(source.ID).toBe(document.docID);
                expect(source.Properties.id).toBe(document.docID);
                expect(Number(source.Spec)).toBeGreaterThanOrEqual(6);
                if (title) expect(source.Properties.title).toBe(title);
                else expect(source.Properties["custom-sy-title-empty"]).toBe("true");
                await page.reload();
                await expect(mobileTitle(page, document.docID)).toHaveText(title || untitled);
                await expect(await openMobileTitleEditor(page, document.docID)).toHaveText(title);
                await expect(mobileEditor(page)).toContainText(marker);
            });
        }
        await testInfo.attach("mobile-empty-title", {body: await page.screenshot(), contentType: "image/png"});
    });

    test("preserves rich Markdown title source and formatting after Enter and reload", async ({
        page, siyuanAPI, trackTestDocument,
    }) => {
        const marker = "Mobile rich title body";
        const document = await createMobileTestDocument(page, siyuanAPI, trackTestDocument,
            "Mobile Rich Title", marker);
        type BodyNode = {ID: string; Type: string; Properties: Record<string, string>; Children?: unknown[]};
        const before = await siyuanAPI.readDocument<{Children: BodyNode[]}>(document.docID);
        expect(before.Children).toHaveLength(1);
        expect(before.Children[0]).toMatchObject({
            Type: "NodeParagraph", Properties: {id: before.Children[0].ID},
            Children: [{Type: "NodeText", Data: marker}],
        });
        const input = await openMobileTitleEditor(page, document.docID);
        await input.fill("**Title** / [text](link)");
        await input.press("Enter");
        // 标题回车在已有非空正文前插入一个空段；标题保存和正文插入分别异步落盘。
        const body = mobileEditor(page);
        const blocks = body.locator(":scope > [data-node-id]");
        await expect(blocks).toHaveCount(before.Children.length + 1);
        const insertedID = (await blocks.first().getAttribute("data-node-id"))!;
        expect(insertedID).toMatch(/^\d{14}-[a-z0-9]{7}$/);
        expect(before.Children.map(node => node.ID)).not.toContain(insertedID);
        const expectedIDs = [insertedID, ...before.Children.map(node => node.ID)];
        const assertBodyDOM = async () => {
            await expect.poll(() => blocks.evaluateAll(elements => elements.map(element => element.getAttribute("data-node-id"))))
                .toEqual(expectedIDs);
            await expect(body.locator("[data-node-id]")).toHaveCount(expectedIDs.length);
            await expect(blocks.first()).toHaveAttribute("data-type", "NodeParagraph");
            await expect(blocks.first().locator(':scope > [contenteditable="true"]')).toHaveText("");
            await expect(blocks.nth(1)).toHaveAttribute("data-type", "NodeParagraph");
            await expect(blocks.nth(1).locator(':scope > [contenteditable="true"]')).toHaveText(marker);
        };
        await assertBodyDOM();
        let savedBody: BodyNode[] = [];
        await expect.poll(async () => {
            savedBody = (await siyuanAPI.readDocument<{Children: BodyNode[]}>(document.docID)).Children;
            return savedBody;
        }, {timeout: 15000}).toEqual([
            {ID: insertedID, Type: "NodeParagraph", Properties: {id: insertedID, updated: expect.stringMatching(/^\d{14}$/)}},
            ...before.Children,
        ]);
        const expectedSource = {
            spec: 1, format: "inline-ast", content: JSON.stringify([
                {Type: "NodeTextMark", TextMarkType: "strong", TextMarkTextContent: "Title"},
                {Type: "NodeText", Data: " / "},
                {Type: "NodeTextMark", TextMarkType: "a", TextMarkAHref: "link", TextMarkTextContent: "text"},
                // 链接末尾保留编辑器的光标占位文字，完整源不能只比较摘要。
                {Type: "NodeText", Data: "\u200b"},
            ]),
        };
        await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).source,
            {timeout: 15000}).toEqual(expectedSource);
        await expect.poll(async () => (await siyuanAPI.readDocument<{
            DocumentTitle: typeof expectedSource;
        }>(document.docID)).DocumentTitle, {timeout: 15000}).toEqual(expectedSource);
        const assertPersisted = async () => {
            const persisted = await siyuanAPI.readDocument<{
                ID: string; Spec: string; Properties: Record<string, string>;
                DocumentTitle: typeof expectedSource; Children: unknown[];
            }>(document.docID);
            expect(persisted.ID).toBe(document.docID);
            expect(persisted.Properties).toMatchObject({id: document.docID, title: "Title / text"});
            expect(Number(persisted.Spec)).toBeGreaterThanOrEqual(7);
            expect(persisted.DocumentTitle).toEqual(expectedSource);
            expect(persisted.Children).toEqual(savedBody);
            expect(await readTitle(siyuanAPI, document.docID)).toMatchObject({
                text: "Title / text", empty: false, format: "inline-ast", source: expectedSource,
            });
            expect((await siyuanAPI.getDocumentPaths(document.notebookID, [document.docID])).documents[0].title)
                .toEqual({text: "Title / text", empty: false, format: "inline-ast"});
        };
        await assertPersisted();
        for (const reload of [false, true]) {
            if (reload) await page.reload();
            const title = await openMobileTitleEditor(page, document.docID);
            await expect(title).toHaveText("Title / text");
            await expect(title.locator('[data-type="strong"]')).toHaveText("Title");
            await expect(title.locator('[data-type="a"]')).toHaveText("text");
            await expect(title.locator('[data-type="a"]')).toHaveAttribute("data-href", "link");
            await expect(mobileEditor(page)).toContainText(marker);
            await assertBodyDOM();
        }
        await assertPersisted();
    });

    test("keeps existing plain Markdown-like titles literal when opened and reloaded", async ({
        page, siyuanAPI, trackTestDocument,
    }) => {
        const document = await createMobileTestDocument(page, siyuanAPI, trackTestDocument,
            "Mobile Literal Markdown Title", "Mobile literal title body");
        const title = "**Title** / [text](link)";
        await siyuanAPI.renameDocument(document.docID, title);
        await openMobileDocument(page, document.docID);
        for (const reload of [false, true]) {
            if (reload) await page.reload();
            await expect(mobileTitle(page, document.docID)).toHaveText(title);
            const input = await openMobileTitleEditor(page, document.docID);
            await expect(input).toHaveText(title);
            await expect(input.locator('[data-type="strong"], [data-type="a"]')).toHaveCount(0);
            await input.press("Enter");
            await expect.poll(async () => {
                const saved = await readTitle(siyuanAPI, document.docID);
                return {text: saved.text, format: saved.format, source: saved.source};
            }).toEqual({text: title, format: "plain", source: null});
            const persisted = await siyuanAPI.readDocument<{
                Properties: Record<string, string>; DocumentTitle?: unknown;
            }>(document.docID);
            expect(persisted.Properties.title).toBe(title);
            expect(persisted.DocumentTitle).toBeUndefined();
            await expect(mobileEditor(page)).toContainText("Mobile literal title body");
        }
    });

    test("preserves Unicode titles at and beyond the plain creation limit after Enter and reload", async ({
        page, siyuanAPI, trackTestDocument,
    }) => {
        const document = await createMobileTestDocument(page, siyuanAPI, trackTestDocument,
            "Mobile Title Unicode Limit", "Unicode title body");
        // 完整标题编辑使用行级源校验，不能套用普通创建接口的 512 码点限制。
        for (const title of ["😀".repeat(512), "🚀".repeat(513)]) {
            const input = await openMobileTitleEditor(page, document.docID);
            await input.fill(title);
            await input.press("Enter");
            await expect.poll(async () => (await siyuanAPI.getDocumentPaths(document.notebookID, [document.docID]))
                .documents[0]?.title.text, {timeout: 15000}).toBe(title);
            const persisted = await siyuanAPI.readDocument<{Properties: Record<string, string>}>(document.docID);
            expect(persisted.Properties.title).toBe(title);
            await page.reload();
            await expect(mobileTitle(page, document.docID)).toHaveText(title);
            await expect(await openMobileTitleEditor(page, document.docID)).toHaveText(title);
            await expect(mobileEditor(page)).toContainText("Unicode title body");
        }
    });

    test("opens literal slash titles and nested titles as different documents from the tree", async ({
        page, siyuanAPI, trackTestDocument,
    }, testInfo) => {
        const root = await createMobileTestDocument(page, siyuanAPI, trackTestDocument,
            "Mobile Title Hierarchy", "Mobile hierarchy root");
        const create = async (title: string, text: string, parentID = root.docID) => {
            const id = await siyuanAPI.createDocument(root.notebookID, title, text, parentID);
            trackTestDocument({id, notebookID: root.notebookID, title});
            return id;
        };
        const literal = await create("A/B", "Mobile literal slash content");
        const parent = await create("A", "Mobile parent content");
        const child = await create("B", "Mobile nested content", parent);
        const documents = (await siyuanAPI.getDocumentPaths(root.notebookID, [literal, child])).documents;
        expect(documents[0].displayPath).toBe(documents[1].displayPath);
        expect(new Set(documents.map(document => document.depth))).toEqual(new Set([2, 3]));
        const tree = page.locator('[data-type="sidebar-file"]');
        const row = (id: string) => tree.locator(`li[data-type="navigation-file"][data-node-id="${id}"]`);
        const expand = async (item: ReturnType<typeof row>) => {
            if (!await item.locator(":scope > .b3-list-item__toggle .b3-list-item__arrow--open").count()) {
                await item.locator(":scope > .b3-list-item__toggle").tap();
            }
        };
        await page.locator("#toolbarFile").tap();
        await expect(tree).toBeVisible();
        await expand(getNotebookTreeItem(tree, root.notebookID));
        await expand(row(root.docID));
        await row(literal).locator(".b3-list-item__text").tap();
        await expect(mobileTitle(page, literal)).toHaveText("A/B");
        await expect(mobileEditor(page)).toContainText("Mobile literal slash content");
        await page.locator("#toolbarFile").tap();
        await expand(row(parent));
        await row(child).locator(".b3-list-item__text").tap();
        await expect(mobileTitle(page, child)).toHaveText("B");
        await expect(mobileEditor(page)).toContainText("Mobile nested content");
        await testInfo.attach("mobile-nested-title", {body: await page.screenshot(), contentType: "image/png"});
    });

    test("clears encrypted titles when locked and restores them after unlocking", async ({page, siyuanAPI}, testInfo) => {
        const password = process.env.SIYUAN_TEST_ENCRYPTION_PASSWORD;
        test.skip(!password, "Set SIYUAN_TEST_ENCRYPTION_PASSWORD to run encrypted notebook lifecycle tests.");
        if (!password) return;
        const initial = await siyuanAPI.getEncryptedNotebookStatus();
        test.skip(!initial.enabled, "Encrypted notebooks must already be enabled by the test workspace owner.");
        if (!initial.enabled) return;
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const name = `SiYuan Testing Encrypted Mobile ${suffix}`;
        const marker = `mobile-private-title-${suffix}`;
        const title = `${marker}/Private 🚀`;
        let notebookID = "";
        try {
            notebookID = (await siyuanAPI.createEncryptedNotebook(name, password)).id;
            const docID = await siyuanAPI.createDocument(notebookID, "Mobile private title", marker);
            await openMobileDocument(page, docID);
            const input = await openMobileTitleEditor(page, docID);
            await input.fill(title);
            await input.press("Enter");
            await expect.poll(async () => (await siyuanAPI.getDocumentPaths(notebookID, [docID]))
                .documents[0]?.title.text).toBe(title);
            await page.reload();
            await expect(mobileTitle(page, docID)).toHaveText(title);
            await expect(mobileEditor(page)).toContainText(marker);
            await page.waitForLoadState("networkidle");
            await siyuanAPI.lockNotebook(notebookID);
            await expect(page.locator("#editor")).not.toContainText(marker);
            await expect(mobileTitle(page, docID)).toHaveCount(0);
            await expect(page.locator("#toolbarNameReadonly")).not.toContainText(marker);
            expect((await siyuanAPI.postResult<null>("/api/filetree/getDocPaths", {
                notebook: notebookID, ids: [docID],
            })).code).not.toBe(0);
            const tabs = await siyuanAPI.post<unknown>("/api/storage/getLocalStorageVal", {key: "local-mobile-tabs"});
            expect(JSON.stringify(tabs)).not.toContain(docID);
            expect(JSON.stringify(tabs)).not.toContain(marker);
            await siyuanAPI.unlockAndOpenNotebook(notebookID, password);
            await openMobileDocument(page, docID);
            await expect(mobileTitle(page, docID)).toHaveText(title);
            await expect(mobileEditor(page)).toContainText(marker);
            await page.reload();
            await expect(mobileTitle(page, docID)).toHaveText(title);
            await expect(mobileEditor(page)).toContainText(marker);
            await page.waitForLoadState("networkidle");
            await page.goto("about:blank");
            await siyuanAPI.removeNotebook(notebookID);
            notebookID = "";
            expect((await siyuanAPI.getEncryptedNotebookStatus()).boxes.map(box => box.id).sort())
                .toEqual(initial.boxes.map(box => box.id).sort());
        } catch (error) {
            await page.goto("about:blank").catch(() => undefined);
            if (notebookID) {
                const status = await siyuanAPI.getEncryptedNotebookStatus().catch(() => undefined);
                if (status?.boxes.find(box => box.id === notebookID)?.unlocked) {
                    await siyuanAPI.lockNotebook(notebookID).catch(() => undefined);
                }
                await testInfo.attach("preserved-encrypted-notebook", {
                    body: Buffer.from(JSON.stringify({id: notebookID, name})), contentType: "application/json",
                });
            }
            throw error;
        }
    });
});
