import {Locator} from "@playwright/test";
import {expect, test} from "./fixtures";
import {commandPanel, focusCommandTarget, openCommandPanel, runPaletteCommand} from "./helpers/commandPanel";
import {assertValidListDOM, assertValidSyListTree} from "./helpers/listAssertions";
import {getTextRangeState} from "./helpers/selection";
import {openWorkspace, showFileTree} from "./helpers/runtime";
import {SiyuanAPI} from "./helpers/siyuanAPI";
import {getDocumentEditor, TEMP_TEST_NOTEBOOK_PREFIX} from "./helpers/testNotebook";
import {UNDO_SHORTCUT} from "./helpers/keyboard";

interface ISyNode {
    ID?: string;
    Type: string;
    Data?: string;
    HeadingLevel?: number;
    ListData?: {Typ?: number};
    Properties?: Record<string, string>;
    Children?: ISyNode[];
}

const flatten = (node: ISyNode): ISyNode[] => [node, ...(node.Children || []).flatMap(flatten)];
const text = (node: ISyNode): string => (node.Data || "") + (node.Children || []).map(text).join("");
const persisted = async (api: SiyuanAPI, docID: string, editor: Locator) => {
    await assertValidListDOM(editor);
    await assertValidSyListTree(api, docID, editor);
    return api.readDocument<ISyNode>(docID);
};

