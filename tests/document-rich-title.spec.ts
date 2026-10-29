import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";
import {openWorkspace, showDock} from "./helpers/runtime";
import {readZipEntries} from "./helpers/zip";
import {getTitle, pasteParagraphIntoTitle, readTitle} from "./helpers/richTitle";

interface ISyNode {
    ID?: string;
    Type: string;
    Data?: string;
    HeadingLevel?: number;
    Children?: ISyNode[];
}

interface ISyDocument {
    ID: string;
    DocumentTitle?: unknown;
    Children: ISyNode[];
}

// A trailing tag gains a caret placeholder in the editor. It is not title text;
// compare all other inline fields exactly, including real whitespace and marks.
const withoutTagCaretPlaceholder = (nodes: ISyNode[] | undefined) => nodes?.map((node, index) => {
    if (index === nodes.length - 1 && node.Type === "NodeText" && node.Data === "\u200b"
        && (nodes[index - 1] as ISyNode & {TextMarkType?: string})?.TextMarkType === "tag") {
        const {Data, ...rest} = node;
        return rest;
    }
    return node;
});

test("rich title preserves inline styles and body through paste, reload and undo", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Rich Title Inline E2E",
        "**Bold** *Italic* ~~Strike~~ ==Mark== `Code` [Link](https://example.com) $x^2$ #Tag# :smile:");
    expect(await document.editor.evaluate(element => element.closest(".protyle-title") === null)).toBe(true);
    const before = await siyuanAPI.readDocument<ISyDocument>(document.docID);
    const initial = await readTitle(siyuanAPI, document.docID);
    const source = document.editor.locator('[data-type="NodeParagraph"] > [contenteditable]').first();
    const title = getTitle(page, document.docID);
    await expect(title).toBeVisible();
    await pasteParagraphIntoTitle(source, title);
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).source !== null).toBe(true);
    const saved = await readTitle(siyuanAPI, document.docID);
    for (const type of ["strong", "em", "s", "mark", "code", "a", "inline-math", "tag"]) {
        await expect(title.locator(`[data-type~="${type}"]`)).toHaveCount(1);
    }
    expect(saved.source).toMatchObject({spec: 1, format: "inline-ast"});
    expect(saved.revision).not.toBe(initial.revision);
    expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(before.Children);
    await title.focus();
    await title.press("ControlOrMeta+z");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe(initial.text);
    await title.press("ControlOrMeta+y");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).source).toEqual(saved.source);
    await page.reload();
    await getDocumentEditor(page, document.docID);
    await expect(getTitle(page, document.docID).locator('[data-type~="strong"]')).toHaveText("Bold");
    expect((await readTitle(siyuanAPI, document.docID)).source).toEqual(saved.source);
    expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children).toEqual(before.Children);
    const restoredTitle = getTitle(page, document.docID);
    const bodyParagraph = (await getDocumentEditor(page, document.docID))
        .locator('[data-type="NodeParagraph"] > [contenteditable]').first();
    const titleBounds = await restoredTitle.boundingBox();
    const bodyBounds = await bodyParagraph.boundingBox();
    expect(Math.abs(titleBounds!.x - bodyBounds!.x), "title and body share the same text start").toBeLessThan(8);
    const titleHost = restoredTitle.locator("xpath=ancestor::*[contains(@class, 'protyle-title__rich')][1]");
    for (const width of [1440, 900, 1440]) {
        await page.setViewportSize({width, height: 900});
        await getDocumentEditor(page, document.docID);
        const contentBounds = await restoredTitle.boundingBox();
        const hostBounds = await titleHost.boundingBox();
        expect(hostBounds!.height - contentBounds!.height, "title host follows single or wrapped content height")
            .toBeLessThanOrEqual(8);
    }
    const titleWysiwyg = restoredTitle.locator("xpath=ancestor::*[contains(@class, 'protyle-wysiwyg')][1]");
    await titleWysiwyg.evaluate(element => {
        const last = element.lastElementChild!.getBoundingClientRect();
        element.dispatchEvent(new MouseEvent("click", {
            bubbles: true, clientX: last.left + 10, clientY: last.bottom + 8,
        }));
    });
    await expect(titleWysiwyg.locator(':scope > [data-type="NodeParagraph"]')).toHaveCount(1);
    await expect.poll(() => restoredTitle.evaluate(element => element.contains(getSelection()?.anchorNode || null)))
        .toBe(true);
    expect((await readTitle(siyuanAPI, document.docID)).source).toEqual(saved.source);
    await titleWysiwyg.evaluate(element => {
        const blanks: string[] = [];
        const observer = new MutationObserver(records => {
            records.forEach(record => record.addedNodes.forEach(node => {
                if (node instanceof HTMLElement) {
                    node.querySelectorAll<HTMLElement>('[data-type="inline-math"]').forEach(math => {
                        if (math.dataset.render !== "true") blanks.push(math.outerHTML);
                    });
                }
            }));
        });
        observer.observe(element, {childList: true, subtree: true});
        (window as unknown as {titleInputObservation: {blanks: string[], stop: () => void}})
            .titleInputObservation = {blanks, stop: () => observer.disconnect()};
    });
    await restoredTitle.focus();
    await restoredTitle.evaluate(element => {
        const range = window.document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
    });
    await page.keyboard.type("123", {delay: 300});
    await restoredTitle.press("Tab");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toContain("123");
    expect(await page.evaluate(() => {
        const observation = (window as unknown as {titleInputObservation: {blanks: string[], stop: () => void}})
            .titleInputObservation;
        observation.stop();
        return observation.blanks;
    }),
        "unchanged formulas stay rendered while typing adjacent text").toEqual([]);
});

