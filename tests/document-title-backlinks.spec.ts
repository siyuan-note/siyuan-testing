import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {getDocumentEditor, ITestDocument} from "./helpers/testNotebook";
import {openWorkspace, showDock} from "./helpers/runtime";
import {getTitle, pasteParagraphIntoTitle, readTitle} from "./helpers/richTitle";
import {REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {SiyuanAPI} from "./helpers/siyuanAPI";

const expectBacklinkCount = async (api: SiyuanAPI, id: string, count: number) => {
    await expect.poll(async () => (await api.getBacklinks(id)).linkRefsCount, {timeout: 30000}).toBe(count);
};

const openBacklinkDock = async (page: Page) => {
    const restoreVisibility = await showDock(page);
    const item = page.locator('.dock__item[data-type="backlink"]').first();
    const panel = page.locator(".sy__backlink:not(.sy__backlink--bottom):visible").last();
    const logo = panel.locator('.block__logo[data-type="backlink"]');
    const wasVisible = await logo.isVisible();
    const previous = await item.locator("xpath=parent::*").evaluate(element =>
        element.querySelector(".dock__item--activefocus")?.getAttribute("data-type"));
    if (!wasVisible) {
        await item.click();
        if (!await logo.isVisible()) await item.click();
    }
    await expect(logo).toBeVisible();
    return {panel, restore: async () => {
        if (!wasVisible && await logo.isVisible()) {
            await item.click();
            if (previous && previous !== "backlink") {
                await item.locator("xpath=parent::*").locator(`.dock__item[data-type="${previous}"]`).click();
            }
        }
        await restoreVisibility();
    }};
};

const expandSource = async (panel: Locator, id: string, referenceID: string) => {
    const row = panel.locator(`.backlinkList li[data-treetype="backlink"][data-node-id="${id}"]`);
    await expect(row).toBeVisible({timeout: 15000});
    const preview = panel.locator(`.protyle-wysiwyg [data-node-id="${referenceID}"]`);
    if (!await preview.isVisible()) await row.click();
    await expect(preview).toBeVisible({timeout: 15000});
    return {row, preview};
};

test("title backlinks deduplicate root references, retain body sources, and open the complete title from the preview", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const target = await createTestDocument("Title Backlink Preview Target E2E", "Target body");
    const source = await createTestDocument("Title Backlink Preview Source E2E",
        `**Root source** ((${target.docID} "First anchor")) / ((${target.docID} "Second anchor"))`);
    const paragraph = source.editor.locator(':scope > [data-type="NodeParagraph"]');
    const paragraphID = await paragraph.getAttribute("data-node-id");
    await pasteParagraphIntoTitle(paragraph.locator(':scope > [contenteditable="true"]'), getTitle(page, source.docID));
    await expectBacklinkCount(siyuanAPI, target.docID, 2);
    const saved = await readTitle(siyuanAPI, source.docID);
    const backlinks = await siyuanAPI.getBacklinks(target.docID);
    expect(backlinks.backlinks).toHaveLength(1);
    expect(backlinks.backlinks[0]).toMatchObject({id: source.docID, count: 2});
    await openWorkspace(page, `/?id=${target.docID}`);
    await getDocumentEditor(page, target.docID);
    const dock = await openBacklinkDock(page);
    try {
        const {row, preview} = await expandSource(dock.panel, source.docID, source.docID);
        await expect(dock.panel.locator('.block__logo[data-type="backlink"] .listCount')).toHaveText("2");
        await expect(preview).toHaveAttribute("data-document-title", "true");
        await expect(preview.locator('[data-type~="strong"]')).toHaveText("Root source");
        await expect(preview.locator('[data-type~="block-ref"]')).toHaveCount(2);
        await expect(preview.locator('[contenteditable="true"]')).toHaveCount(0);
        await expect(dock.panel.locator(`.protyle-wysiwyg [data-node-id="${paragraphID}"]`)).toBeVisible();
        await preview.locator('[data-type~="strong"]').click();
        const dialog = page.locator('[data-key="dialog-rename"]');
        await expect(dialog.locator('[role="dialog"]')).toBeVisible();
        await expect(dialog.locator(`.protyle-title[data-node-id="${source.docID}"]`)).toBeVisible();
        await expect(getTitle(page, source.docID).locator('[data-type~="block-ref"]')).toHaveCount(2);
        await dialog.locator('[data-type="confirm"]').click();
        await expect(dialog).toHaveCount(0);
        expect((await readTitle(siyuanAPI, source.docID)).source).toEqual(saved.source);
        await row.click({modifiers: ["ControlOrMeta"]});
        await getDocumentEditor(page, source.docID);
        await expect(getTitle(page, source.docID)).toContainText("Root source");
    } finally {
        await dock.restore();
    }
});

