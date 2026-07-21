import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";

const focusAtEnd = async (block: Locator) => {
    const editable = block.locator('[contenteditable="true"]').first();
    await expect(editable).toBeVisible();
    await editable.click();
    await editable.evaluate(element => {
        element.focus();
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        const selection = getSelection();
        if (!selection) {
            throw new Error("selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    });
};

const waitForResponse = (page: Page, path: string) => page.waitForResponse(response =>
    new URL(response.url()).pathname === path, {timeout: 15000});

const openAssetUpload = async (page: Page, editor: Locator) => {
    const protyle = editor.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle ')][1]",
    );
    const title = protyle.locator(".protyle-title__input");
    await expect.poll(() => title.evaluate(element => element === element.ownerDocument.activeElement), {
        timeout: 15000,
    }).toBe(true);
    const paragraph = editor.locator(':scope > [data-type="NodeParagraph"]').first();
    await focusAtEnd(paragraph);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("/upload", {delay: 10});
    const input = protyle.locator(
        '.protyle-hint:not(.fn__none) [data-id="insertAsset"] input[type="file"]',
    );
    await expect(input).toBeAttached();
    return input;
};

test.describe("editor assets", () => {
    test("uploads an attachment and restores its reference after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Editor Asset Upload E2E", "Asset seed");
        const uploadInput = await openAssetUpload(page, document.editor);
        const filename = `e2e-asset-${Date.now()}.txt`;
        const content = "SiYuan asset E2E 中文 🚀\nsecond line";
        const uploadResponse = waitForResponse(page, "/upload");
        const transactionResponse = waitForResponse(page, "/api/transactions");
        await uploadInput.setInputFiles({
            name: filename,
            mimeType: "text/plain",
            buffer: Buffer.from(content),
        });
        const response = await uploadResponse;
        await transactionResponse;
        const payload = await response.json() as {
            code: number;
            data: {succMap: Record<string, string>};
        };
        expect(payload.code).toBe(0);
        const assetPath = payload.data.succMap[filename];
        expect(assetPath).toMatch(/^assets\/.+\.txt$/);

        const link = document.editor.locator(`span[data-type="a"][data-href="${assetPath}"]`);
        await expect(link).toHaveText(filename);
        const workspacePath = `/data/${assetPath}`;
        expect(await siyuanAPI.readWorkspaceText(workspacePath)).toBe(content);
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument<unknown>(document.docID)), {
            timeout: 30000,
        }).toContain(assetPath);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        await expect(reloadedEditor.locator(`span[data-type="a"][data-href="${assetPath}"]`)).toHaveText(filename);
        expect(await siyuanAPI.readWorkspaceText(workspacePath)).toBe(content);

        await siyuanAPI.removeWorkspaceFile(workspacePath);
    });

    test("uploads and decodes an image after reload", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const document = await createTestDocument("Editor Image Upload E2E", "Image seed");
        const uploadInput = await openAssetUpload(page, document.editor);
        const filename = `e2e-image-${Date.now()}.png`;
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
        );
        const uploadResponse = waitForResponse(page, "/upload");
        const transactionResponse = waitForResponse(page, "/api/transactions");
        await uploadInput.setInputFiles({name: filename, mimeType: "image/png", buffer: png});
        const response = await uploadResponse;
        await transactionResponse;
        const payload = await response.json() as {
            code: number;
            data: {succMap: Record<string, string>};
        };
        expect(payload.code).toBe(0);
        const assetPath = payload.data.succMap[filename];
        expect(assetPath).toMatch(/^assets\/.+\.png$/);

        const image = document.editor.locator(`span[data-type="img"] img[data-src="${assetPath}"]`);
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate(element => ({
            complete: (element as HTMLImageElement).complete,
            height: (element as HTMLImageElement).naturalHeight,
            width: (element as HTMLImageElement).naturalWidth,
        })), {timeout: 15000}).toEqual({complete: true, height: 1, width: 1});
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument<unknown>(document.docID)), {
            timeout: 30000,
        }).toContain(assetPath);

        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        const reloadedImage = reloadedEditor.locator(`span[data-type="img"] img[data-src="${assetPath}"]`);
        await expect(reloadedImage).toBeVisible();
        await expect.poll(() => reloadedImage.evaluate(element => (element as HTMLImageElement).naturalWidth), {
            timeout: 15000,
        }).toBe(1);

        await siyuanAPI.removeWorkspaceFile(`/data/${assetPath}`);
    });
});
