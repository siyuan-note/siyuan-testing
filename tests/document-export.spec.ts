import {inflateRawSync} from "node:zlib";
import type {Page} from "@playwright/test";
import {expect, test} from "./fixtures";

const readZipEntries = (archive: Buffer) => {
    const entries = new Map<string, Buffer>();
    for (let offset = 0; offset <= archive.length - 46;) {
        if (archive.readUInt32LE(offset) !== 0x02014b50) {
            offset++;
            continue;
        }
        const method = archive.readUInt16LE(offset + 10);
        const compressedSize = archive.readUInt32LE(offset + 20);
        const filenameLength = archive.readUInt16LE(offset + 28);
        const extraLength = archive.readUInt16LE(offset + 30);
        const commentLength = archive.readUInt16LE(offset + 32);
        const localHeaderOffset = archive.readUInt32LE(offset + 42);
        const filename = archive.subarray(offset + 46, offset + 46 + filenameLength).toString("utf8");
        expect(archive.readUInt32LE(localHeaderOffset)).toBe(0x04034b50);
        const localFilenameLength = archive.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
        const dataOffset = localHeaderOffset + 30 + localFilenameLength + localExtraLength;
        const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
        if (!filename.endsWith("/")) {
            if (method === 0) {
                entries.set(filename, compressed);
            } else if (method === 8) {
                entries.set(filename, inflateRawSync(compressed));
            } else {
                throw new Error(`unsupported ZIP compression method ${method} for ${filename}`);
            }
        }
        offset += 46 + filenameLength + extraLength + commentLength;
    }
    return entries;
};

const getDocumentTreeItem = async (page: Page, notebookID: string, docID: string) => {
    const item = page.locator(`li.b3-list-item[data-type="navigation-file"][data-node-id="${docID}"]`);
    if (!await item.isVisible()) {
        const notebookRoot = page.locator(
            `ul.b3-list[data-url="${notebookID}"] > li[data-type="navigation-root"]`,
        );
        await expect(notebookRoot).toBeVisible();
        if (!await notebookRoot.locator(":scope > .b3-list-item__toggle .b3-list-item__arrow--open").isVisible()) {
            await notebookRoot.locator(":scope > .b3-list-item__toggle").click({force: true});
        }
    }
    await expect(item).toBeVisible({timeout: 10000});
    return item;
};

const createStandaloneHTML = (title: string, content: string, servePath = "") => `<!DOCTYPE html>
<html lang="en">
<head>
    <base href="${servePath}">
    <meta charset="utf-8">
    <link rel="stylesheet" href="stage/build/export/base.css">
    <link rel="stylesheet" href="appearance/themes/daylight/theme.css">
    <title>${title}</title>
</head>
<body>
<div class="protyle-wysiwyg" id="preview">${content}</div>
<script src="stage/protyle/js/protyle-html.js"></script>
<script src="stage/build/export/protyle-method.js"></script>
<script src="stage/protyle/js/lute/lute.min.js"></script>
<script>
    window.siyuan = {
        config: {
            appearance: {
                mode: 0,
                codeBlockThemeDark: "base16/dracula",
                codeBlockThemeLight: "github"
            },
            editor: {
                codeLineWrap: true,
                fontSize: 16,
                codeLigatures: false,
                plantUMLServePath: "",
                codeSyntaxHighlightLineNum: true,
                katexMacros: ""
            }
        },
        languages: {copy: "Copy"}
    };
    const previewElement = document.getElementById("preview");
    Protyle.highlightRender(previewElement, "stage/protyle");
    Protyle.mathRender(previewElement, "stage/protyle", false);
    Protyle.mermaidRender(previewElement, "stage/protyle");
</script>
</body>
</html>`;

