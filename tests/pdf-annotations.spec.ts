import {Locator} from "@playwright/test";
import {expect, test as base} from "./fixtures";
import {createPdfFixture} from "./helpers/pdfFixture";
import {getDocumentEditor} from "./helpers/testNotebook";

interface PdfFixture {
    assetPath: string;
    link: Locator;
    panel: Locator;
    documentTab: Locator;
    open: () => Promise<void>;
    close: () => Promise<void>;
    errors: string[];
}

const test = base.extend<{pdf: PdfFixture}>({
    pdf: async ({page, context, baseURL, createTestDocument, siyuanAPI}, use, testInfo) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin: new URL(baseURL!).origin});
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
            if (message.type() === "error" && /pdf|offsetParent|Transport destroyed/i.test(
                message.text() + message.location().url)) errors.push(message.text());
        });
        const document = await createTestDocument("PDF Annotation E2E", "PDF fixture");
        const originalPdfSettings = await page.evaluate(() => window.siyuan.storage["local-pdftheme"]);
        const filename = `pdf-annotations-${document.docID}.pdf`;
        const upload = await siyuanAPI.uploadAsset(document.docID, filename, "application/pdf", createPdfFixture(document.docID));
        expect(upload.errFiles || []).toEqual([]);
        const assetPath = upload.succMap[filename];
        expect(assetPath).toMatch(/^assets\/.+\.pdf$/);
        const paragraph = document.editor.locator('[data-type="NodeParagraph"]').first();
        await siyuanAPI.updateBlock((await paragraph.getAttribute("data-node-id"))!,
            `[PDF fixture](${assetPath}) [PDF page three](${assetPath}?page=3)`);
        await siyuanAPI.flushTransactions();
        await page.reload();
        const editor = await getDocumentEditor(page, document.docID);
        const documentPanel = editor.locator("xpath=ancestor::*[contains(@class, 'protyle') and @data-id][1]");
        const documentTab = page.locator(`.layout-tab-bar [data-id="${await documentPanel.getAttribute("data-id")}"]`);
        const link = editor.locator(`span[data-type="a"][data-href="${assetPath}"]`);
        const panel = page.locator(".layout-tab-container > [data-id]").filter({has: page.locator("#viewerContainer")}).last();
        const close = async () => {
            if (await panel.count() === 0) return;
            const id = await panel.getAttribute("data-id");
            await page.locator(`.layout-tab-bar [data-id="${id}"] .item__close`).click();
            await expect(page.locator(`.layout-tab-container > [data-id="${id}"]`)).toHaveCount(0);
        };
        try {
            await use({assetPath, link, panel, documentTab, errors, close, open: async () => {
                await link.click({modifiers: ["Alt"]});
                await expect(panel.locator('.page[data-page-number="1"] .textLayer')).toContainText("asymmetrically");
            }});
            if (testInfo.status === "passed") {
                await close();
                // PDF 内容解析异步完成，避免清理文件时索引任务仍在读取它。
                await expect.poll(async () => {
                    const result = await siyuanAPI.post<{assetContent: unknown}>(
                        "/api/search/getAssetContentByPath", {path: assetPath});
                    return result.assetContent;
                }, {timeout: 30000}).toBeTruthy();
                await siyuanAPI.removeWorkspaceFile(`/data/${assetPath}.sya`, {ignoreNotFound: true});
                await siyuanAPI.removeWorkspaceFile(`/data/${assetPath}`);
            }
        } finally {
            await siyuanAPI.post("/api/storage/setLocalStorageVal", {
                key: "local-pdftheme", val: originalPdfSettings,
            });
        }
    },
});

test("shows the rectangle menu after dragging and restores the annotation after reopening", async ({page, pdf, siyuanAPI}) => {
    await pdf.open();
    await pdf.panel.locator("#rectAnno").click();
    const canvas = pdf.panel.locator('.page[data-page-number="1"] canvas').first();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 90, {steps: 10});
    await page.mouse.up();
    await expect(pdf.panel.locator(".pdf__util")).toBeVisible();
    const annotation = pdf.panel.locator('.pdf__rect[data-mode="rect"]');
    await expect(annotation).toHaveCount(1);
    await expect(annotation.locator(".pdf__rect-resize")).toHaveCount(4);
    const id = await annotation.getAttribute("data-node-id");
    await expect.poll(() => siyuanAPI.readWorkspaceText(`/data/${pdf.assetPath}.sya`)).toContain(id!);
    await pdf.close();
    await pdf.open();
    await expect(pdf.panel.locator(`.pdf__rect[data-node-id="${id}"]`)).toHaveCount(1);
    expect(pdf.errors).toEqual([]);
});

