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
export {matchHotKey} from "./src/protyle/util/hotKey";
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
    await expect(cells.nth(1).locator(".table__cell-editor")).toHaveCount(0);
    await page.mouse.up();
    await expect(cells.nth(1).locator(".table__cell-editor")).toBeVisible();
    const pressedCaret = await page.evaluate(() => {
        const range = getSelection().getRangeAt(0);
        return {node: range.startContainer.nodeName, offset: range.startOffset, rect: range.getBoundingClientRect().toJSON()};
    });
    assert.equal(pressedCaret.node, "#text");
    const emptyLine = await cells.nth(1).locator('.p > [contenteditable="true"]').first().boundingBox();
    assert.ok(Math.abs(pressedCaret.rect.y + pressedCaret.rect.height / 2 - (emptyLine.y + emptyLine.height / 2)) < 3,
        "click places the empty cell caret on its editing line");
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
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        outerFragment.setMarkdown("fresh");
        outerFragment.focus(true);
    });
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await page.evaluate(() => outerFragment.protyle.lite = false);
    await page.keyboard.press("Control+o");
    const newHeader = page.locator('#host > .protyle-content > .protyle-wysiwyg th').first();
    await expect(newHeader.locator(".table__cell-editor")).toBeVisible();
    await page.evaluate(() => outerFragment.protyle.lite = true);
    await page.keyboard.type("/");
    await expect(slashMenu.locator('[data-id="heading1"]')).toBeVisible();
    await expect(slashMenu.locator('[data-id^="database"], [data-id="table"], [data-id="widget"]')).toHaveCount(0);
    await page.keyboard.type("data");
    await expect(page.locator(".protyle-hint--lite-overlay:not(.fn__none) [data-id^='database']")).toHaveCount(0);
    await expect(page.locator('#host [data-type="NodeAttributeView"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    console.log("PASS: creating a table by shortcut enters restricted cell editing before typing without a cell click");
    await page.evaluate(() => {
        outerFragment.setMarkdown("fresh");
        outerFragment.focus(true);
    });
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await page.evaluate(() => outerFragment.protyle.lite = false);
    await page.keyboard.type("/table");
    await expect(slashMenu.locator('[data-id="table"]')).toBeVisible();
    await slashMenu.locator('[data-id="table"]').click();
    await expect(newHeader.locator(".table__cell-editor")).toBeVisible();
    await page.evaluate(() => outerFragment.protyle.lite = true);
    await page.keyboard.type("/");
    await expect(slashMenu.locator('[data-id="list"]')).toBeVisible();
    await expect(slashMenu.locator('[data-id^="database"], [data-id="table"]')).toHaveCount(0);
    await slashMenu.locator('[data-id="list"]').click();
    await page.keyboard.type("item");
    await expect(newHeader.locator('[data-type="NodeList"]')).toContainText("item");
    await page.keyboard.press("Escape");
    await expect(newHeader).toHaveAttribute("data-sy-table-cell-rich");
    await expect(page.locator('#host [data-type="NodeAttributeView"]')).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log("PASS: slash-created tables immediately support restricted list editing without a cell click");
    await page.evaluate(() => {
        outerFragment.setMarkdown("| A | B | C |\n| --- | --- | --- |\n| | | |\n| | | |");
        outerFragment.wysiwyg.querySelectorAll("col").forEach(col => col.style.minWidth = "100px");
        const cells = outerFragment.wysiwyg.querySelectorAll("th, td");
        cells.forEach(cell => cell.textContent = "");
        cellTest.setTableCellRich(cells[4], "## Heading\n\nfirst paragraph\n\nlast paragraph");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
    });
    const arrowCells = page.locator('#host > .protyle-content > .protyle-wysiwyg th, #host > .protyle-content > .protyle-wysiwyg td');
    const expectArrowCell = async index => {
        await expect(arrowCells.nth(index).locator(".table__cell-editor")).toBeVisible();
        assert.equal(await arrowCells.nth(index).evaluate(cell => cell.querySelector(".table__cell-editor").contains(getSelection().focusNode)), true);
    };
    await arrowCells.first().click();
    for (const [key, index] of [["ArrowRight", 1], ["ArrowRight", 2], ["ArrowDown", 5], ["ArrowLeft", 4]]) {
        await page.keyboard.press(key);
        await expectArrowCell(index);
    }
    await page.keyboard.press("ArrowLeft");
    await expectArrowCell(4);
    const selectCellBoundary = async start => arrowCells.nth(4).evaluate((cell, start) => {
        const edits = cell.querySelectorAll('.table__cell-editor [data-type^="Node"] > [contenteditable="true"]');
        const range = document.createRange();
        range.selectNodeContents(start ? edits[0] : edits[edits.length - 1]);
        range.collapse(start);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
    }, start);
    await selectCellBoundary(true);
    await page.keyboard.press("ArrowDown");
    await expectArrowCell(4);
    await selectCellBoundary(true);
    await page.keyboard.press("ArrowUp");
    await expectArrowCell(1);
    await page.keyboard.press("ArrowDown");
    await expectArrowCell(4);
    await selectCellBoundary(false);
    await page.keyboard.press("ArrowDown");
    await expectArrowCell(7);
    await page.keyboard.press("ArrowUp");
    await expectArrowCell(4);
    await selectCellBoundary(false);
    await page.keyboard.press("ArrowRight");
    await expectArrowCell(5);
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    console.log("PASS: all four arrow keys cross empty and rich cells only at content boundaries");
    await arrowCells.first().evaluate(cell => {
        cell.colSpan = 2;
        cell.nextElementSibling.classList.add("fn__none");
    });
    await arrowCells.first().click();
    await page.keyboard.press("ArrowRight");
    await expectArrowCell(2);
    await page.keyboard.press("ArrowLeft");
    await expectArrowCell(0);
    await page.keyboard.press("ArrowDown");
    await expectArrowCell(3);
    await page.keyboard.press("ArrowUp");
    await expectArrowCell(0);
    await page.keyboard.press("Escape");
    await arrowCells.nth(4).evaluate(cell => {
        cellTest.setTableCellRich(cell, "first<br />second");
        cellTest.renderTableCellRichElements(cell);
    });
    await arrowCells.nth(4).click();
    await selectCellBoundary(true);
    await page.keyboard.press("ArrowDown");
    await expectArrowCell(4);
    await selectCellBoundary(false);
    await page.keyboard.press("ArrowDown");
    await expectArrowCell(7);
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    console.log("PASS: arrow navigation skips merged placeholders and preserves movement within soft-wrapped cell content");
    await arrowCells.nth(4).evaluate(cell => {
        cellTest.setTableCellRich(cell, "## abcdef\n\n- ghijkl\n  - nested\n\nmnopqr");
        cellTest.renderTableCellRichElements(cell);
    });
    const textPoint = async (text, offset) => arrowCells.nth(4).evaluate((cell, {text, offset}) => {
        const walker = document.createTreeWalker(cell.querySelector(".table__cell-rich"), NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            if (walker.currentNode.textContent === text) {
                const range = document.createRange();
                range.setStart(walker.currentNode, offset);
                range.collapse(true);
                const rect = range.getBoundingClientRect();
                return {x: rect.x + 0.5, y: rect.y + rect.height / 2};
            }
        }
        throw new Error(`Missing preview text: ${text}`);
    }, {text, offset});
    const headingPoint = await textPoint("abcdef", 2);
    await page.mouse.click(headingPoint.x, headingPoint.y);
    await expectArrowCell(4);
    await page.keyboard.type("X");
    await expect(arrowCells.nth(4).locator('[data-type="NodeHeading"]')).toHaveText("abXcdef");
    await page.keyboard.press("Escape");
    for (const backward of [false, true]) {
        const start = await textPoint("abXcdef", 1);
        const end = await textPoint("ghijkl", 3);
        const from = backward ? end : start;
        const to = backward ? start : end;
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, {steps: 12});
        const selected = await page.evaluate(() => getSelection().toString());
        assert.ok(selected.includes("bXcdef") && selected.includes("ghi"), "drag selects heading and list text");
        await page.mouse.up();
        await expectArrowCell(4);
        assert.equal(await page.evaluate(() => getSelection().toString()), selected,
            "entering cell editing preserves the dragged text selection");
        await expect(arrowCells.nth(4).locator(".table__cell-editor .protyle-toolbar")).toBeVisible();
        await page.keyboard.press("Escape");
    }
    console.log("PASS: clicking rich preview text preserves caret position and dragging preserves forward and backward selections");
    const expectCellText = async (cell, text) => {
        await expect.poll(() => cell.evaluate(element =>
            (element.querySelector(".table__cell-editor .protyle-wysiwyg") || element).textContent.replaceAll("\u200b", "").trim())).toBe(text);
    };
    const expectCellCaret = async (cell, offset) => {
        await expect.poll(() => cell.evaluate(element => {
            const selection = getSelection();
            return element.contains(selection.focusNode) ? selection.focusOffset : -1;
        })).toBe(offset);
    };
    await page.evaluate(() => {
        outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| first | second |");
        outerFragment.protyle.undo.clear();
    });
    await cells.first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("X");
    await page.keyboard.press("Escape");
    await expect(cells.first()).toHaveText("firstX");
    await page.keyboard.press("Control+z");
    await expectCellText(cells.first(), "first");
    await expectCellCaret(cells.first(), 5);
    await page.keyboard.press("Control+Shift+z");
    await expectCellText(cells.first(), "firstX");
    await expectCellCaret(cells.first(), 6);
    await cells.first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("Y");
    await page.keyboard.press("Tab");
    await page.keyboard.press("End");
    await page.keyboard.type("Z");
    await page.keyboard.press("Control+z");
    await expectCellText(cells.nth(1), "second");
    await expectCellCaret(cells.nth(1), 6);
    await page.keyboard.press("Control+z");
    await expectCellText(cells.first(), "firstX");
    await page.keyboard.press("Control+Shift+z");
    await expectCellText(cells.first(), "firstXY");
    await page.keyboard.press("Control+Shift+z");
    await expectCellText(cells.nth(1), "secondZ");
    await expectCellCaret(cells.nth(1), 7);
    await page.keyboard.press("Escape");
    console.log("PASS: cell edits undo and redo after Escape and across cells");
    await page.evaluate(() => {
        outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| first | second |");
        cellTest.setTableCellRich(outerFragment.wysiwyg.querySelector("tbody td"), "## heading\n\nparagraph");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
        outerFragment.protyle.undo.clear();
        outerFragment.protyle.toolbar.element.classList.remove("fn__none");
    });
    await cells.first().click();
    await expect(page.locator("#host > .protyle-toolbar")).toBeHidden();
    const richParagraph = cells.first().locator('.table__cell-editor [data-type="NodeParagraph"] > [contenteditable="true"]');
    await richParagraph.click();
    await richParagraph.dblclick({position: {x: 15, y: 10}});
    const cellToolbar = cells.first().locator(".protyle-toolbar");
    await expect(cellToolbar).toBeVisible();
    await richParagraph.click();
    await expect(cellToolbar).toBeHidden();
    await page.keyboard.press("End");
    await page.keyboard.type("X");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+z");
    await expect(richParagraph).toHaveText("paragraph");
    await expectCellCaret(cells.first(), 9);
    await page.keyboard.press("Control+Shift+z");
    await expect(richParagraph).toHaveText("paragraphX");
    await expectCellCaret(cells.first(), 10);
    await page.keyboard.type("Y");
    await expect(richParagraph).toHaveText("paragraphXY");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| first | second |");
        cellTest.setTableCellRich(outerFragment.wysiwyg.querySelectorAll("tbody td")[1],
            "## Heading\n\n- first\n  - nested\n\nabcdef");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
        outerFragment.protyle.undo.clear();
    });
    await cells.nth(1).click();
    const lastParagraph = cells.nth(1).locator('.table__cell-editor .protyle-wysiwyg > .p > [contenteditable="true"]');
    await lastParagraph.evaluate(edit => getSelection().setBaseAndExtent(edit.firstChild, 4, edit.firstChild, 2));
    await page.keyboard.type("X");
    await expect(lastParagraph).toHaveText("abXef");
    await page.keyboard.press("Control+z");
    await expect(lastParagraph).toHaveText("abcdef");
    await expect.poll(() => page.evaluate(() => ({
        text: getSelection().toString(), anchor: getSelection().anchorOffset, focus: getSelection().focusOffset,
    }))).toEqual({text: "cd", anchor: 4, focus: 2});
    await page.keyboard.press("Control+Shift+z");
    await expect(lastParagraph).toHaveText("abXef");
    await expectCellCaret(cells.nth(1), 3);
    await page.keyboard.press("Enter");
    await expect(cells.nth(1).locator('.table__cell-editor .protyle-wysiwyg > .p')).toHaveCount(2);
    await page.keyboard.press("Control+z");
    await expect(lastParagraph).toHaveText("abXef");
    await expectCellCaret(cells.nth(1), 3);
    await page.keyboard.press("Control+Shift+z");
    await expect(cells.nth(1).locator('.table__cell-editor .protyle-wysiwyg > .p')).toHaveCount(2);
    await page.keyboard.type("Y");
    await expect(lastParagraph.last()).toHaveText("Yef");
    await page.keyboard.press("Escape");
    console.log("PASS: undo and redo restore non-first rich cell, backward selections, paragraph splits and continued typing");
    const plainPoints = await cells.first().evaluate(cell => [1, 4].map(offset => {
        const range = document.createRange();
        range.setStart(cell.firstChild, offset);
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        return {x: rect.x + 0.5, y: rect.y + rect.height / 2};
    }));
    await page.mouse.move(plainPoints[0].x, plainPoints[0].y);
    await page.mouse.down();
    await page.mouse.move(plainPoints[1].x, plainPoints[1].y, {steps: 8});
    await page.mouse.up();
    await expect(cells.first().locator(".table__cell-editor .protyle-toolbar")).toBeVisible();
    assert.equal(await page.evaluate(() => getSelection().toString()), "irs");
    await cells.first().locator('.protyle-toolbar [data-type="strong"]').click();
    await expect(cells.first().locator('.table__cell-editor .protyle-wysiwyg [data-type="strong"]')).toHaveText("irs");
    await page.keyboard.press("Escape");
    console.log("PASS: first drag in an ordinary cell shows a working formatting toolbar");
    await page.evaluate(() => {
        outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| first | second |");
        outerFragment.protyle.undo.clear();
    });
    await cells.nth(1).click();
    await page.keyboard.press("End");
    await page.keyboard.type("XYZ");
    for (const value of ["secondXY", "secondX", "second"]) {
        await page.keyboard.press("Control+z");
        await expectCellText(cells.nth(1), value);
    }
    for (const value of ["secondX", "secondXY", "secondXYZ"]) {
        await page.keyboard.press("Control+Shift+z");
        await expectCellText(cells.nth(1), value);
    }
    await page.keyboard.press("Escape");
    console.log("PASS: rapid cell typing has one undo and redo step per key");
    await page.evaluate(() => {
        outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| first | second |");
        const targets = outerFragment.wysiwyg.querySelectorAll("tbody td");
        cellTest.setTableCellRich(targets[0], "- keep\n- move\n  - nested");
        cellTest.setTableCellRich(targets[1], "- target");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
        outerFragment.protyle.undo.clear();
    });
    await cells.first().click();
    const dragHandle = cells.first().locator('.table__cell-editor .protyle-wysiwyg > .list > .li > .protyle-action').nth(1);
    assert.equal(await cells.first().locator('.table__cell-editor .protyle-wysiwyg').evaluate(el => getComputedStyle(el).padding), "0px");
    assert.equal(await cells.nth(1).locator('.table__cell-rich').evaluate(el => getComputedStyle(el).padding), "0px");
    const dragBox = await dragHandle.boundingBox();
    const dropBox = await cells.nth(1).locator('[data-type="NodeListItem"]').boundingBox();
    await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + dragBox.width / 2 + 10, dragBox.y + dragBox.height / 2, {steps: 3});
    const sourceTarget = await cells.first().locator('.table__cell-editor .li').first().boundingBox();
    await page.mouse.move(sourceTarget.x + 10, sourceTarget.y + 5, {steps: 4});
    await page.mouse.move(sourceTarget.x + 11, sourceTarget.y + 5);
    await expect(cells.first().locator('[class*="dragover__"]')).toHaveCount(1);
    await page.mouse.move(dropBox.x + 10, dropBox.y + dropBox.height - 2, {steps: 8});
    await page.mouse.move(dropBox.x + 11, dropBox.y + dropBox.height - 2);
    await expect(page.locator(".table__cell-rich .dragover__bottom--sibling")).toBeVisible();
    await page.evaluate(({x, y}) => {
        const indicator = document.querySelector(".table__cell-rich .dragover__bottom--sibling");
        const indicators = outerFragment.wysiwyg.querySelectorAll('[class*="dragover"]');
        if (indicators.length !== 1) throw new Error("Stale drag indicators: " + Array.from(indicators).map(el => el.className).join(", "));
        const style = getComputedStyle(indicator, "::after");
        const color = style.backgroundColor;
        if (style.height !== "4px") throw new Error("Cell drop indicator differs from block drag line");
        if (color === "rgba(0, 0, 0, 0)" || color === "transparent") throw new Error("Transparent cell drop indicator");
        document.elementFromPoint(x, y).dispatchEvent(new DragEvent("dragleave", {
            bubbles: true, clientX: x, clientY: y, relatedTarget: null,
        }));
        if (!indicator.classList.contains("dragover__bottom--sibling")) throw new Error("Internal dragleave removed the cell drop indicator");
    }, {x: dropBox.x + 11, y: dropBox.y + dropBox.height - 2});
    await expect(page.locator(".table__cell-rich .dragover__bottom--sibling")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator(".table__cell-drop")).toHaveCount(0);
    await expect(page.locator(".table__cell-rich .dragover__bottom--sibling")).toHaveCount(0);
    await page.evaluate(() => {
        const source = outerFragment.wysiwyg.querySelector(".table__cell-editor .protyle-wysiwyg");
        const item = source.querySelectorAll('[data-type="NodeList"] > [data-type="NodeListItem"]')[1];
        const transfer = new DataTransfer();
        item.querySelector(".protyle-action").dispatchEvent(new DragEvent("dragstart", {
            dataTransfer: transfer, bubbles: true, cancelable: true,
        }));
        const target = outerFragment.wysiwyg.querySelectorAll("tbody td")[1].querySelector('[data-type="NodeListItem"]');
        const rect = target.getBoundingClientRect();
        const options = {dataTransfer: transfer, bubbles: true, cancelable: true, clientX: rect.x + 10, clientY: rect.bottom - 2};
        target.dispatchEvent(new DragEvent("dragover", options));
        if (!target.classList.contains("dragover__bottom--sibling")) throw new Error("Missing cell drop indicator");
        target.dispatchEvent(new DragEvent("drop", options));
    });
    await expectCellText(cells.first(), "keep");
    await expect(cells.nth(1).locator('[data-type="NodeListItem"]')).toHaveCount(3);
    await cells.nth(1).click();
    await page.keyboard.press("Control+z");
    await expect(cells.first().locator('[data-type="NodeListItem"]')).toHaveCount(3);
    await expectCellText(cells.nth(1), "target");
    await page.keyboard.press("Control+Shift+z");
    await expectCellText(cells.first(), "keep");
    await expect(cells.nth(1).locator('[data-type="NodeListItem"]')).toHaveCount(3);
    await page.keyboard.press("Escape");
    console.log("PASS: cross-cell list drag preserves nested blocks and undoes both cells in one step");
    await cells.nth(1).click();
    await page.evaluate(() => {
        window.cutData = {};
        window.ClipboardItem ||= class {
            constructor(data) { this.data = data; this.types = Object.keys(data); }
            async getType(type) { return this.data[type]; }
        };
        Object.defineProperty(navigator, "clipboard", {configurable: true, value: {write: async items => {
            for (const item of items) for (const type of item.types) window.cutData[type] = await (await item.getType(type)).text();
        }}});
        const originalFetch = window.fetch;
        window.fetch = (url, init) => url === "/api/block/checkBlocksExist" ?
            Promise.resolve(new Response(JSON.stringify({code: 0, msg: "", data: {}}),
                {headers: {"content-type": "application/json"}})) : originalFetch(url, init);
        const item = outerFragment.wysiwyg.querySelector('.table__cell-editor [data-type="NodeListItem"]');
        item.classList.add("protyle-wysiwyg--select");
        const edit = item.querySelector('[contenteditable="true"]');
        const range = document.createRange();
        range.selectNodeContents(edit);
        range.collapse(false);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        edit.dispatchEvent(new ClipboardEvent("cut", {clipboardData: new DataTransfer(), bubbles: true, cancelable: true}));
    });
    await expect.poll(() => page.evaluate(() => Object.keys(window.cutData).length)).toBeGreaterThan(0);
    await expect(cells.nth(1).locator('[data-type="NodeListItem"]')).toHaveCount(2);
    await cells.first().click();
    await page.keyboard.press("End");
    await page.evaluate(() => {
        const transfer = new DataTransfer();
        Object.entries(window.cutData).forEach(([type, value]) => transfer.setData(type, value));
        outerFragment.wysiwyg.querySelector('.table__cell-editor .protyle-wysiwyg').dispatchEvent(
            new ClipboardEvent("paste", {clipboardData: transfer, bubbles: true, cancelable: true}));
    });
    await expect(cells.first().locator('[data-type="NodeListItem"]')).toHaveCount(2);
    await page.keyboard.press("Escape");
    console.log("PASS: actual block cut clipboard retains list structure when pasted in another cell");
    await page.evaluate(() => {
        outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| | |");
        cellTest.setTableCellRich(outerFragment.wysiwyg.querySelector("tbody td"), "- only");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
        outerFragment.protyle.undo.clear();
    });
    for (const copy of [true, false]) {
        await cells.first().click();
        await page.evaluate(copy => {
            const item = outerFragment.wysiwyg.querySelector('.table__cell-editor [data-type="NodeListItem"]');
            const transfer = new DataTransfer();
            item.querySelector(".protyle-action").dispatchEvent(new DragEvent("dragstart", {
                dataTransfer: transfer, bubbles: true, cancelable: true,
            }));
            const target = outerFragment.wysiwyg.querySelectorAll("tbody td")[1];
            const rect = target.getBoundingClientRect();
            for (const y of [rect.top + 2, rect.bottom - 2]) {
                target.dispatchEvent(new DragEvent("dragover", {dataTransfer: transfer, ctrlKey: copy,
                    bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: y}));
                const line = getComputedStyle(target, "::before");
                const placeholder = getComputedStyle(target, "::after");
                if (line.height !== "4px" || line.position !== "absolute") throw new Error("Empty cell drop must show a thin insertion line");
                if (placeholder.position === "absolute" || placeholder.backgroundColor !== "rgba(0, 0, 0, 0)") {
                    throw new Error("Empty cell placeholder must not become a drop highlight");
                }
                if (target.getBoundingClientRect().height !== rect.height) throw new Error("Drop indicator changed empty cell height");
            }
            target.dispatchEvent(new DragEvent("drop", {dataTransfer: transfer, ctrlKey: copy,
                bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5}));
        }, copy);
        await expectCellText(cells.first(), copy ? "only" : "");
        await expectCellText(cells.nth(1), "only");
        await expect(cells.nth(1).locator('.table__cell-editor .protyle-wysiwyg > .p')).toHaveCount(0);
        await page.keyboard.press("Control+z");
        await expectCellText(cells.first(), "only");
        await expectCellText(cells.nth(1), "");
        await page.keyboard.press("Escape");
    }
    console.log("PASS: copying and moving the last list item into an empty cell preserve content and undo atomically");
    await page.evaluate(() => {
        cellTest.setTableCellRich(outerFragment.wysiwyg.querySelectorAll("tbody td")[1], "- parent");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
        outerFragment.protyle.undo.clear();
    });
    await cells.first().click();
    await page.evaluate(() => {
        const item = outerFragment.wysiwyg.querySelector('.table__cell-editor [data-type="NodeListItem"]');
        const transfer = new DataTransfer();
        item.querySelector(".protyle-action").dispatchEvent(new DragEvent("dragstart", {
            dataTransfer: transfer, bubbles: true, cancelable: true,
        }));
        const target = outerFragment.wysiwyg.querySelectorAll("tbody td")[1].querySelector(".li");
        const rect = target.querySelector(".p").getBoundingClientRect();
        const options = {dataTransfer: transfer, bubbles: true, cancelable: true, clientX: rect.left + 5, clientY: rect.bottom - 2};
        target.dispatchEvent(new DragEvent("dragover", options));
        if (!target.classList.contains("dragover__bottom--child")) throw new Error("Missing child list drop indicator");
        const indent = target.style.getPropertyValue("--drag-indent");
        if (target.style.getPropertyValue("--drag-line-left") !== indent) throw new Error("Child line should align to list indent");
        target.dispatchEvent(new DragEvent("drop", options));
    });
    await expectCellText(cells.first(), "");
    await expect(cells.nth(1).locator('.table__cell-editor .li > .list > .li .p > [contenteditable="true"]')).toHaveText("only");
    await page.keyboard.press("Control+z");
    await expectCellText(cells.first(), "only");
    await expectCellText(cells.nth(1), "parent");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        cellTest.setTableCellRich(outerFragment.wysiwyg.querySelectorAll("tbody td")[1], "");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
        outerFragment.protyle.undo.clear();
    });
    console.log("PASS: cross-cell list child indicator matches the inserted nesting and supports undo");
    await cells.nth(1).click();
    await page.evaluate(async () => {
        const edit = outerFragment.wysiwyg.querySelector('.table__cell-editor .p > [contenteditable="true"]');
        edit.dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true}));
        for (const text of ["n", "ni", "你"]) {
            edit.dispatchEvent(new InputEvent("beforeinput", {bubbles: true, inputType: "insertCompositionText", data: text, isComposing: true}));
            edit.textContent = text;
            const range = document.createRange();
            range.selectNodeContents(edit);
            range.collapse(false);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
            edit.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertCompositionText", data: text, isComposing: true}));
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        edit.dispatchEvent(new CompositionEvent("compositionend", {bubbles: true, data: "你"}));
    });
    await expectCellText(cells.nth(1), "你");
    await page.keyboard.press("Control+z");
    await expectCellText(cells.nth(1), "");
    await page.keyboard.press("Control+Shift+z");
    await expectCellText(cells.nth(1), "你");
    await page.keyboard.press("Escape");
    console.log("PASS: IME composition remains one undo step without intermediate phonetic input");
    for (const content of ["", "plain", "- item"]) {
        await page.evaluate(content => {
            outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| | target |");
            if (content) cellTest.setTableCellRich(outerFragment.wysiwyg.querySelector("tbody td"), content);
            cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
        }, content);
        const start = await cells.first().boundingBox();
        const end = await cells.nth(1).boundingBox();
        await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
        await page.mouse.down();
        await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {steps: 8});
        await page.mouse.up();
        await expect.poll(() => page.evaluate(() => outerFragment.protyle.wysiwyg.tableControl.getSelectedCells().length)).toBe(2);
        await cells.first().click();
        const edit = cells.first().locator('.table__cell-editor .p > [contenteditable="true"]').first();
        await edit.click();
        if (content) {
            await edit.dblclick({position: {x: 12, y: 8}});
            await expect(page.locator("#host .protyle-toolbar:not(.fn__none)")).toHaveCount(1);
            await page.keyboard.press("Escape");
            await cells.first().click();
        }
        const activeStart = await edit.boundingBox();
        await page.mouse.move(activeStart.x + 4, activeStart.y + 8);
        await page.mouse.down();
        await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {steps: 8});
        await page.mouse.up();
        await expect.poll(() => page.evaluate(() => outerFragment.protyle.wysiwyg.tableControl.getSelectedCells().length)).toBe(2);
        await expect(page.locator("#host .protyle-toolbar:not(.fn__none)")).toHaveCount(0);
    }
    console.log("PASS: empty, ordinary and rich cells support drag selection before and during editing without extra toolbars");
    await page.evaluate(() => {
        outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| | target |");
        cellTest.setTableCellRich(outerFragment.wysiwyg.querySelector("tbody td"), "- item");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
    });
    await cells.first().click();
    await page.keyboard.press("End");
    for (let index = 0; index < 5; index++) await page.keyboard.press("Enter");
    const paragraphCount = await cells.first().locator('.table__cell-editor .protyle-wysiwyg > .p').count();
    assert.ok(paragraphCount >= 2, "several Enter presses create empty paragraphs");
    const paragraphHeight = (await cells.first().boundingBox()).height;
    await page.keyboard.press("Escape");
    assert.ok(Math.abs((await cells.first().boundingBox()).height - paragraphHeight) < 2,
        "empty paragraphs retain their line boxes in cell preview");
    await cells.first().click();
    await expect(cells.first().locator('.table__cell-editor .protyle-wysiwyg > .p')).toHaveCount(paragraphCount);
    assert.ok(Math.abs((await cells.first().boundingBox()).height - paragraphHeight) < 2,
        "reopening a cell with empty paragraphs keeps its height");
    await page.keyboard.press("Escape");
    console.log("PASS: empty paragraphs after a list survive closing and reopening the cell");
    await page.evaluate(() => {
        outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| | target |\n\n" + "below\n\n".repeat(15));
        outerFragment.protyle.contentElement.style.cssText = "height:400px;overflow:auto";
        cellTest.setTableCellRich(outerFragment.wysiwyg.querySelector("tbody td"), "- item");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
        outerFragment.protyle.contentElement.scrollTop = 0;
    });
    await cells.first().click();
    await page.keyboard.press("End");
    const scrollBefore = await page.evaluate(() => {
        window.cellScrollRequests = [];
        window.originalCellTestScroll = Element.prototype.scroll;
        Element.prototype.scroll = function (...args) {
            if (this.closest(".table__cell-editor")) window.cellScrollRequests.push(args);
            return window.originalCellTestScroll.apply(this, args);
        };
        return {top: outerFragment.protyle.contentElement.scrollTop, page: window.scrollY};
    });
    await page.keyboard.press("Enter");
    await page.keyboard.type("next");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Shift+Enter");
    const scrollAfter = await page.evaluate(() => {
        Element.prototype.scroll = window.originalCellTestScroll;
        return {top: outerFragment.protyle.contentElement.scrollTop, page: window.scrollY, requests: window.cellScrollRequests};
    });
    assert.deepEqual(scrollAfter, {...scrollBefore, requests: []}, "visible cell edits must not scroll the document or fragment");
    await page.keyboard.press("Escape");
    await page.evaluate(() => outerFragment.protyle.contentElement.removeAttribute("style"));
    console.log("PASS: list Enter and soft breaks in a visible cell do not cause unintended scrolling");
    console.log("PASS: rich cell Escape preserves undo and redo; clicking hides owner and cell selection toolbars");
    for (const fixture of ["plain", "- item", "> quote", "## heading\n\n- item\n  - nested\n\nlast"]) {
        for (const action of ["type", "paste", "text", "backspace"]) {
            await page.evaluate(fixture => {
                outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| | target |");
                cellTest.setTableCellRich(outerFragment.wysiwyg.querySelector("tbody td"), fixture);
                cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
            }, fixture);
            await cells.first().click();
            const editable = cells.first().locator('.table__cell-editor .p > [contenteditable="true"]').first();
            await editable.click();
            await page.keyboard.press("End");
            for (let index = 0; index < 4; index++) await page.keyboard.press("Shift+Enter");
            const before = await editable.textContent();
            const height = (await cells.first().boundingBox()).height;
            if (action === "type") await page.keyboard.type("1");
            if (action === "text") await page.keyboard.insertText("测试");
            if (action === "backspace") await page.keyboard.press("Backspace");
            if (action === "paste") {
                await editable.evaluate(element => {
                    const data = new DataTransfer();
                    data.setData("text/plain", "pasted");
                    element.dispatchEvent(new ClipboardEvent("paste", {clipboardData: data, bubbles: true, cancelable: true}));
                });
            }
            const readText = () => cells.first().locator('.p > [contenteditable]').first().textContent();
            // 输入后的末尾占位换行由浏览器维护，只比较可见内容及其前面的软换行。
            const expectedText = before.trimEnd() + "\n".repeat(4) +
                (action === "type" ? "1" : action === "text" ? "测试" : "pasted");
            if (action === "backspace") {
                await expect.poll(async () => ((await readText()).match(/\n/g) || []).length).toBe(4);
            } else {
                await expect.poll(async () => (await readText()).trimEnd(), `${fixture}: ${action}`).toBe(expectedText);
            }
            if (action !== "backspace") {
                assert.ok(Math.abs((await cells.first().boundingBox()).height - height) < 2,
                    `${fixture}: ${action} after soft breaks keeps the cell height`);
            }
            const text = await readText();
            await cells.nth(1).click();
            assert.equal(await readText(), text);
            await cells.first().click();
            assert.equal(await readText(), text);
            await page.keyboard.press("Escape");
        }
    }
    console.log("PASS: typing, text insertion, paste and backspace preserve cell soft breaks across reopening");
    await cells.first().click();
    await page.evaluate(() => {
        window.globalCellKeys = [];
        window.outerCellKeys = [];
        window.cellKeyAbort = new AbortController();
        outerFragment.wysiwyg.addEventListener("keydown", event => window.outerCellKeys.push(event.key),
            {signal: window.cellKeyAbort.signal});
        window.addEventListener("keydown", event => {
            for (const name of ["config", "globalSearch"]) {
                if (cellTest.matchHotKey(window.siyuan.config.keymap.general[name], event)) {
                    window.globalCellKeys.push(name);
                    event.preventDefault();
                }
            }
        }, {signal: window.cellKeyAbort.signal});
    });
    await page.keyboard.press("Alt+p");
    await page.keyboard.press("Control+p");
    assert.deepEqual(await page.evaluate(() => window.globalCellKeys), ["config", "globalSearch"]);
    assert.deepEqual(await page.evaluate(() => window.outerCellKeys), []);
    await page.evaluate(() => {
        window.siyuan.config.keymap.general.config.custom = "⌥O";
    });
    await page.keyboard.press("Alt+o");
    assert.deepEqual(await page.evaluate(() => window.globalCellKeys), ["config", "globalSearch", "config"]);
    await page.evaluate(() => {
        window.cellKeyAbort.abort();
        window.siyuan.config.keymap.general.config.custom = cellTest.Constants.SIYUAN_KEYMAP.general.config.custom;
    });
    await page.keyboard.press("Escape");
    console.log("PASS: cell global shortcuts and custom bindings reach global listeners without reentering the outer editor");
    for (const fixture of ["", "plain", "- item", "> quote"]) {
        await page.evaluate(fixture => {
            outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| | target |");
            if (fixture) cellTest.setTableCellRich(outerFragment.wysiwyg.querySelector("tbody td"), fixture);
            cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
            window.cellMenuItems = [];
            window.cellMenuOpened = false;
        }, fixture);
        await cells.first().click();
        const edit = cells.first().locator('.table__cell-editor .p > [contenteditable="true"]').first();
        await edit.click({button: "right"});
        await expect.poll(() => page.evaluate(() => window.cellMenuOpened)).toBe(true);
        const menuIds = await page.evaluate(() => window.cellMenuItems.map(el => el.dataset.id));
        assert.ok(menuIds.includes("insertRowAbove"), `${fixture}: missing table row menu: ${menuIds}`);
        assert.ok(menuIds.includes("insertColumnRight"), `${fixture}: missing table column menu`);
        await page.evaluate(() => window.cellMenuItems.find(el => el.dataset.id === "insertRowAbove").click());
        await expect(cells).toHaveCount(4);
        await expect(cells.nth(2)).toContainText(fixture.replace(/^[->] /, ""));
        await page.keyboard.press("Control+z");
        await expect(cells).toHaveCount(2);
        await page.keyboard.press("Escape");
    }
    console.log("PASS: editing empty, plain, list and quote cells exposes table menus with undoable row insertion");
    for (const [rich, layout] of [[false, "auto"], [true, "auto"], [false, "fixed"], [true, "fixed"]]) {
        await page.evaluate(({rich, layout}) => {
            outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| 111111111111111111111111111111 | target |");
            const table = outerFragment.wysiwyg.querySelector("table");
            table.style.cssText = `table-layout:${layout};width:${layout === "fixed" ? "200px" : "max-content"}`;
            table.querySelectorAll("col").forEach(col => col.style.cssText = "width:100px;min-width:0");
            if (rich) cellTest.setTableCellRich(table.querySelector("tbody td"), "- 111111111111111111111111111111");
            cellTest.renderTableCellRichElements(table);
        }, {rich, layout});
        const previewSize = await measure(cells.first());
        await cells.first().click();
        assert.deepEqual(await measure(cells.first()), previewSize, "fixed-width cell keeps its wrapping when editing starts");
        await cells.nth(1).click();
        assert.deepEqual(await measure(cells.first()), previewSize, "fixed-width cell keeps its wrapping when editing ends");
        await page.keyboard.press("Escape");
    }
    console.log("PASS: plain and rich cells keep wrapping across editing transitions in auto and fixed table layouts");
    await page.evaluate(() => {
        outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| | target |\n\n- body\n  - nested");
        cellTest.setTableCellRich(outerFragment.wysiwyg.querySelector("tbody td"), "- cell\n  - nested");
        cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
    });
    const listInsets = () => page.evaluate(() => {
        const cell = outerFragment.wysiwyg.querySelector("tbody td");
        const body = outerFragment.wysiwyg.querySelector(":scope > .list");
        const cellList = cell.querySelector(".list");
        const markerX = list => {
            const rect = list.querySelector(".protyle-action").getBoundingClientRect();
            return rect.left + rect.width / 2;
        };
        const border = parseFloat(getComputedStyle(cell).borderLeftWidth);
        return {cell: markerX(cellList) - cell.getBoundingClientRect().left - border,
            body: markerX(body) - body.getBoundingClientRect().left,
            nested: cellList.querySelector(".list").getBoundingClientRect().left - cellList.getBoundingClientRect().left};
    });
    const previewInsets = await listInsets();
    assert.ok(Math.abs(previewInsets.cell - previewInsets.body) < 1, "cell list marker inset matches body list");
    assert.equal(previewInsets.nested, 34, "nested list indentation is preserved");
    await cells.first().click();
    assert.deepEqual(await listInsets(), previewInsets, "list spacing stays consistent while editing");
    await page.keyboard.press("Escape");
    console.log("PASS: cell lists match body marker insets and retain nested indentation");
    await page.addStyleTag({content: ".protyle-wysiwyg [data-node-id] {text-align:justify}"});
    for (const align of ["left", "center", "right"]) {
        for (const content of ["text", "first\n\nlast", "## heading\n\nfirst", "- item\n  - nested"]) {
            await page.evaluate(({align, content}) => {
                outerFragment.setMarkdown("| A | B |\n| --- | --- |\n| | target |");
                const cell = outerFragment.wysiwyg.querySelector("tbody td");
                cell.style.textAlign = align;
                cell.style.width = "240px";
                cellTest.setTableCellRich(cell, content);
                cellTest.renderTableCellRichElements(outerFragment.wysiwyg);
            }, {align, content});
            const alignment = () => cells.first().evaluate(cell => {
                const text = cell.querySelector('.p > [contenteditable]');
                const range = document.createRange();
                range.selectNodeContents(text);
                const rect = range.getBoundingClientRect();
                return {x: rect.x, width: rect.width, align: getComputedStyle(text).textAlign};
            });
            const before = await alignment();
            assert.equal(before.align, align);
            if (!content.startsWith("-")) {
                const bounds = await cells.first().evaluate(cell => {
                    const rect = cell.getBoundingClientRect();
                    const style = getComputedStyle(cell);
                    return {left: rect.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth),
                        right: rect.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)};
                });
                const expectedX = align === "left" ? bounds.left : align === "right" ? bounds.right - before.width :
                    (bounds.left + bounds.right - before.width) / 2;
                assert.ok(Math.abs(before.x - expectedX) < 1, `${align}: paragraph uses the cell content alignment boundary`);
            }
            await cells.first().click();
            assert.deepEqual(await alignment(), before, `${align}: ${content} keeps alignment when editing`);
            await cells.nth(1).click();
            assert.deepEqual(await alignment(), before, `${align}: ${content} keeps alignment after editing`);
            await page.keyboard.press("Escape");
        }
    }
    console.log("PASS: cell alignment overrides document justification and stays consistent for paragraphs, headings and lists");
    assert.deepEqual(errors, []);
    console.log("PASS: default cell click editing, Tab/Enter navigation, soft breaks and Escape through real editor events");
    console.log("PASS: header, ordinary and empty cell dimensions remain unchanged when editing starts and ends");
    console.log("PASS: Markdown list input, nested list Tab, rich source promotion, reopening and retention");
} finally {
    await browser.close();
}