test.describe("command palette", () => {
    test("loads contextual commands without adding shortcuts or an export submenu", async ({page, createTestDocument}) => {
        await createTestDocument("Command Palette Registry E2E", "Command palette registry context");
        const keymap = await page.evaluate(() => JSON.stringify(window.siyuan.config.keymap));
        const panel = await openCommandPanel(page);
        await expect(panel.locator('[data-command-id="core.context.notebook.new"]'),
            "The served desktop bundle must include the contextual command changes").toBeVisible();
        await expect(panel.locator('[data-command-id="core.context.document.export"]')).toHaveCount(0);
        await expect(panel.locator('[data-command-id="core.context.notebook.new"] .b3-list-item__meta')).toHaveText("");
        await panel.locator("input").fill("unmatched-command-19047-xyz");
        await expect(panel.locator("[data-command-id]")).toHaveCount(0);
        await panel.locator("input").press("Escape");
        await expect(panel).toHaveCount(0);
        expect(await page.evaluate(() => JSON.stringify(window.siyuan.config.keymap))).toBe(keymap);
    });

    test("Escape restores the original caret and does not change the document", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("Command Palette Cancel", "First guard\n\nSecond target");
        await focusCommandTarget(editor.locator('[data-type="NodeParagraph"]').nth(1));
        const before = await getTextRangeState(editor);
        const original = await siyuanAPI.readDocument<ISyNode>(docID);
        const panel = await openCommandPanel(page);
        await panel.locator("input").fill("heading");
        await panel.locator("input").press("Escape");
        await expect(panel).toHaveCount(0);
        expect(await getTextRangeState(editor)).toEqual(before);
        expect(await siyuanAPI.readDocument<ISyNode>(docID)).toEqual(original);
    });

    const conversions = [
        {key: "list", type: "NodeList", subtype: "u", listType: 0},
        {key: "ordered-list", type: "NodeList", subtype: "o", listType: 1},
        {key: "check", type: "NodeList", subtype: "t", listType: 3},
        {key: "quote", type: "NodeBlockquote"},
        {key: "paragraph", type: "NodeParagraph", markdown: "# Target content"},
        ...[1, 2, 3, 4, 5, 6].map(level => ({key: `heading${level}`, type: "NodeHeading", level})),
        {key: "code", type: "NodeCodeBlock"},
    ];
    for (const conversion of conversions) {
        test(`converts the captured block to ${conversion.key} and persists it`, async ({page, createTestDocument, siyuanAPI}) => {
            const {docID, editor} = await createTestDocument(`Command Palette ${conversion.key}`,
                `Guard paragraph\n\n${"markdown" in conversion ? conversion.markdown : "Target content"}`);
            const target = editor.locator(":scope > [data-node-id]").nth(1);
            const guardID = await editor.locator(":scope > [data-node-id]").first().getAttribute("data-node-id");
            await focusCommandTarget(target);
            await runPaletteCommand(page, `core.context.block.${conversion.key}`, conversion.key === "quote" ? "click" : "enter");
            const converted = editor.locator(":scope > [data-node-id]").nth(1);
            await expect(converted).toHaveAttribute("data-type", conversion.type);
            await expect(converted).toContainText("Target content");
            if ("subtype" in conversion) {
                await expect(converted).toHaveAttribute("data-subtype", conversion.subtype!);
            }
            await expect(editor.locator(`[data-node-id="${guardID}"]`)).toHaveAttribute("data-type", "NodeParagraph");
            const root = await persisted(siyuanAPI, docID, editor);
            const result = root.Children!.filter(node => node.ID)[1];
            expect(result.Type).toBe(conversion.type);
            if ("level" in conversion) {
                expect(result.HeadingLevel).toBe(conversion.level);
            }
            if ("listType" in conversion) {
                // 无序列表的 Typ 为零，持久化格式会省略该字段。
                expect(result.ListData?.Typ ?? 0).toBe(conversion.listType);
            }
            expect(text(result)).toContain("Target content");
            await page.reload();
            const reloaded = await getDocumentEditor(page, docID);
            await expect(reloaded.locator(":scope > [data-node-id]").nth(1)).toHaveAttribute("data-type", conversion.type);
        });
    }

    test("converts a multi-block selection without including the guard block", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("Command Palette Selection", "First selected\n\nSecond selected\n\nGuard");
        const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
        await paragraphs.nth(0).locator('[contenteditable="true"]').click();
        await paragraphs.nth(1).click({modifiers: ["Shift"]});
        await expect(editor.locator(".protyle-wysiwyg--select")).toHaveCount(2);
        await runPaletteCommand(page, "core.context.block.ordered-list");
        await expect(editor.locator(':scope > [data-type="NodeList"] > [data-type="NodeListItem"]')).toHaveCount(2);
        await expect(editor.locator(':scope > [data-type="NodeParagraph"]')).toHaveText(/Guard/);
        const root = await persisted(siyuanAPI, docID, editor);
        expect(root.Children!.filter(node => node.ID).map(node => node.Type)).toEqual(["NodeList", "NodeParagraph"]);
    });

    const tableMarkdown = "| A1 | B1 | C1 |\n| --- | --- | --- |\n| A2 | B2 | C2 |\n| A3 | B3 | C3 |";
    const initial = [["A1", "B1", "C1"], ["A2", "B2", "C2"], ["A3", "B3", "C3"]];
    const tableCases: Array<{key: string; expected: string[][]}> = [
        {key: "insertRowAbove", expected: [initial[0], ["", "", ""], initial[1], initial[2]]},
        {key: "insertRowBelow", expected: [initial[0], initial[1], ["", "", ""], initial[2]]},
        {key: "insertColumnLeft", expected: initial.map(row => [row[0], "", row[1], row[2]])},
        {key: "insertColumnRight", expected: initial.map(row => [row[0], row[1], "", row[2]])},
        {key: "moveToUp", expected: [initial[1], initial[0], initial[2]]},
        {key: "moveToDown", expected: [initial[0], initial[2], initial[1]]},
        {key: "moveToLeft", expected: initial.map(row => [row[1], row[0], row[2]])},
        {key: "moveToRight", expected: initial.map(row => [row[0], row[2], row[1]])},
        {key: "delete-row", expected: [initial[0], initial[2]]},
        {key: "delete-column", expected: initial.map(row => [row[0], row[2]])},
    ];
    for (const operation of tableCases) {
        test(`table ${operation.key} uses the original cell and saves the exact result`, async ({page, createTestDocument, siyuanAPI}) => {
            const {docID, editor} = await createTestDocument(`Command Palette Table ${operation.key}`, tableMarkdown);
            const table = editor.locator('[data-type="NodeTable"] table');
            await focusCommandTarget(table.locator("tr").nth(1).locator("td").nth(1));
            await runPaletteCommand(page, `core.context.table.${operation.key}`);
            await expect.poll(() => table.locator("tr").evaluateAll(rows => rows.map(row =>
                Array.from(row.querySelectorAll("th, td")).map(cell =>
                    ((cell.querySelector(".table__cell-editor .protyle-wysiwyg") || cell).textContent || "")
                        .replace(/\u200b/g, "").trim()))))
                .toEqual(operation.expected);
            await persisted(siyuanAPI, docID, editor);
            await expect.poll(async () => {
                const root = await siyuanAPI.readDocument<ISyNode>(docID);
                return flatten(root).filter(node => node.Type === "NodeTableRow").map(row =>
                    (row.Children || []).filter(node => node.Type === "NodeTableCell")
                        .map(cell => (cell.Children || []).filter(node => node.Type !== "NodeKramdownSpanIAL").map(text).join("")));
            }, {timeout: 30000}).toEqual(operation.expected);
        });
    }

    test("hides table commands outside tables and unavailable directions at boundaries", async ({page, createTestDocument}) => {
        const {editor} = await createTestDocument("Command Palette Table Context", `Guard\n\n${tableMarkdown}`);
        await focusCommandTarget(editor.locator(':scope > [data-type="NodeParagraph"]').first());
        let panel = await openCommandPanel(page);
        await expect(panel.locator('[data-command-id^="core.context.table."]')).toHaveCount(0);
        await panel.locator("input").press("Escape");
        await expect(panel).toHaveCount(0);
        await focusCommandTarget(editor.locator("table th").first());
        panel = await openCommandPanel(page);
        await expect(panel.locator('[data-command-id="core.context.table.moveToUp"]')).toHaveCount(0);
        await expect(panel.locator('[data-command-id="core.context.table.moveToLeft"]')).toHaveCount(0);
        await expect(panel.locator('[data-command-id="core.context.table.insertRowBelow"]')).toBeVisible();
        await panel.locator("input").press("Escape");
        await expect(panel).toHaveCount(0);
    });

    test("hides all fold commands when multiple blocks are selected", async ({page, createTestDocument}) => {
        const {editor} = await createTestDocument("Command Palette Multi Block Fold", "# First heading\n\n# Second heading\n\nGuard");
        const headings = editor.locator('[data-type="NodeHeading"]');
        await headings.nth(0).locator('[contenteditable="true"]').click();
        await headings.nth(1).click({modifiers: ["Shift"]});
        await expect(editor.locator(".protyle-wysiwyg--select")).toHaveCount(2);
        const panel = await openCommandPanel(page);
        await panel.locator("input").fill("core.context.block");
        await expect(panel.locator('[data-command-id="core.context.block.delete"]')).toHaveCount(1);
        for (const key of ["fold", "foldChildHeadings", "foldSiblingHeadings", "foldRecursive"]) {
            await expect(panel.locator(`[data-command-id="core.context.block.${key}"]`)).toHaveCount(0);
        }
        await panel.locator("input").press("Escape");
        await expect(panel).toHaveCount(0);
        await headings.first().locator('[contenteditable="true"]').click();
        await expect(editor.locator(".protyle-wysiwyg--select")).toHaveCount(0);
        await focusCommandTarget(headings.first());
        const singlePanel = await openCommandPanel(page);
        await singlePanel.locator("input").fill("core.context.block.fold");
        for (const key of ["fold", "foldChildHeadings", "foldSiblingHeadings", "foldRecursive"]) {
            await expect(singlePanel.locator(`[data-command-id="core.context.block.${key}"]`)).toHaveCount(1);
        }
        await singlePanel.locator("input").press("Escape");
        await expect(singlePanel).toHaveCount(0);
    });

    test("toggles the captured heading with one fold command", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("Command Palette Fold", "# Target heading\n\nHidden content\n\n# Guard heading\n\nGuard content");
        const heading = editor.locator('[data-type="NodeHeading"]').first();
        const id = await heading.getAttribute("data-node-id");
        await focusCommandTarget(heading);
        const panel = await openCommandPanel(page);
        await panel.locator("input").fill("core.context.block");
        await expect(panel.locator('[data-command-id="core.context.block.fold"]')).toHaveCount(1);
        await expect(panel.locator('[data-command-id="core.context.block.collapse"], [data-command-id="core.context.block.expand"]')).toHaveCount(0);
        await panel.locator("input").press("Escape");
        await expect(panel).toHaveCount(0);
        await runPaletteCommand(page, "core.context.block.fold");
        await expect(heading).toHaveAttribute("fold", "1");
        await expect.poll(async () => (await siyuanAPI.getBlockAttrs(id!)).fold).toBe("1");
        await focusCommandTarget(heading);
        await runPaletteCommand(page, "core.context.block.fold");
        await expect(heading).not.toHaveAttribute("fold", "1");
        await expect.poll(async () => (await siyuanAPI.getBlockAttrs(id!)).fold).not.toBe("1");
        await expect(editor).toContainText("Hidden content");
        await persisted(siyuanAPI, docID, editor);
    });

    for (const key of ["foldChildHeadings", "foldSiblingHeadings", "foldRecursive"]) {
        test(`${key} folds the intended heading group without changing the next section`, async ({page, createTestDocument, siyuanAPI}) => {
            const {docID, editor} = await createTestDocument(`Command Palette ${key}`,
                "# Root\n\nRoot content\n\n## Child A\n\nChild A content\n\n## Child B\n\nChild B content\n\n# Guard\n\nGuard content");
            const headings = editor.locator('[data-type="NodeHeading"]');
            const ids = await headings.evaluateAll(elements => elements.map(element => element.getAttribute("data-node-id")!));
            await focusCommandTarget(headings.nth(key === "foldSiblingHeadings" ? 1 : 0));
            await runPaletteCommand(page, `core.context.block.${key}`);
            const expected = key === "foldRecursive" ? ids.slice(0, 3) : ids.slice(1, 3);
            for (const id of expected) {
                await expect.poll(async () => (await siyuanAPI.getBlockAttrs(id)).fold, {timeout: 30000}).toBe("1");
            }
            await expect(editor.locator(`[data-node-id="${key === "foldRecursive" ? ids[0] : ids[1]}"]`))
                .toHaveAttribute("fold", "1");
            await expect(editor.locator(`[data-node-id="${ids[3]}"]`)).not.toHaveAttribute("fold", "1");
            await expect(editor).toContainText("Guard content");
            await assertValidListDOM(editor);
            await assertValidSyListTree(siyuanAPI, docID);
            await expect.poll(async () => {
                const nodes = flatten(await siyuanAPI.readDocument<ISyNode>(docID));
                return expected.map(id => nodes.find(node => node.ID === id)?.Properties?.fold);
            }, {timeout: 30000}).toEqual(expected.map(() => "1"));
        });
    }

    for (const key of ["pasteAsPlainText", "pasteEscaped"]) {
        test(`${key} inserts at the original caret`, async ({page, context, baseURL, createTestDocument, siyuanAPI}) => {
            await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin: new URL(baseURL!).origin});
            const {docID, editor} = await createTestDocument(`Command Palette ${key}`, "Guard\n\nTarget: ");
            const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
            await page.evaluate(() => navigator.clipboard.writeText("**literal** [link](https://example.com)"));
            await focusCommandTarget(paragraphs.nth(1));
            await runPaletteCommand(page, `core.context.editor.${key}`);
            await expect(paragraphs.first()).toHaveText(/Guard/);
            // 纯文本粘贴仍解析 Markdown；转义文本粘贴才原样保留 Markdown 符号。
            if (key === "pasteEscaped") {
                await expect(paragraphs.nth(1)).toContainText("**literal** [link](https://example.com)");
                await expect(paragraphs.nth(1).locator('[data-type="strong"], [data-type="a"]')).toHaveCount(0);
            } else {
                await expect(paragraphs.nth(1)).toContainText("Target:literal link");
                await expect(paragraphs.nth(1).locator('[data-type="strong"], [data-type="a"]')).toHaveCount(0);
            }
            const root = await persisted(siyuanAPI, docID, editor);
            expect(text(root)).toContain("literal");
            expect(text(root.Children!.filter(node => node.ID)[0])).toBe("Guard");
        });
    }

    test("deletes only the current block and supports undo", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("Command Palette Delete Block", "Guard before\n\nDelete target\n\nGuard after");
        const target = editor.locator(':scope > [data-type="NodeParagraph"]').nth(1);
        const id = await target.getAttribute("data-node-id");
        await focusCommandTarget(target);
        await runPaletteCommand(page, "core.context.block.delete");
        await expect(editor.locator(`[data-node-id="${id}"]`)).toHaveCount(0);
        await expect(editor).toContainText("Guard before");
        await expect(editor).toContainText("Guard after");
        const root = await persisted(siyuanAPI, docID, editor);
        expect(flatten(root).some(node => node.ID === id)).toBe(false);
        await focusCommandTarget(editor.locator('[data-type="NodeParagraph"]').first());
        await page.keyboard.press(UNDO_SHORTCUT);
        await expect(editor.locator(`[data-node-id="${id}"]`)).toContainText("Delete target");
        await persisted(siyuanAPI, docID, editor);
    });

    test("deletes the captured block selection and preserves the unselected block", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("Command Palette Delete Selection", "Delete first\n\nDelete second\n\nGuard");
        const paragraphs = editor.locator(':scope > [data-type="NodeParagraph"]');
        await paragraphs.nth(0).locator('[contenteditable="true"]').click();
        await paragraphs.nth(1).click({modifiers: ["Shift"]});
        await expect(editor.locator(".protyle-wysiwyg--select")).toHaveCount(2);
        await openCommandPanel(page);
        await commandPanel(page).locator("input").fill("core.context");
        await expect(commandPanel(page).locator('[data-command-id="core.context.block.delete"]')).toHaveCount(1);
        await expect(commandPanel(page).locator('[data-command-id="core.context.block.deleteSelection"], [data-command-id="core.context.listItem.delete"]')).toHaveCount(0);
        await commandPanel(page).locator("input").press("Escape");
        await runPaletteCommand(page, "core.context.block.delete");
        await expect(paragraphs).toHaveCount(1);
        await expect(paragraphs).toHaveText(/Guard/);
        const root = await persisted(siyuanAPI, docID, editor);
        expect(text(root)).not.toContain("Delete first");
        expect(text(root)).not.toContain("Delete second");
    });

    test("deletes the current paragraph in a list without deleting nested items or siblings", async ({page, createTestDocument, siyuanAPI}) => {
        const {docID, editor} = await createTestDocument("Command Palette Delete Item", "- Keep first\n- Delete item\n  - Delete child\n- Keep last");
        const item = editor.locator(':scope > [data-type="NodeList"] > [data-type="NodeListItem"]').nth(1);
        await focusCommandTarget(item.locator(':scope > [data-type="NodeParagraph"]'));
        await runPaletteCommand(page, "core.context.block.delete");
        await expect(editor).not.toContainText("Delete item");
        await expect(editor).toContainText("Delete child");
        await expect(editor).toContainText("Keep first");
        await expect(editor).toContainText("Keep last");
        const root = await persisted(siyuanAPI, docID, editor);
        expect(text(root)).not.toContain("Delete item");
        expect(text(root)).toContain("Delete child");
    });

    test("pins and unpins the active tab without adding shortcut settings", async ({page, createTestDocument}) => {
        const {editor} = await createTestDocument("Command Palette Pin", "Tab target");
        const panelID = await editor.locator("xpath=ancestor::*[@data-id][1]").getAttribute("data-id");
        const tab = page.locator(`.layout-tab-bar [data-id="${panelID}"]`);
        const keymap = await page.evaluate(() => JSON.stringify(window.siyuan.config.keymap));
        await focusCommandTarget(editor.locator('[data-type="NodeParagraph"]'));
        await runPaletteCommand(page, "core.context.tab.pin");
        try {
            await expect(tab).toHaveClass(/item--pin/);
        } finally {
            await runPaletteCommand(page, "core.context.tab.unpin");
        }
        await expect(tab).not.toHaveClass(/item--pin/);
        expect(await page.evaluate(() => JSON.stringify(window.siyuan.config.keymap))).toBe(keymap);
    });

    test("creates a notebook through its existing name dialog", async ({page, siyuanAPI, trackTestNotebook}) => {
        await openWorkspace(page);
        await runPaletteCommand(page, "core.context.notebook.new");
        const dialog = page.locator('[data-key="dialog-createnotebook"]');
        await expect(dialog.locator('[data-type="notebook-name"]')).toBeVisible();
        const name = `${TEMP_TEST_NOTEBOOK_PREFIX} Command Palette ${Date.now()}`;
        await dialog.locator('[data-type="notebook-name"]').fill(name);
        const response = page.waitForResponse(item => new URL(item.url()).pathname === "/api/notebook/createNotebook");
        await dialog.locator('[data-type="confirm"]').click();
        const result = await (await response).json();
        expect(result.code).toBe(0);
        trackTestNotebook({id: result.data.notebook.id, name});
        await expect.poll(async () => (await siyuanAPI.listNotebooks()).some(notebook => notebook.name === name)).toBe(true);
    });

    test("hides mutation commands in a read-only editor and restores them after unlocking", async ({page, createTestDocument}) => {
        const {editor} = await createTestDocument("Command Palette Readonly", "Readonly target");
        await focusCommandTarget(editor.locator('[data-type="NodeParagraph"]'));
        await runPaletteCommand(page, "core.editor.general.switchReadonly");
        try {
            await expect(editor).toHaveAttribute("data-readonly", "true");
            const panel = await openCommandPanel(page);
            await expect(panel.locator('[data-command-id^="core.context.block."]')).toHaveCount(0);
            await expect(panel.locator('[data-command-id^="core.context.editor.paste"]')).toHaveCount(0);
            await expect(panel.locator('[data-command-id="core.context.document.delete"]')).toHaveCount(0);
            await panel.locator("input").press("Escape");
            await expect(panel).toHaveCount(0);
        } finally {
            await runPaletteCommand(page, "core.editor.general.switchReadonly");
        }
        await expect(editor).toHaveAttribute("data-readonly", "false");
        await focusCommandTarget(editor.locator('[data-type="NodeParagraph"]'));
        const panel = await openCommandPanel(page);
        await expect(panel.locator('[data-command-id="core.context.block.delete"]')).toBeVisible();
        await panel.locator("input").press("Escape");
        await expect(panel).toHaveCount(0);
    });

    test("document deletion keeps its confirmation and cancellation behavior", async ({page, createTestDocument, siyuanAPI, globalSettings}) => {
        void globalSettings;
        const original = (await siyuanAPI.getConf()).conf.fileTree;
        try {
            await siyuanAPI.setFileTree({...original, removeDocWithoutConfirm: false});
            const {docID, editor} = await createTestDocument("Command Palette Delete Document", "Delete document target");
            await focusCommandTarget(editor.locator('[data-type="NodeParagraph"]'));
            await runPaletteCommand(page, "core.context.document.delete");
            await expect(page.locator("#confirmDialogConfirmBtn")).toBeVisible();
            await page.locator("#cancelDialogConfirmBtn").click();
            await expect(page.locator("#cancelDialogConfirmBtn")).toHaveCount(0);
            expect(await siyuanAPI.findDocumentPath(docID)).toBeDefined();
            await focusCommandTarget(editor.locator('[data-type="NodeParagraph"]'));
            await runPaletteCommand(page, "core.context.document.delete");
            await page.locator("#confirmDialogConfirmBtn").click();
            await expect.poll(() => siyuanAPI.findDocumentPath(docID), {timeout: 30000}).toBeUndefined();
        } finally {
            await siyuanAPI.setFileTree(original);
        }
    });

    test("referenced block deletion waits for confirmation and preserves content on cancel", async ({page, createTestDocument, siyuanAPI, globalSettings}) => {
        void globalSettings;
        const original = (await siyuanAPI.getConf()).conf.editor;
        try {
            await siyuanAPI.setEditor({...original, checkBlockRef: true});
            const target = await createTestDocument("Command Palette Referenced Target", "Referenced block\n\nGuard");
            const id = await target.editor.locator('[data-type="NodeParagraph"]').first().getAttribute("data-node-id");
            await createTestDocument("Command Palette Reference Source", `((${id} 'Referenced block'))`);
            await expect.poll(() => siyuanAPI.post<boolean>("/api/block/checkBlockRef", {
                scope: "blocks", ids: [id], notebook: target.notebookID,
            }), {timeout: 30000}).toBe(true);
            await openWorkspace(page, `/?id=${target.docID}`);
            const editor = await getDocumentEditor(page, target.docID);
            await focusCommandTarget(editor.locator(`[data-node-id="${id}"]`));
            await runPaletteCommand(page, "core.context.block.delete");
            await expect(page.locator("#confirmDialogConfirmBtn")).toBeVisible();
            await expect(editor.locator(`[data-node-id="${id}"]`)).toContainText("Referenced block");
            await page.locator("#cancelDialogConfirmBtn").click();
            await expect(page.locator("#cancelDialogConfirmBtn")).toHaveCount(0);
            await expect(editor.locator(`[data-node-id="${id}"]`)).toContainText("Referenced block");
            expect(flatten(await persisted(siyuanAPI, target.docID, editor)).some(node => node.ID === id)).toBe(true);
        } finally {
            await siyuanAPI.setEditor(original);
        }
    });

    for (const key of ["newDocAbove", "newDocBelow"]) {
        test(`${key} creates exactly one sibling in the specified position`, async ({page, createTestDocument, siyuanAPI, trackTestDocument}) => {
            const target = await createTestDocument(`Command Palette ${key}`, "Creation anchor");
            const original = (await siyuanAPI.getNotebookConf(target.notebookID)).conf;
            const restoreFileTree = await showFileTree(page);
            const fileTreeFilter = page.locator(".sy__file:visible input.b3-text-field.search__label");
            const originalFilter = await fileTreeFilter.count() > 0 ? await fileTreeFilter.inputValue() : "";
            let collapseNotebook: (() => Promise<void>) | undefined;
            try {
                if (originalFilter) {
                    await fileTreeFilter.fill("");
                }
                await siyuanAPI.setNotebookConf(target.notebookID, {...original, sortMode: 6});
                await page.reload();
                const editor = await getDocumentEditor(page, target.docID);
                const notebookRoot = page.locator(
                    `.sy__file ul.b3-list[data-url="${target.notebookID}"] > li[data-type="navigation-root"]`,
                );
                await expect(notebookRoot).toBeVisible();
                const notebookArrow = notebookRoot.locator(":scope > .b3-list-item__toggle .b3-list-item__arrow");
                const wasExpanded = await notebookArrow.evaluate(element =>
                    element.classList.contains("b3-list-item__arrow--open"));
                if (!wasExpanded) {
                    await notebookRoot.locator(":scope > .b3-list-item__toggle").click();
                    collapseNotebook = async () => {
                        if (await notebookArrow.count() && await notebookArrow.evaluate(element =>
                            element.classList.contains("b3-list-item__arrow--open"))) {
                            await notebookRoot.locator(":scope > .b3-list-item__toggle").click();
                        }
                    };
                }
                await expect(page.locator(`.sy__file li[data-node-id="${target.docID}"]`)).toHaveCount(1);
                const before = (await siyuanAPI.listDocuments(target.notebookID)).map(doc => doc.id);
                await focusCommandTarget(editor.locator('[data-type="NodeParagraph"]'));
                const response = page.waitForResponse(item => new URL(item.url()).pathname === "/api/filetree/createDoc");
                await runPaletteCommand(page, `core.context.document.${key}`);
                const createdResponse = await response;
                const payload = createdResponse.request().postDataJSON() as {path: string; notebook: string};
                const createdID = payload.path.split("/").pop()!.replace(/\.sy$/, "");
                trackTestDocument({id: createdID, notebookID: payload.notebook, title: `Command Palette ${key} generated`});
                expect((await createdResponse.json()).code).toBe(0);
                expect(payload.notebook).toBe(target.notebookID);
                expect(payload.path).toBe(`/${createdID}.sy`);
                const expected = [...before];
                expected.splice(before.indexOf(target.docID) + (key === "newDocBelow" ? 1 : 0), 0, createdID);
                await expect.poll(async () => (await siyuanAPI.listDocuments(target.notebookID)).map(doc => doc.id),
                    {timeout: 30000}).toEqual(expected);
                await expect(page.locator(`.sy__file li[data-node-id="${createdID}"]`)).toHaveCount(1);
            } finally {
                await siyuanAPI.setNotebookConf(target.notebookID, original);
                await collapseNotebook?.();
                if (originalFilter && await fileTreeFilter.count() > 0) {
                    await fileTreeFilter.fill(originalFilter);
                }
                await restoreFileTree();
            }
        });
    }
});