test("copies text using the rendered glyph boundaries", async ({page, pdf}) => {
    await pdf.open();
    await page.evaluate(() => navigator.clipboard.writeText("PDF copy regression sentinel"));
    const canvas = pdf.panel.locator('.page[data-page-number="1"] canvas').first();
    const box = (await canvas.boundingBox())!;
    const scale = box.width / 400;
    // 使用 PDF 中的字形位置拖选，不按文字层边界反推期望结果。
    await page.mouse.move(box.x + 25 * scale + 0.5, box.y + 96 * scale);
    await page.mouse.down();
    await page.mouse.move(box.x + 171.68 * scale - 0.5, box.y + 96 * scale, {steps: 20});
    await page.mouse.up();
    await page.keyboard.press("ControlOrMeta+C");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("by asymmetrically texturing");
    expect(pdf.errors).toEqual([]);
});

test("joins a hyphenated word when annotating search-highlighted text", async ({page, pdf, siyuanAPI}) => {
    await pdf.open();
    await pdf.panel.locator("#viewFindButton").click();
    await pdf.panel.locator("#findInput").fill("Fol");
    await expect(pdf.panel.locator('.page[data-page-number="1"] .textLayer .highlight')).toHaveText("Fol");
    const canvas = pdf.panel.locator('.page[data-page-number="1"] canvas').first();
    const box = (await canvas.boundingBox())!;
    const scale = box.width / 400;
    await page.mouse.move(box.x + 25 * scale + 0.5, box.y + 156 * scale);
    await page.mouse.down();
    await page.mouse.move(box.x + 60 * scale, box.y + 174 * scale, {steps: 20});
    await page.mouse.up();
    await expect(pdf.panel.locator(".pdf__util")).toBeVisible();
    await pdf.panel.locator(".pdf__util .color__square").first().click();
    await expect(pdf.panel.locator('.pdf__rect[data-mode="text"]')).toHaveAttribute("data-content", "Following");
    const id = await pdf.panel.locator('.pdf__rect[data-mode="text"]').getAttribute("data-node-id");
    await expect.poll(async () => {
        const data = JSON.parse(await siyuanAPI.readWorkspaceText(`/data/${pdf.assetPath}.sya`));
        return data[id!]?.content;
    }).toBe("Following");
    expect(pdf.errors).toEqual([]);
});

test("opens a background PDF at the requested page after activating its tab", async ({page, pdf}) => {
    await page.locator(`span[data-type="a"][data-href="${pdf.assetPath}?page=3"]`).click({button: "right"});
    await page.locator('#commonMenu [data-id="openBy"]:visible').hover();
    await page.locator('#commonMenu [data-id="openByBackground"]').click();
    await expect(pdf.panel).toBeAttached();
    await expect(pdf.panel).toBeHidden();
    const id = await pdf.panel.getAttribute("data-id");
    await page.locator(`.layout-tab-bar [data-id="${id}"]`).click();
    await expect(pdf.panel.locator("#pageNumber")).toHaveValue("3");
    await expect(pdf.panel.locator('.page[data-page-number="3"] .textLayer')).toContainText("asymmetrically");
    await expect(pdf.panel.locator('.page[data-page-number="3"]')).toBeInViewport();
    await expect(pdf.panel).not.toHaveAttribute("data-loading", "true");
    await pdf.documentTab.click();
    await expect(pdf.panel).toBeHidden();
    await page.locator(`.layout-tab-bar [data-id="${id}"]`).click();
    await expect(pdf.panel.locator("#pageNumber")).toHaveValue("3");
    expect(pdf.errors).toEqual([]);
});

test("closes during page navigation without stale rendering errors and reopens", async ({page, pdf}) => {
    await pdf.open();
    for (let i = 0; i < 3; i++) {
        const input = pdf.panel.locator("#pageNumber");
        await input.fill("3");
        await input.press("Enter");
        await pdf.close();
        await pdf.open();
    }
    expect(pdf.errors).toEqual([]);
});