for (const level of [1, 2, 3, 4, 5, 6]) {
    test(`rich heading level ${level} round-trips through a document without losing source or block identity`, async ({
        page, createTestDocument, siyuanAPI, trackTestDocument,
    }) => {
        const prefix = "#".repeat(level);
        const document = await createTestDocument(`Rich Title Conversion H${level} E2E`,
            `Before\n\n${prefix} **Bold** *Italic* ~~Strike~~ ==Mark== \`Code\` [Link](https://example.com) $x^2$ #Tag#\n\nMoved body\n\n${prefix} Stop\n\nAfter`);
        const before = await siyuanAPI.readDocument<ISyDocument>(document.docID);
        const heading = before.Children.find(node => node.Type === "NodeHeading")!;
        const headingID = heading.ID!;
        const headingIndex = before.Children.indexOf(heading);
        const body = before.Children[headingIndex + 1];
        const stop = before.Children[headingIndex + 2];
        await siyuanAPI.post<null>("/api/filetree/heading2Doc", {
            srcHeadingID: headingID, targetNoteBook: document.notebookID, targetPath: "/",
        });
        trackTestDocument({id: headingID, notebookID: document.notebookID, title: `Converted H${level}`});
        const source = await readTitle(siyuanAPI, headingID);
        expect(withoutTagCaretPlaceholder(JSON.parse(source.source!.content)))
            .toEqual(withoutTagCaretPlaceholder(heading.Children));
        const converted = await siyuanAPI.readDocument<ISyDocument>(headingID);
        expect(converted.ID).toBe(headingID);
        expect(converted.Children.map(node => node.ID)).toContain(body.ID);
        expect((await siyuanAPI.readDocument<ISyDocument>(document.docID)).Children.map(node => node.ID))
            .not.toContain(headingID);
        await openWorkspace(page, `/?id=${headingID}`);
        await getDocumentEditor(page, headingID);
        await expect(getTitle(page, headingID).locator('[data-type~="strong"]')).toHaveText("Bold");
        await siyuanAPI.post("/api/filetree/doc2Heading", {srcID: headingID, targetID: stop.ID, after: false});
        await openWorkspace(page, `/?id=${document.docID}`);
        const editor = await getDocumentEditor(page, document.docID);
        const restored = await siyuanAPI.readDocument<ISyDocument>(document.docID);
        expect(restored.Children.map(node => node.ID)).toEqual(before.Children.map(node => node.ID));
        const restoredHeading = restored.Children.find(node => node.ID === headingID)!;
        expect(restoredHeading.HeadingLevel).toBe(level);
        expect(withoutTagCaretPlaceholder(restoredHeading.Children))
            .toEqual(withoutTagCaretPlaceholder(heading.Children));
        await expect(editor.locator(`[data-node-id="${headingID}"][data-type="NodeHeading"]`)).toHaveCount(1);
        await expect(editor.locator(`[data-node-id="${body.ID}"]`)).toHaveCount(1);
    });
}

