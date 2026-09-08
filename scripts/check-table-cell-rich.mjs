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
    await page.setContent('<style>.fn__none {display:none!important} [contenteditable=true] {white-space:break-spaces} .protyle-wysiwyg {min-height:24px}</style><div id="sidebar"></div><div id="host"></div>');
    await page.addStyleTag({content: appRequire("sass").compile(path.join(app, "src/assets/scss/base.scss"),
        {logger: {warn() {}, debug() {}}}).css});
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
    await page.keyboard.press("Escape");
    assert.deepEqual(await measure(cells.last()), blankRowSize, "empty row size when closing the editor");
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
    assert.deepEqual(errors, []);
    console.log("PASS: default cell click editing, Tab/Enter navigation, soft breaks and Escape through real editor events");
    console.log("PASS: header, ordinary and empty cell dimensions remain unchanged when editing starts and ends");
    console.log("PASS: Markdown list input, nested list Tab, rich source promotion, reopening and retention");
} finally {
    await browser.close();
}