test("removing a title-only reference removes its backlink and undo and redo restore the exact relationship", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const target = await createTestDocument("Title Backlink Undo Target E2E", "Target body");
    const source = await createTestDocument("Title Backlink Undo Source E2E", `((${target.docID} "Saved anchor"))`);
    const paragraph = source.editor.locator(':scope > [data-type="NodeParagraph"]');
    const paragraphID = await paragraph.getAttribute("data-node-id");
    await pasteParagraphIntoTitle(paragraph.locator(':scope > [contenteditable="true"]'), getTitle(page, source.docID));
    await siyuanAPI.updateBlock(paragraphID!, "Body without a reference");
    await expectBacklinkCount(siyuanAPI, target.docID, 1);
    const saved = (await readTitle(siyuanAPI, source.docID)).source;
    const title = getTitle(page, source.docID);
    await title.fill("Title without a reference");
    await title.press("Tab");
    await expectBacklinkCount(siyuanAPI, target.docID, 0);
    await title.focus();
    await title.press(UNDO_SHORTCUT);
    await expectBacklinkCount(siyuanAPI, target.docID, 1);
    expect((await readTitle(siyuanAPI, source.docID)).source).toEqual(saved);
    await title.press(REDO_SHORTCUT);
    await expectBacklinkCount(siyuanAPI, target.docID, 0);
    await page.reload();
    await getDocumentEditor(page, source.docID);
    await expect(getTitle(page, source.docID).locator('[data-type~="block-ref"]')).toHaveCount(0);
    await openWorkspace(page, `/?id=${target.docID}`);
    await getDocumentEditor(page, target.docID);
    const dock = await openBacklinkDock(page);
    try {
        await expect(dock.panel.locator(`.backlinkList li[data-node-id="${source.docID}"]`)).toHaveCount(0);
    } finally {
        await dock.restore();
    }
});

test("heading conversions preserve incoming references and relocate outgoing backlink ownership and previews", async ({
    page, createTestDocument, siyuanAPI, trackTestDocument,
}) => {
    const target = await createTestDocument("Title Conversion Reference Target E2E", "Target body");
    const parent = await createTestDocument("Title Conversion Reference Parent E2E",
        `## Converted source ((${target.docID} "Outgoing anchor"))\n\nMoved body\n\n## Stop\n\nRemaining body`);
    const heading = parent.editor.locator(':scope > [data-type="NodeHeading"]').first();
    const headingID = (await heading.getAttribute("data-node-id"))!;
    const stopID = await parent.editor.locator(':scope > [data-type="NodeHeading"]').last().getAttribute("data-node-id");
    const watcher = await createTestDocument("Title Conversion Reference Watcher E2E", `((${headingID} 'Incoming anchor'))`);
    const watcherBlockID = await watcher.editor.locator(':scope > [data-type="NodeParagraph"]').getAttribute("data-node-id");
    const expectOwner = async (rootID: string) => {
        await expect.poll(() => siyuanAPI.querySQL(
            `SELECT block_id,root_id FROM refs WHERE def_block_id='${target.docID}' AND block_id='${headingID}'`,
        ), {timeout: 30000}).toEqual([{block_id: headingID, root_id: rootID}]);
        await expect.poll(() => siyuanAPI.querySQL(
            `SELECT block_id,root_id FROM refs WHERE def_block_id='${headingID}'`,
        ), {timeout: 30000}).toEqual([{block_id: watcherBlockID, root_id: watcher.docID}]);
    };
    await expectOwner(parent.docID);
    await siyuanAPI.post("/api/filetree/heading2Doc", {
        srcHeadingID: headingID, targetNoteBook: parent.notebookID, targetPath: "/",
    });
    trackTestDocument({id: headingID, notebookID: parent.notebookID, title: "Converted source"});
    await expectOwner(headingID);
    await openWorkspace(page, `/?id=${target.docID}`);
    await getDocumentEditor(page, target.docID);
    const dock = await openBacklinkDock(page);
    try {
        const {preview} = await expandSource(dock.panel, headingID, headingID);
        await expect(preview).toHaveAttribute("data-document-title", "true");
        await expect(preview).toContainText("Converted source");
        await siyuanAPI.post("/api/filetree/doc2Heading", {srcID: headingID, targetID: stopID, after: false});
        await expectOwner(parent.docID);
        await openWorkspace(page, `/?id=${target.docID}`);
        await getDocumentEditor(page, target.docID);
        const restored = await expandSource(dock.panel, parent.docID, headingID);
        await expect(restored.preview).toHaveAttribute("data-type", "NodeHeading");
        await expect(restored.preview).toContainText("Converted source");
        await openWorkspace(page, `/?id=${watcher.docID}`);
        const editor = await getDocumentEditor(page, watcher.docID);
        await editor.locator(`[data-type~="block-ref"][data-id="${headingID}"]`).click();
        const restoredEditor = await getDocumentEditor(page, parent.docID);
        await expect(restoredEditor.locator(`[data-node-id="${headingID}"][data-type="NodeHeading"]`)).toBeVisible();
    } finally {
        await dock.restore();
    }
});