test("title-only images stay referenced through native import and native and Markdown exports", async ({
    page, createTestDocument, siyuanAPI, trackTestDocument,
}) => {
    const document = await createTestDocument("Rich Title Asset Export E2E", "Source paragraph");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8bUAAAAASUVORK5CYII=", "base64");
    const uploaded = await siyuanAPI.uploadAsset(document.docID, `title-${Date.now()}.png`, "image/png", png);
    const asset = Object.values(uploaded.succMap)[0];
    expect(asset).toBeTruthy();
    const paragraph = document.editor.locator('[data-type="NodeParagraph"]').first();
    const paragraphID = await paragraph.getAttribute("data-node-id");
    await siyuanAPI.post("/api/block/updateBlock", {
        id: paragraphID, dataType: "markdown", data: `**Image title** ![Title picture](${asset} "Picture metadata")`,
    });
    await page.reload();
    const editor = await getDocumentEditor(page, document.docID);
    await pasteParagraphIntoTitle(editor.locator('[data-type="NodeParagraph"] > [contenteditable]').first(),
        getTitle(page, document.docID));
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).source?.content || "").toContain(asset);
    await siyuanAPI.post("/api/block/updateBlock", {id: paragraphID, dataType: "markdown", data: "Body without an asset"});
    await siyuanAPI.flushTransactions();
    const saved = await siyuanAPI.readDocument<ISyDocument>(document.docID);
    expect(JSON.stringify(saved.Children)).not.toContain(asset);
    const titleSource = (await readTitle(siyuanAPI, document.docID)).source;
    const unused = await siyuanAPI.post<unknown[]>("/api/asset/getUnusedAssets", {});
    expect(JSON.stringify(unused)).not.toContain(asset);
    let nativeArchive: Buffer | undefined;
    for (const endpoint of ["/api/export/exportSY", "/api/export/exportMd"]) {
        const exported = await siyuanAPI.post<{name: string; zip: string}>(endpoint, {
            id: document.docID, addTitle: true, includeSubDocs: false, includeRelatedDocs: false, markdownYFM: false,
        });
        const archive = await siyuanAPI.downloadFile(exported.zip);
        const entries = readZipEntries(archive);
        expect([...entries.keys()].some(name => name.endsWith(asset.split("/").pop()!))).toBe(true);
        if (endpoint.endsWith("exportSY")) {
            nativeArchive = archive;
            const source = [...entries].find(([name]) => name.endsWith(`${document.docID}.sy`))!;
            expect(JSON.parse(source[1].toString("utf8")).DocumentTitle).toEqual(titleSource);
        } else {
            const markdown = [...entries].find(([name]) => name.endsWith(".md"))![1].toString("utf8");
            expect(markdown).toContain("**Image title**");
            expect(markdown).toContain("Title picture");
        }
    }
    await page.reload();
    await getDocumentEditor(page, document.docID);
    await expect(getTitle(page, document.docID).locator("img")).toHaveAttribute("src", asset);
    const existingIDs = new Set((await siyuanAPI.listAllDocuments(document.notebookID)).map(doc => doc.id));
    await siyuanAPI.importArchive("/api/import/importSY", nativeArchive!, "rich-title.sy.zip", document.notebookID);
    let importedID = "";
    await expect.poll(async () => {
        importedID = (await siyuanAPI.listAllDocuments(document.notebookID))
            .find(doc => !existingIDs.has(doc.id))?.id || "";
        return importedID;
    }, {timeout: 30000}).not.toBe("");
    trackTestDocument({id: importedID, notebookID: document.notebookID, title: "Imported rich title"});
    expect((await readTitle(siyuanAPI, importedID)).source).toEqual(titleSource);
    await openWorkspace(page, `/?id=${importedID}`);
    await getDocumentEditor(page, importedID);
    await expect(getTitle(page, importedID).locator("img")).toHaveAttribute("src", asset);
    await expect(getTitle(page, importedID).locator('[data-type~="strong"]')).toHaveText("Image title");
});

test("history rollback restores the complete rich title source and its rendering", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Rich Title History E2E", "**Historical title** $x^2$");
    await pasteParagraphIntoTitle(document.editor.locator('[data-type="NodeParagraph"] > [contenteditable]').first(),
        getTitle(page, document.docID));
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).source !== null).toBe(true);
    const saved = await readTitle(siyuanAPI, document.docID);
    await siyuanAPI.createDocumentHistory(document.docID);
    let historyPath = "";
    await expect.poll(async () => {
        const history = await siyuanAPI.searchDocumentHistory(document.docID, document.notebookID, "update");
        if (!history.histories[0]) return "";
        const items = await siyuanAPI.getDocumentHistoryItems(document.docID, history.histories[0], "update");
        historyPath = items.find(item => item.path.endsWith(`/${document.docID}.sy`))?.path || "";
        return historyPath;
    }, {timeout: 15000}).not.toBe("");
    await getTitle(page, document.docID).fill("Replacement title");
    await getTitle(page, document.docID).press("Tab");
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).text).toBe("Replacement title");
    await siyuanAPI.rollbackDocumentHistory(historyPath);
    await openWorkspace(page, `/?id=${document.docID}`);
    await getDocumentEditor(page, document.docID);
    expect((await readTitle(siyuanAPI, document.docID)).source).toEqual(saved.source);
    await expect(getTitle(page, document.docID).locator('[data-type~="strong"]')).toHaveText("Historical title");
    await expect(getTitle(page, document.docID).locator('[data-type="inline-math"] .katex')).toBeVisible();
});

