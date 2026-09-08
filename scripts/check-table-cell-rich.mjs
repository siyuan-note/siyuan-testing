import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
import {chromium, expect} from "@playwright/test";

const app = path.resolve(fileURLToPath(new URL("../../siyuan/app", import.meta.url)));
const appRequire = createRequire(path.join(app, "package.json"));
const {build} = createRequire(appRequire.resolve("esbuild-loader"))("esbuild");
const preprocess = appRequire("ifdef-loader/preprocessor").parse;
// 使用真实转换与事务清理函数检查数据兼容，不启动内核或写入应用构建目录。
const bundle = await build({
    stdin: {
        contents: `export * from "./src/protyle/util/tableCellRich";
export * from "./src/protyle/util/tableCellRichValue";
export {mountProtyleLiteFragment} from "./src/protyle/lite/fragmentEditor";
export {getAVRichTextLute} from "./src/protyle/render/av/richText";
export {renderTableCellRichElements} from "./src/protyle/render/tableCellRich";
export {applyTableCellRichInlineMark} from "./src/protyle/render/tableCellRichEditor";
export {TableControl} from "./src/protyle/util/tableControl";
export {LocalUndo} from "./src/protyle/undo";
export {tableMenu} from "./src/menus/protyle";
export {Constants} from "./src/constants";`,
        resolveDir: app,
    },
    bundle: true, write: false, format: "iife", globalName: "cellTest",
    logLevel: "error", alias: {path: appRequire.resolve("path-browserify")},
    platform: "browser", define: {SIYUAN_VERSION: '"test"', NODE_ENV: '"production"',
        "process.env.NODE_ENV": '"production"'},
    plugins: [{name: "platform", setup(builder) {
        builder.onLoad({filter: /\.ts$/}, async args => ({
            contents: preprocess(await readFile(args.path, "utf8"), {MOBILE: false, BROWSER: true}, false, true)
                .replace(/import \* as dayjs from "dayjs";/g, 'import dayjs from "dayjs";'),
            loader: "ts",
        }));
    }}],
});
const browser = await chromium.launch({channel: "chrome", headless: true});
try {
    const page = await browser.newPage();
    await page.setContent('<style>.fn__none {display:none!important} [contenteditable=true] {white-space:break-spaces} .protyle-wysiwyg {min-height:24px}</style><div id="sidebar"></div><div id="keyboardToolbar"><div class="keyboard__dynamic"></div><div></div></div><div id="host"></div>');
    await page.addStyleTag({content: appRequire("sass").compile(path.join(app, "src/assets/scss/base.scss"),
        {logger: {warn() {}, debug() {}}}).css});
    // 外层样式可能为空段落生成提示文字；单元格编辑器必须覆盖这类伪元素。
    await page.addStyleTag({content: '.protyle-wysiwyg [contenteditable=true]:empty::before {content:"Empty"}'});
    await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "table__cell-editor";
        probe.innerHTML = '<div class="protyle-wysiwyg"><div class="p"><div contenteditable="true"></div></div></div>';
        document.body.appendChild(probe);
        const edit = probe.querySelector("[contenteditable]");
        if (getComputedStyle(edit, "::before").content !== "none" ||
            getComputedStyle(edit, "::after").content !== "none") {
            throw new Error("Empty cell must not inherit placeholder pseudo-elements");
        }
        probe.remove();
    });
    await page.addScriptTag({path: path.join(app, "stage/protyle/js/lute/lute.min.js")});
    await page.addScriptTag({content: bundle.outputFiles[0].text});
    const result = await page.evaluate(() => {
        window.siyuan = {config: {editor: {spellcheck: false, displayNetImgMark: false}}};
        const host = document.getElementById("host");
        host.innerHTML = '<div data-type="NodeTable" data-node-id="20260908000001-table01"><table><tbody><tr><td></td></tr></tbody></table></div>';
        const cell = host.querySelector("td");
        const plain = '**literal** - item `code` &lt;tag&gt;<br><span data-type="strong">bold</span>';
        cell.innerHTML = plain;
        const originalText = cell.textContent;
        const blockDOM = cellTest.getTableCellRichBlockDOM(cell);
        const value = cellTest.serializeTableCellRich(blockDOM);
        cellTest.updateTableCellEditingValue(cell, value);
        cell.innerHTML = '<div class="table__cell-editor"><div data-node-id="temporary">unsaved editor</div></div>';
        const clean = document.createElement("template");
        clean.innerHTML = cellTest.cleanTableCellRichHTML(host.innerHTML);
        const cleanedCell = clean.content.querySelector("td");
        const ordinary = {
            text: cleanedCell.textContent === originalText,
            bold: cleanedCell.querySelector('[data-type~="strong"]')?.textContent === "bold",
            sourceAbsent: !cleanedCell.hasAttribute(cellTest.TABLE_CELL_RICH_ATTRIBUTE),
            noTemporaryDOM: !cleanedCell.querySelector('[data-node-id], .table__cell-editor') &&
                !cleanedCell.hasAttribute(cellTest.TABLE_CELL_INLINE_ATTRIBUTE),
            noUpgrade: !clean.content.querySelector('[custom-sy-table-rich]'),
        };
        const list = Lute.New().Md2BlockDOM("- first\n- second");
        cellTest.updateTableCellEditingValue(cell, cellTest.serializeTableCellRich(list));
        const promoted = cellTest.decodeTableCellRich(cell.getAttribute(cellTest.TABLE_CELL_RICH_ATTRIBUTE));
        const hasMarker = cell.closest('[data-type="NodeTable"]').getAttribute("custom-sy-table-rich") === "1";
        cellTest.updateTableCellEditingValue(cell, value);
        const retained = cell.hasAttribute(cellTest.TABLE_CELL_RICH_ATTRIBUTE);
        cellTest.updateTableCellEditingValue(cell, {blockDOM: "", markdown: ""});
        const empty = cellTest.decodeTableCellRich(cell.getAttribute(cellTest.TABLE_CELL_RICH_ATTRIBUTE)).content === "";
        const literals = ["# heading", "- list", "1. item", "***", "[link](https://example.com)",
            "![image](asset.png)", "((20260908120000-abcdefg 'ref'))", "{: id=\"test\"}",
            "<script>alert(1)</script>", "&amp; &#42;", "C:\\test\\**literal**", "$x$", "==mark==", "~~strike~~",
            "a\n\nb", "  leading and trailing  "];
        const literalRoundTrips = literals.map(literal => {
            const paragraph = document.createElement("div");
            paragraph.setAttribute("data-type", "NodeParagraph");
            const edit = document.createElement("div");
            edit.contentEditable = "true";
            edit.textContent = literal;
            paragraph.appendChild(edit);
            const serialized = cellTest.serializeTableCellRich(paragraph.outerHTML);
            const inline = document.createElement("div");
            inline.innerHTML = cellTest.getTableCellInlineHTML(serialized.blockDOM);
            inline.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
            const rich = document.createElement("div");
            rich.innerHTML = cellTest.serializeTableCellRich(serialized.blockDOM + list).blockDOM;
            const restored = rich.querySelector('[data-type="NodeParagraph"] > [contenteditable="true"]');
            restored?.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
            return {literal, inline: inline.textContent, rich: restored?.textContent};
        });
        const formatted = cellTest.getAVRichTextLute().Md2BlockDOM(
            "**bold** and `code * \\ path`\n\n```text\na * b\nC:\\path\\file\n```\n\n$$\nx^2 + y\n$$");
        const original = document.createElement("div");
        original.innerHTML = formatted;
        cellTest.updateTableCellEditingValue(cell, cellTest.serializeTableCellRich(formatted));
        const restored = document.createElement("div");
        restored.innerHTML = cellTest.getTableCellRichBlockDOM(cell);
        const formats = ['span[data-type="strong"]', 'span[data-type="code"]',
            '[data-type="NodeCodeBlock"] [contenteditable="true"]'].map(selector => ({
            selector, original: original.querySelector(selector).textContent,
            restored: restored.querySelector(selector).textContent,
        }));
        const math = original.querySelector('[data-type="NodeMathBlock"]').getAttribute("data-content") ===
            restored.querySelector('[data-type="NodeMathBlock"]').getAttribute("data-content");
        return {ordinary, list: promoted.content.includes("- first"), hasMarker, retained, empty, literalRoundTrips, formats, math};
    });
    for (const {literal, inline, rich} of result.literalRoundTrips) {
        assert.equal(inline, literal, `inline literal: ${literal}`);
        assert.equal(rich, literal, `rich literal: ${literal}`);
    }
    delete result.literalRoundTrips;
    for (const {selector, original, restored} of result.formats) {
        assert.equal(restored, original, selector);
    }
    delete result.formats;
    assert.deepEqual(result, {
        ordinary: {text: true, bold: true, sourceAbsent: true, noTemporaryDOM: true, noUpgrade: true},
        list: true, hasMarker: true, retained: true, empty: true, math: true,
    });
    console.log("PASS: legacy literals and formatting, inline storage, transaction cleanup, rich promotion and retention");
    const errors = [];
    page.on("pageerror", error => errors.push(error.stack));
    await page.evaluate(() => {
        const blank = () => Object.assign(document.createElement("div"), {className: "fn__none"});
        const noop = () => {};
        window.siyuan = {
            config: {editor: {fontSize: 16, markdown: {}, codeTabSpaces: 4}, export: {}, fileTree: {},
                system: {container: "browser"}, appearance: {entryVisibility: {active: "full", profiles: []},
                    notifications: {selectAllTip: false}},
                keymap: structuredClone(cellTest.Constants.SIYUAN_KEYMAP)},
            languages: {}, menus: {menu: {element: blank(), remove: noop}}, storage: {}, dialogs: [],
            layout: {}, blockPanels: [], emojis: [{items: []}], zIndex: 1,
        };
        window.outerFragment = cellTest.mountProtyleLiteFragment(document.getElementById("host"), {
            app: {plugins: []},
            initialBlockHTML: cellTest.getAVRichTextLute().Md2BlockDOM("| A | B |\n| --- | --- |\n| \\*\\*literal\\*\\* | **bold** |\n| below | last |\n| | |"),
            runtimeCapabilities: {upload: false, websocket: false, pluginExtensions: false,
                customBlockRender: false, lute: cellTest.getAVRichTextLute()},
        });
        outerFragment.protyle.gutter = {element: blank(), render: noop};
    });
    const cells = page.locator("#host > .protyle-content > .protyle-wysiwyg tbody td");
    const measure = cell => cell.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const table = element.closest("table").getBoundingClientRect();
        return [rect.width, rect.height, table.width, table.height];
    });
    const originalSize = await measure(cells.first());
    const headers = page.locator("#host > .protyle-content > .protyle-wysiwyg thead th");
    for (let index = 0; index < await headers.count(); index++) {
        const header = headers.nth(index);
        const size = await measure(header);
        await header.click();
        await expect(header.locator(".table__cell-editor")).toBeVisible();
        assert.deepEqual(await measure(header), size, "header cell size when opening the editor");
        await page.keyboard.press("Escape");
    }
    const blankRowSize = await measure(cells.last());
    await cells.last().click();
    await expect(cells.last().locator(".table__cell-editor")).toBeVisible();
    assert.deepEqual(await measure(cells.last()), blankRowSize, "empty row size when opening the editor");
    await page.keyboard.type("1");
    assert.deepEqual(await measure(cells.last()), blankRowSize, "first input keeps row and table dimensions stable");
    await page.keyboard.press("Escape");
    assert.deepEqual(await measure(cells.last()), blankRowSize, "first input stays stable after closing the editor");
    await cells.last().click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    assert.deepEqual(await measure(cells.last()), blankRowSize, "deleting text keeps row and table dimensions stable");
    await page.keyboard.press("Escape");
    assert.deepEqual(await measure(cells.last()), blankRowSize, "cleared row size when closing the editor");
    await cells.first().click();
    await expect(cells.first().locator(".table__cell-editor")).toBeVisible();
    assert.deepEqual(await measure(cells.first()), originalSize, "ordinary cell size when opening the editor");
    await page.keyboard.press("End");
    await page.keyboard.type(" changed");
    await page.keyboard.press("Tab");
    await expect(cells.nth(1).locator(".table__cell-editor")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(cells.nth(3).locator(".table__cell-editor")).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(cells.nth(2).locator(".table__cell-editor")).toBeVisible();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("next line");
    await page.keyboard.press("Escape");
    await expect(cells.first()).toHaveText("**literal** changed");
    await expect(cells.first().locator('[data-type~="strong"]')).toHaveCount(0);
    await expect(cells.nth(2).locator("br")).not.toHaveCount(0);
    await expect(cells.locator(".table__cell-editor")).toHaveCount(0);
    await expect(page.locator("[data-sy-table-cell-rich], [data-sy-table-cell-inline]")).toHaveCount(0);
    await cells.first().evaluate(cell => cell.textContent = "**raw literal**");
    await cells.first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" updated");
    await page.keyboard.press("Escape");
    await expect(cells.first()).toHaveText("**raw literal** updated");
    await expect(cells.first().locator('[data-type~="strong"]')).toHaveCount(0);
    await cells.nth(1).evaluate(cell => cell.textContent = "");
    const emptySize = await measure(cells.nth(1));
    await cells.nth(1).click();
    assert.deepEqual(await measure(cells.nth(1)), emptySize, "empty cell size when opening the editor");
    const fragment = cells.nth(1).locator(".table__cell-editor .protyle-wysiwyg");
    await page.keyboard.type("- first");
    await expect(fragment.locator('[data-type="NodeList"]')).toHaveCount(1);
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    await page.keyboard.press("Tab");
    await expect(fragment.locator('[data-type="NodeList"]')).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(cells.nth(1)).toHaveAttribute("data-sy-table-cell-rich");
    await cells.nth(1).click();
    await expect(fragment.locator('[data-type="NodeList"]')).toHaveCount(2);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("plain again");
    await page.keyboard.press("Escape");
    await expect(cells.nth(1)).toHaveAttribute("data-sy-table-cell-rich");
    await expect(cells.nth(1).locator('[data-type="NodeList"]')).toHaveCount(0);
    await expect.poll(() => cells.nth(1).textContent().then(text => text.replace(/\u200b/g, ""))).toBe("plain again");
    const ordinaryEmptySize = await measure(cells.last());
    await cells.last().evaluate(cell => {
        cellTest.setTableCellRich(cell, "");
        cellTest.renderTableCellRichElements(cell);
    });
    assert.deepEqual(await measure(cells.last()), ordinaryEmptySize, "rich empty preview matches ordinary empty cell");
    await cells.last().click();
    const emptyEditor = cells.last().locator(".table__cell-editor");
    await expect(emptyEditor).toBeVisible();
    await expect(emptyEditor.locator(".protyle-wysiwyg [placeholder]")).toHaveCount(0);
    assert.deepEqual(await measure(cells.last()), ordinaryEmptySize, "rich empty editor matches ordinary empty cell");
    await page.keyboard.type("123");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await expect(cells.last()).toHaveAttribute("data-sy-table-cell-rich");
    assert.deepEqual(await measure(cells.last()), ordinaryEmptySize, "cleared rich cell remains compact");
    await page.keyboard.press("Shift+Tab");
    await expect(cells.nth(4).locator(".table__cell-editor")).toBeVisible();
    await page.keyboard.press("Escape");
    // 批量样式通过无光标选区的临时编辑器处理，并应保留段落及列表结构。
    await page.evaluate(() => {
        let targets = Array.from(outerFragment.wysiwyg.querySelectorAll("tbody td")).slice(0, 2);
        cellTest.setTableCellRich(targets[0], "paragraph");
        cellTest.setTableCellRich(targets[1], "- first\n- second");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
        for (const expected of [true, false]) {
            cellTest.applyTableCellRichInlineMark(outerFragment.protyle, targets, "strong");
            targets = Array.from(outerFragment.wysiwyg.querySelectorAll("tbody td")).slice(0, 2);
            targets.forEach((cell, index) => {
                const restored = document.createElement("div");
                restored.innerHTML = cellTest.getTableCellRichBlockDOM(cell);
                const edits = Array.from(restored.querySelectorAll('[data-type="NodeParagraph"] > [contenteditable="true"]'));
                const texts = edits.map(edit => edit.textContent.replace(/\u200b/g, ""));
                if (JSON.stringify(texts) !== JSON.stringify(index === 0 ? ["paragraph"] : ["first", "second"])) {
                    throw new Error("Batch rich cell formatting changed the text");
                }
                if (edits.length !== (index === 0 ? 1 : 2) || edits.some(edit =>
                    !!edit.querySelector('[data-type~="strong"]') !== expected)) {
                    throw new Error(`Batch rich cell bold toggle failed: ${expected}, ${index}, ${restored.innerHTML}`);
                }
                if (index === 1 && !restored.querySelector('[data-type="NodeList"]')) {
                    throw new Error("Batch rich cell formatting lost the list");
                }
            });
        }
    });
    console.log("PASS: batch rich cell bold and unbold without a toolbar selection preserve paragraphs and lists");
    await page.evaluate(() => {
        document.getElementById("sidebar").remove();
        document.body.appendChild(Object.assign(document.createElement("div"), {className: "layout-tab-bar"}));
        delete outerFragment.protyle.gutter;
        outerFragment.protyle.wysiwyg.tableControl = new cellTest.TableControl(outerFragment.protyle,
            outerFragment.wysiwyg);
    });
    await cells.nth(1).hover();
    await cells.nth(1).click();
    const cellHandle = page.locator('#host > .protyle-table-control [data-type="cell"]');
    await expect(cellHandle).toBeVisible();
    await cells.nth(1).locator('.table__cell-editor [contenteditable="true"]').first().hover();
    await expect(cells.nth(1).locator('.protyle-table-control__handle:not(.fn__none)')).toHaveCount(0);
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    await expect(cellHandle).toBeVisible();
    await cellHandle.click({modifiers: ["Control"]});
    await expect(cells.nth(1).locator(".table__cell-editor")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() =>
        outerFragment.protyle.wysiwyg.tableControl.getSelectedCells().length)).toBe(1);
    await cells.nth(1).click();
    await expect(cellHandle).toBeVisible();
    await page.evaluate(() => {
        window.cellMenuItems = [];
        window.siyuan.menus.menu.append = element => window.cellMenuItems.push(element);
        window.siyuan.menus.menu.popup = () => window.cellMenuOpened = true;
    });
    await cellHandle.click();
    await expect.poll(() => page.evaluate(() => window.cellMenuOpened && window.cellMenuItems.length > 0)).toBe(true);
    await expect(cells.nth(1).locator(".table__cell-editor")).toHaveCount(0);
    console.log("PASS: cell handle stays visible while editing and can select the edited cell");
    await page.evaluate(languages => window.siyuan.languages = languages,
        JSON.parse(await readFile(path.join(app, "appearance/langs/en.json"), "utf8")));
    await cells.last().click();
    await page.keyboard.type("/");
    const slashMenu = page.locator('.protyle-hint:not(.fn__none)');
    await expect(slashMenu.locator('[data-id="heading1"]')).toBeVisible();
    await expect(slashMenu.locator('[data-id="list"]')).toBeVisible();
    await expect(slashMenu.locator('[data-id^="database"], [data-id="table"], [data-id="widget"]')).toHaveCount(0);
    await slashMenu.locator('[data-id="heading1"]').click();
    await page.keyboard.type("Heading");
    await expect(cells.last().locator('[data-type="NodeHeading"]')).toHaveCount(1);
    await page.keyboard.press("Escape");
    await cells.last().click();
    await expect(cells.last().locator('[data-type="NodeHeading"]')).toContainText("Heading");
    await page.keyboard.press("Escape");
    await cells.nth(4).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("/");
    await expect(slashMenu.locator('[data-id="list"]')).toBeVisible();
    await slashMenu.locator('[data-id="list"]').click();
    await page.keyboard.type("List item");
    await page.keyboard.press("Escape");
    await cells.nth(4).click();
    await expect(cells.nth(4).locator('[data-type="NodeList"]')).toContainText("List item");
    await page.keyboard.press("Escape");
    await cells.nth(3).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("/database");
    await expect(slashMenu).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.locator('#host [data-type="NodeAttributeView"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    console.log("PASS: cell slash menu excludes databases and nested tables and persists a supported heading");
    await page.evaluate(() => {
        window.siyuan.reqIds = {};
        window.refQueries = [];
        const originalFetch = window.fetch;
        window.fetch = (url, init) => {
            if (url !== "/api/search/searchRefBlock") {
                return originalFetch(url, init);
            }
            const request = JSON.parse(init.body);
            window.refQueries.push(request.k);
            return Promise.resolve(new Response(JSON.stringify({code: 0, msg: "", data: {
                k: request.k, reqId: request.reqId, newDoc: false, blocks: [{
                    id: "20260908120000-ref0001", type: "NodeParagraph", ial: {},
                    refText: "Reference target", content: "Reference target", hPath: "/Reference test",
                }],
            }}), {headers: {"content-type": "application/json"}}));
        };
    });
    await cells.nth(2).evaluate(cell => {
        cellTest.setTableCellRich(cell, "");
        cellTest.renderTableCellRichElements(cell);
    });
    await cells.nth(2).click();
    await expect(cells.nth(2).locator(".table__cell-editor")).toBeVisible();
    await page.keyboard.type("/");
    await slashMenu.locator('[data-id="ref"]').click();
    await page.keyboard.type("Reference");
    await expect.poll(() => page.evaluate(() => window.refQueries.includes("Reference"))).toBe(true);
    await expect(slashMenu.locator('[data-node-id="20260908120000-ref0001"]')).toBeVisible();
    await slashMenu.locator('[data-node-id="20260908120000-ref0001"]').click();
    await page.keyboard.press("Escape");
    await cells.nth(2).click();
    await expect(cells.nth(2).locator('[data-type~="block-ref"][data-id="20260908120000-ref0001"]')).toContainText("Reference target");
    await page.keyboard.press("Escape");
    console.log("PASS: slash reference searches as typing continues and preserves the selected reference");
    await page.evaluate(() => {
        const targets = Array.from(outerFragment.wysiwyg.querySelectorAll("tbody td")).slice(0, 2);
        cellTest.setTableCellRich(targets[0], "## Heading\n\nparagraph");
        cellTest.setTableCellRich(targets[1], "- first\n  - nested");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
        const control = outerFragment.protyle.wysiwyg.tableControl;
        control.selectCellRange(targets[0], targets[1]);
        control.mergeCells();
    });
    await expect(cells.first()).toHaveAttribute("colspan", "2");
    await expect(cells.nth(1)).toBeHidden();
    await expect(cells.first().locator('.table__cell-rich [data-type="NodeHeading"]')).toContainText("Heading");
    await expect(cells.first().locator('.table__cell-rich [data-type="NodeList"]')).toHaveCount(2);
    await page.keyboard.press("Control+z");
    await expect(cells.first()).not.toHaveAttribute("colspan", "2");
    await expect(cells.nth(1)).toBeVisible();
    await page.keyboard.press("Control+Shift+z");
    await expect(cells.first()).toHaveAttribute("colspan", "2");
    await expect(cells.nth(1)).toBeHidden();
    await cells.first().click();
    await expect(cells.first().locator('.table__cell-editor [data-type="NodeList"]')).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(cells.first().locator('.table__cell-rich [data-type="NodeList"]')).toHaveCount(2);
    console.log("PASS: merging rich cells preserves displayed and stored headings and nested lists");
    await page.evaluate(() => {
        const cell = outerFragment.wysiwyg.querySelector("tbody td");
        const control = outerFragment.protyle.wysiwyg.tableControl;
        control.selectCellRange(cell, cell);
        control.splitCell(cell);
    });
    await expect(cells.nth(1)).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect(cells.first()).toHaveAttribute("colspan", "2");
    await expect(cells.nth(1)).toBeHidden();
    await page.keyboard.press("Control+Shift+z");
    await expect(cells.nth(1)).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect(cells.first()).toHaveAttribute("colspan", "2");
    await page.evaluate(() => {
        const cell = outerFragment.wysiwyg.querySelector("tbody td");
        outerFragment.protyle.wysiwyg.tableControl.clear();
        const range = document.createRange();
        range.selectNodeContents(cell);
        const menu = cellTest.tableMenu(outerFragment.protyle, cell.closest('[data-type="NodeTable"]'), cell, range);
        menu.otherMenus.find(item => item.id === "cancelMerged").click();
    });
    await expect(cells.nth(1)).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect(cells.first()).toHaveAttribute("colspan", "2");
    await expect(cells.nth(1)).toBeHidden();
    await page.keyboard.press("Control+Shift+z");
    await expect(cells.nth(1)).toBeVisible();
    console.log("PASS: both table split entry points support immediate undo and redo");
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div id="message"><div></div></div>'));
    await cells.nth(1).click();
    const pasteEdit = cells.nth(1).locator('.p > [contenteditable="true"]').first();
    await pasteEdit.click();
    await page.keyboard.insertText("keep");
    await pasteEdit.evaluate(edit => {
        const range = document.createRange();
        range.selectNodeContents(edit);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
    });
    const markdownTable = "| Header | Header |\n|--------|--------|\n| Cell | Cell |\n| Cell | Cell | ";
    const pasteCases = [
        {"text/plain": markdownTable},
        {"text/plain": "Header", "text/html": "<table><tr><td>Header</td></tr></table>"},
        {"text/plain": "video", "text/html": '<video src="test.mp4"></video>'},
        {"text/plain": "audio", "text/html": '<audio src="test.mp3"></audio>'},
        {"text/plain": "frame", "text/html": '<iframe src="about:blank"></iframe>'},
        {"text/plain": "Header", "text/siyuan": await page.evaluate(md => cellTest.getAVRichTextLute().Md2BlockDOM(md), markdownTable)},
        {"text/plain": "before\n\n---\n\nafter"},
        {"text/plain": "```mermaid\ngraph LR\nA-->B\n```"},
        ...["NodeAttributeView", "NodeBlockQueryEmbed", "NodeSuperBlock", "NodeWidget", "NodeVideo", "NodeAudio", "NodeIFrame", "NodeHTMLBlock", "NodeCustomBlock", "NodeTabs", "NodeCallout"].map(type => ({
            "text/plain": "before unsupported after",
            "text/siyuan": `<div data-type="NodeParagraph"><div contenteditable="true">before</div></div><div data-type="${type}"></div><div data-type="NodeParagraph"><div contenteditable="true">after</div></div>`,
        })),
    ];
    for (const payload of pasteCases) {
        await page.locator("#message > div").evaluate(el => el.replaceChildren());
        await pasteEdit.evaluate((edit, data) => {
            const clipboard = new DataTransfer();
            Object.entries(data).forEach(([type, value]) => clipboard.setData(type, value));
            const originalAdd = cellTest.LocalUndo.prototype.add;
            let undoCount = 0;
            cellTest.LocalUndo.prototype.add = function (...args) {
                undoCount++;
                return originalAdd.apply(this, args);
            };
            try {
                edit.dispatchEvent(new ClipboardEvent("paste", {clipboardData: clipboard, bubbles: true, cancelable: true}));
                if (undoCount !== 0) throw new Error("Rejected paste added an undo operation");
            } finally {
                cellTest.LocalUndo.prototype.add = originalAdd;
            }
        }, payload);
        await expect(page.locator("#message")).toContainText("Paste canceled");
        await expect(pasteEdit).toHaveText("keep");
        assert.equal(await page.evaluate(() => getSelection().toString()), "keep");
        await expect(cells.nth(1).locator("table")).toHaveCount(0);
    }
    await pasteEdit.evaluate(edit => {
        const range = document.createRange();
        range.selectNodeContents(edit);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
    });
    await pasteEdit.evaluate(edit => {
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", "left | right");
        edit.dispatchEvent(new ClipboardEvent("paste", {clipboardData: clipboard, bubbles: true, cancelable: true}));
    });
    await expect(pasteEdit).toHaveText("left | right");
    await page.keyboard.press("Escape");
    await cells.nth(1).click();
    await expect(cells.nth(1).locator('.p > [contenteditable="true"]').first()).toHaveText("left | right");
    console.log("PASS: unsupported pasted blocks reject the whole payload without changing content or selection; pipe text persists");
    await page.keyboard.press("Escape");
    await cells.nth(1).evaluate(cell => { cell.innerHTML = ""; cell.style.height = "180px"; });
    const clickBox = await cells.nth(1).boundingBox();
    await page.mouse.move(clickBox.x + 12, clickBox.y + 12);
    await page.mouse.down();
    await expect(cells.nth(1).locator(".table__cell-editor")).toBeVisible();
    const pressedCaret = await page.evaluate(() => {
        const range = getSelection().getRangeAt(0);
        return {node: range.startContainer.nodeName, offset: range.startOffset, rect: range.getBoundingClientRect().toJSON()};
    });
    assert.equal(pressedCaret.node, "#text");
    assert.ok(Math.abs(pressedCaret.rect.y + pressedCaret.rect.height / 2 - (clickBox.y + clickBox.height / 2)) < 3,
        "mouse down places the empty cell caret at the vertically centered editing line");
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => {
        const range = getSelection().getRangeAt(0);
        return {node: range.startContainer.nodeName, offset: range.startOffset, rect: range.getBoundingClientRect().toJSON()};
    }), pressedCaret, "mouse up must not reposition the empty cell caret");
    await page.keyboard.type("stable");
    await page.keyboard.press("Escape");
    await expect(cells.nth(1)).toHaveText("stable");
    console.log("PASS: clicking a tall empty cell positions the caret once without jumping on mouse up");
    await cells.nth(1).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    const rightBlankState = await cells.nth(1).evaluate(cell => {
        const range = getSelection().getRangeAt(0);
        const table = cell.closest("table").getBoundingClientRect();
        return {x: table.right + 40, y: table.top + table.height / 2, offset: range.startOffset,
            caret: range.getBoundingClientRect().toJSON()};
    });
    await page.mouse.click(rightBlankState.x, rightBlankState.y);
    await expect(cells.nth(1).locator(".table__cell-editor")).toBeVisible();
    assert.deepEqual(await page.evaluate(() => {
        const range = getSelection().getRangeAt(0);
        return {offset: range.startOffset, caret: range.getBoundingClientRect().toJSON()};
    }), {offset: rightBlankState.offset, caret: rightBlankState.caret}, "right-side blank click preserves the editing caret");
    await page.keyboard.type("X");
    await cells.first().click();
    await expect(cells.nth(1).locator(".table__cell-editor")).toHaveCount(0);
    await expect(cells.nth(1)).toHaveText("sXtable");
    console.log("PASS: clicking the table's right-side blank preserves the caret and subsequent typing; another cell still ends editing");
    assert.deepEqual(errors, []);
    console.log("PASS: default cell click editing, Tab/Enter navigation, soft breaks and Escape through real editor events");
    console.log("PASS: header, ordinary and empty cell dimensions remain unchanged when editing starts and ends");
    console.log("PASS: Markdown list input, nested list Tab, rich source promotion, reopening and retention");
} finally {
    await browser.close();
}