test("title-to-title dependencies update dynamic body anchors while static anchors stay unchanged", async ({
    page, createTestDocument, siyuanAPI,
}) => {
    const base = await createTestDocument("Title Dependency Base E2E", "Base body");
    const middle = await createTestDocument("Title Dependency Middle E2E", `Middle ((${base.docID} '${base.title}'))`);
    await pasteParagraphIntoTitle(middle.editor.locator(':scope > [data-type="NodeParagraph"] > [contenteditable="true"]'),
        getTitle(page, middle.docID), true);
    const source = await createTestDocument("Title Dependency Body E2E",
        `((${middle.docID} 'Dynamic anchor')) / ((${middle.docID} "Static anchor"))`);
    await openWorkspace(page, `/?id=${base.docID}`);
    await getDocumentEditor(page, base.docID);
    await getTitle(page, base.docID).fill("Renamed base");
    await getTitle(page, base.docID).press("Tab");
    await expect.poll(async () => (await readTitle(siyuanAPI, middle.docID)).text, {timeout: 30000})
        .toBe("Middle Renamed base");
    await openWorkspace(page, `/?id=${source.docID}`);
    const editor = await getDocumentEditor(page, source.docID);
    await expect(editor.locator('[data-type~="block-ref"][data-subtype="d"]')).toHaveText("Middle Renamed base");
    await expect(editor.locator('[data-type~="block-ref"][data-subtype="s"]')).toHaveText("Static anchor");
});

for (const size of [1, 2, 3]) {
    test(`${size}-node dynamic title cycles converge and stay bounded across reloads`, async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const documents: ITestDocument[] = [];
        for (let index = 0; index < size; index++) {
            documents.push(await createTestDocument(`Title Cycle ${size} Node ${index} E2E`, `Body ${index}`));
        }
        for (let index = 0; index < size; index++) {
            const document = documents[index];
            const target = documents[(index + 1) % size];
            const label = String.fromCharCode(65 + index);
            await openWorkspace(page, `/?id=${document.docID}`);
            let editor = await getDocumentEditor(page, document.docID);
            const paragraphID = await editor.locator(':scope > [data-type="NodeParagraph"]').getAttribute("data-node-id");
            await siyuanAPI.updateBlock(paragraphID!, `${label} ((${target.docID} 'Cached anchor'))`);
            await page.reload();
            editor = await getDocumentEditor(page, document.docID);
            await pasteParagraphIntoTitle(editor.locator(':scope > [data-type="NodeParagraph"] > [contenteditable="true"]'),
                getTitle(page, document.docID), true);
            await expect.poll(async () => {
                const source = (await readTitle(siyuanAPI, document.docID)).source;
                const nodes = source ? JSON.parse(source.content) as Array<{
                    Data?: string; TextMarkBlockRefID?: string; TextMarkBlockRefSubtype?: string;
                }> : [];
                return {
                    prefix: nodes.some(node => node.Data === `${label} `),
                    dynamicReference: nodes.some(node => node.TextMarkBlockRefID === target.docID
                        && node.TextMarkBlockRefSubtype === "d"),
                };
            }, {timeout: 15000, message: `waiting for node ${label}'s pasted title before changing its body`})
                .toEqual({prefix: true, dynamicReference: true});
            await siyuanAPI.updateBlock(paragraphID!, `Body ${index}`);
        }
        // Inside a cycle, each reference uses its target's own local text,
        // rather than recursively expanding the rest of the component.
        const expected = documents.map((_document, index) =>
            `${String.fromCharCode(65 + index)} ${String.fromCharCode(65 + (index + 1) % size)}`);
        await expect.poll(async () => Promise.all(documents.map(async document =>
            (await readTitle(siyuanAPI, document.docID)).text)), {timeout: 30000}).toEqual(expected);
        const saved = await Promise.all(documents.map(document => readTitle(siyuanAPI, document.docID)));
        for (let index = 0; index < size; index++) {
            await openWorkspace(page, `/?id=${documents[index].docID}`);
            await getDocumentEditor(page, documents[index].docID);
            await page.reload();
            await getDocumentEditor(page, documents[index].docID);
            await expect(getTitle(page, documents[index].docID)).toHaveText(expected[index]);
            await siyuanAPI.flushTransactions();
            const current = await Promise.all(documents.map(document => readTitle(siyuanAPI, document.docID)));
            expect(current.map(title => title.text)).toEqual(expected);
            expect(current.map(title => title.revision)).toEqual(saved.map(title => title.revision));
        }
    });
}
