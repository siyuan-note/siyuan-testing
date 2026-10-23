import {devices} from "@playwright/test";
import {expect, test} from "./fixtures";
import {createMobileTestDocument, mobileEditor, openMobileDocument} from "./helpers/mobile";

test.use({...devices["iPhone 13"], defaultBrowserType: "chromium"});

test.describe("mobile document titles", () => {
    test("preserves literal title characters and empty titles after Enter and reload", async ({
        page, siyuanAPI, trackTestDocument,
    }, testInfo) => {
        test.setTimeout(120000);
        const marker = `mobile-title-characters-${Date.now()}`;
        const document = await createMobileTestDocument(page, siyuanAPI, trackTestDocument,
            "Mobile Title Characters", marker);
        const input = page.locator("#toolbarName");
        for (const title of ["A/B", "A//B", "A／B", "A%2FB", ".", "..", "文档/测试 🚀", "**Title** / [text](link)", ""]) {
            await test.step(JSON.stringify(title), async () => {
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
                await expect(input).toHaveValue(title);
                await expect(mobileEditor(page)).toContainText(marker);
            });
        }
        await testInfo.attach("mobile-empty-title", {body: await page.screenshot(), contentType: "image/png"});
    });

    test("preserves 512 Unicode characters and saves the truncated title on Enter", async ({
        page, siyuanAPI, trackTestDocument,
    }) => {
        const document = await createMobileTestDocument(page, siyuanAPI, trackTestDocument,
            "Mobile Title Unicode Limit", "Unicode title body");
        const input = page.locator("#toolbarName");
        const boundary = "😀".repeat(512);
        await input.fill(boundary);
        await input.press("Enter");
        await expect.poll(async () => (await siyuanAPI.getDocumentPaths(document.notebookID, [document.docID]))
            .documents[0]?.title.text).toBe(boundary);
        await page.reload();
        await expect(input).toHaveValue(boundary);

        const truncated = "🚀".repeat(512);
        await input.fill(`${truncated}🚀`);
        await input.press("Enter");
        await expect(input).toHaveValue(truncated);
        await expect.poll(async () => (await siyuanAPI.getDocumentPaths(document.notebookID, [document.docID]))
            .documents[0]?.title.text, {timeout: 15000}).toBe(truncated);
        await page.reload();
        await expect(input).toHaveValue(truncated);
        await expect(mobileEditor(page)).toContainText("Unicode title body");
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
        await expand(tree.locator(`ul[data-url="${root.notebookID}"] > li[data-type="navigation-root"]`));
        await expand(row(root.docID));
        await row(literal).locator(".b3-list-item__text").tap();
        await expect(page.locator("#toolbarName")).toHaveValue("A/B");
        await expect(mobileEditor(page)).toContainText("Mobile literal slash content");
        await page.locator("#toolbarFile").tap();
        await expand(row(parent));
        await row(child).locator(".b3-list-item__text").tap();
        await expect(page.locator("#toolbarName")).toHaveValue("B");
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
            await page.locator("#toolbarName").fill(title);
            await page.locator("#toolbarName").press("Enter");
            await expect.poll(async () => (await siyuanAPI.getDocumentPaths(notebookID, [docID]))
                .documents[0]?.title.text).toBe(title);
            await page.reload();
            await expect(page.locator("#toolbarName")).toHaveValue(title);
            await expect(mobileEditor(page)).toContainText(marker);
            await page.waitForLoadState("networkidle");
            await siyuanAPI.lockNotebook(notebookID);
            await expect(page.locator("#editor")).not.toContainText(marker);
            await expect(page.locator("#toolbarName")).not.toHaveValue(title);
            expect((await siyuanAPI.postResult<null>("/api/filetree/getDocPaths", {
                notebook: notebookID, ids: [docID],
            })).code).not.toBe(0);
            const tabs = await siyuanAPI.post<unknown>("/api/storage/getLocalStorageVal", {key: "local-mobile-tabs"});
            expect(JSON.stringify(tabs)).not.toContain(docID);
            expect(JSON.stringify(tabs)).not.toContain(marker);
            await siyuanAPI.unlockAndOpenNotebook(notebookID, password);
            await openMobileDocument(page, docID);
            await expect(page.locator("#toolbarName")).toHaveValue(title);
            await expect(mobileEditor(page)).toContainText(marker);
            await page.reload();
            await expect(page.locator("#toolbarName")).toHaveValue(title);
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