test("title block references create a root backlink and follow target renames", async ({
    page, createTestDocument, siyuanAPI, trackTestDocument,
}) => {
    const target = await createTestDocument("Rich Title Target E2E", "Independent reference target");
    const sourceID = await siyuanAPI.createDocument(target.notebookID, `Rich Title Ref E2E ${Date.now()}`,
        `((${target.docID} '${target.title}'))`);
    trackTestDocument({id: sourceID, notebookID: target.notebookID, title: "Rich Title Ref E2E"});
    await openWorkspace(page, `/?id=${sourceID}`);
    const editor = await getDocumentEditor(page, sourceID);
    await pasteParagraphIntoTitle(editor.locator('[data-type="NodeParagraph"] > [contenteditable]').first(),
        getTitle(page, sourceID), true);
    await expect.poll(async () => (await readTitle(siyuanAPI, sourceID)).source?.content || "")
        .toContain(target.docID);
    await expect.poll(async () => {
        const rows = await siyuanAPI.post<Array<{block_id: string}>>("/api/query/sql", {
            stmt: `SELECT block_id FROM refs WHERE def_block_id='${target.docID}' AND block_id='${sourceID}'`,
        });
        return rows.length;
    }, {timeout: 30000}).toBe(1);
    const backlinks = await siyuanAPI.post<{backlinks: unknown[]}>("/api/ref/getBacklink2", {
        id: target.docID, notebook: target.notebookID, k: "", mk: "", includeMentions: false,
    });
    expect(JSON.stringify(backlinks.backlinks)).toContain(sourceID);
    await openWorkspace(page, `/?id=${target.docID}`);
    await getDocumentEditor(page, target.docID);
    const renamed = `${target.title} renamed`;
    await getTitle(page, target.docID).fill(renamed);
    await getTitle(page, target.docID).press("Tab");
    await expect.poll(async () => (await readTitle(siyuanAPI, sourceID)).text, {timeout: 30000}).toBe(renamed);
    await openWorkspace(page, `/?id=${sourceID}`);
    await getDocumentEditor(page, sourceID);
    await expect(getTitle(page, sourceID).locator(`[data-type~="block-ref"][data-id="${target.docID}"]`))
        .toHaveText(renamed);
});

test("outline document title renders rich inline content and refreshes style-only edits", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const document = await createTestDocument("Rich Title Outline E2E",
        "**Bold** *Italic* ~~Strike~~ ==Mark== `Code` [Link](https://example.com) $x^2$ #Tag#\n\n## Child heading");
    const title = getTitle(page, document.docID);
    await pasteParagraphIntoTitle(document.editor.locator('[data-type="NodeParagraph"] > [contenteditable]').first(), title);
    await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).source !== null).toBe(true);
    const restoreDock = await showDock(page);
    const dockItem = page.locator('.dock__item[data-type="outline"]').first();
    const panel = page.locator(".sy__outline:visible").last();
    const originallyVisible = await panel.locator(".block__logo").isVisible();
    const previousDock = await dockItem.locator("xpath=parent::*").evaluate(element =>
        element.querySelector(".dock__item--activefocus")?.getAttribute("data-type"));
    try {
        if (!originallyVisible) {
            await dockItem.click();
            if (!await panel.locator(".block__logo").isVisible()) await dockItem.click();
        }
        const label = panel.locator(":scope > .b3-list-item > .b3-list-item__text");
        await expect(label.locator('[data-type~="strong"]')).toHaveText("Bold");
        await expect(label.locator('[data-type="inline-math"] .katex')).toBeVisible();
        for (const type of ["em", "s", "mark", "code", "a", "tag"]) {
            await expect(label.locator(`[data-type~="${type}"]`)).toHaveCount(1);
        }
        await expect(panel.locator(":scope > .b3-list-item > .counter")).toHaveText("1");
        const before = await readTitle(siyuanAPI, document.docID);
        await title.focus();
        await title.locator('[data-type~="strong"]').evaluate(element => {
            const range = window.document.createRange();
            range.selectNodeContents(element);
            getSelection()!.removeAllRanges();
            getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+i");
        await title.press("Tab");
        await expect.poll(async () => (await readTitle(siyuanAPI, document.docID)).revision).not.toBe(before.revision);
        expect((await readTitle(siyuanAPI, document.docID)).text).toBe(before.text);
        await expect(label.locator('[data-type~="strong"][data-type~="em"]')).toHaveText("Bold");
        await label.click();
        await expect(title).toBeVisible();
    } finally {
        if (!originallyVisible && await panel.locator(".block__logo").isVisible()) {
            await dockItem.click();
            if (previousDock && previousDock !== "outline") {
                await dockItem.locator("xpath=parent::*").locator(`.dock__item[data-type="${previousDock}"]`).click();
            }
        }
        await restoreDock();
    }
});