test.describe("document export", () => {
    test("exports rich content as a Markdown ZIP from the document menu", async ({
        createTestDocument,
        page,
    }) => {
        const marker = `Export marker ${Date.now()}`;
        const source = [
            "## Rich export",
            "",
            `**${marker}** 中文 🚀`,
            "",
            "```javascript",
            "const answer = 42;",
            "```",
        ].join("\n");
        const document = await createTestDocument("Document Markdown Export E2E", source);
        const treeItem = await getDocumentTreeItem(page, document.notebookID, document.docID);
        await page.evaluate(() => {
            (window as Window & {__e2eOpenedURLs?: string[]}).__e2eOpenedURLs = [];
            window.open = ((url?: string | URL) => {
                (window as Window & {__e2eOpenedURLs?: string[]}).__e2eOpenedURLs!.push(String(url));
                return null;
            }) as typeof window.open;
        });

        await treeItem.click({button: "right", force: true});
        const menu = page.locator("#commonMenu:not(.fn__none)");
        await expect(menu).toBeVisible();
        const exportItem = menu.locator('[data-id="export"]');
        await expect(exportItem).toBeVisible();
        await exportItem.hover();
        const markdownItem = exportItem.locator('[data-id="exportMarkdown"]');
        await expect(markdownItem).toBeVisible();
        await markdownItem.click();

        const dialog = page.locator('[data-key="dialog-exportmarkdown"]');
        await expect(dialog.locator(".b3-button--text")).toBeVisible({timeout: 15000});
        await dialog.locator("#addTitle").check();
        await dialog.locator("#markdownYFM").uncheck();
        const exportResponse = page.waitForResponse(response =>
            new URL(response.url()).pathname === "/api/export/exportMd", {timeout: 30000});
        await dialog.locator(".b3-button--text").click();
        const response = await exportResponse;
        const payload = await response.json() as {data: {zip: string}};
        expect(payload.data.zip).toBeTruthy();

        await expect.poll(() => page.evaluate(() =>
            (window as Window & {__e2eOpenedURLs?: string[]}).__e2eOpenedURLs || [],
        )).toEqual([expect.stringContaining("download=true")]);
        const archiveResponse = await page.request.get(new URL(payload.data.zip, page.url()).toString());
        expect(archiveResponse.ok()).toBe(true);
        const archive = Buffer.from(await archiveResponse.body());
        expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        const entries = readZipEntries(archive);
        const markdownEntries = [...entries].filter(([name]) => name.endsWith(".md"));
        expect(markdownEntries).toHaveLength(1);
        const markdown = markdownEntries[0][1].toString("utf8");
        expect(markdown).toContain(`# ${document.title}`);
        expect(markdown).toContain("## Rich export");
        expect(markdown).toContain(`**${marker}** 中文 🚀`);
        expect(markdown).toContain("const answer = 42;");
    });

    test("packages standalone HTML and renders rich content with the export bundle", async ({
        baseURL,
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        expect(baseURL).toBeTruthy();
        const marker = `Standalone HTML marker ${Date.now()}`;
        const source = [
            "## Export bundle",
            "",
            `${marker} 中文 🚀`,
            "",
            "```javascript",
            "const exportedAnswer = 42;",
            "```",
            "",
            "$$",
            "E = mc^2",
            "$$",
            "",
            "```mermaid",
            "graph TD",
            "    Start --> Finish",
            "```",
        ].join("\n");
        const document = await createTestDocument("Document HTML Export E2E", source);
        const exported = await siyuanAPI.post<{
            content: string;
            folder: string;
            id: string;
            name: string;
        }>("/api/export/exportHTML", {
            id: document.docID,
            keepFold: false,
            merge: false,
            pdf: false,
            savePath: "",
        });
        expect(exported.id).toBe(document.docID);
        expect(exported.name).toContain(document.title);
        expect(exported.folder).toBeTruthy();
        expect(exported.content).toContain(marker);
        expect(exported.content).toContain("exportedAnswer");
        expect(exported.content).toContain('data-subtype="math"');
        expect(exported.content).toContain('data-subtype="mermaid"');

        const standaloneHTML = createStandaloneHTML(exported.name, exported.content);
        const packaged = await siyuanAPI.post<{zip: string}>("/api/export/exportBrowserHTML", {
            folder: exported.folder,
            html: standaloneHTML,
            name: exported.name,
        });
        const archiveResponse = await page.request.get(new URL(packaged.zip, baseURL).toString());
        expect(archiveResponse.ok()).toBe(true);
        const entries = readZipEntries(Buffer.from(await archiveResponse.body()));
        expect(entries.has("index.html")).toBe(true);
        expect(entries.has("stage/build/export/base.css")).toBe(true);
        expect(entries.has("stage/build/export/protyle-method.js")).toBe(true);
        expect(entries.has("stage/protyle/js/lute/lute.min.js")).toBe(true);
        expect(entries.get("index.html")?.toString("utf8")).toContain(marker);

        const rootURL = new URL("/", baseURL).toString();
        await page.setContent(createStandaloneHTML(exported.name, exported.content, rootURL), {waitUntil: "load"});
        await expect(page.locator("#preview")).toContainText(marker);
        await expect(page.locator("#preview .hljs")).toContainText("exportedAnswer", {timeout: 15000});
        await expect(page.locator('#preview [data-subtype="math"] .katex')).toBeVisible({timeout: 15000});
        await expect(page.locator('#preview [data-subtype="mermaid"] svg')).toBeVisible({timeout: 30000});
    });
});
