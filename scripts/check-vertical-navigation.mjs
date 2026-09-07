import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {chromium} from "@playwright/test";

const app = path.resolve(fileURLToPath(new URL("../../siyuan/app", import.meta.url)));
const appRequire = createRequire(path.join(app, "package.json"));
const {build} = createRequire(appRequire.resolve("esbuild-loader"))("esbuild");
const preprocess = appRequire("ifdef-loader/preprocessor").parse;
// 在独立浏览器页面中加载真实编辑器事件处理，不启动内核或生成应用构建产物。
// 可传入提交号，用同一组按键反例检查修复前的源码。
const baseline = process.argv[2];
const reviewedFiles = new Set([
    "src/protyle/wysiwyg/verticalTarget.ts", "src/protyle/wysiwyg/verticalCaret.ts",
    "src/protyle/wysiwyg/verticalNavigation.ts", "src/protyle/wysiwyg/keydown.ts",
    "src/protyle/render/av/keydown.ts", "src/protyle/render/av/focus.ts", "src/protyle/render/tabsRender.ts",
    "src/protyle/wysiwyg/calloutCaret.ts",
]);
const bundle = await build({
    stdin: {
        contents: `export {WYSIWYG as Wysiwyg} from "./src/protyle/wysiwyg";
export * from "./src/protyle/wysiwyg/verticalNavigation";
export * from "./src/protyle/wysiwyg/verticalCaret";
export * from "./src/protyle/render/av/selectionState";
export {tabsRender, destroyTabsRender} from "./src/protyle/render/tabsRender";
export {Constants} from "./src/constants";`,
        resolveDir: app,
    },
    bundle: true, write: false, format: "iife", globalName: "navigationTest",
    logLevel: "error", alias: {path: appRequire.resolve("path-browserify")},
    platform: "browser", define: {SIYUAN_VERSION: '"test"', NODE_ENV: '"production"',
        "process.env.NODE_ENV": '"production"'},
    plugins: [{name: "platform", setup(builder) {
        if (baseline) {
            builder.onResolve({filter: /\/calloutCaret$/}, () => ({path: path.join(app, "src/protyle/wysiwyg/calloutCaret.ts")}));
        }
        builder.onLoad({filter: /\.ts$/}, async args => ({
            contents: preprocess(baseline && reviewedFiles.has(path.relative(app, args.path).replaceAll("\\", "/")) ?
                execFileSync("git", ["show", `${baseline}:app/${path.relative(app, args.path).replaceAll("\\", "/")}`],
                    {cwd: app, encoding: "utf8"}) : await readFile(args.path, "utf8"),
            {MOBILE: false, BROWSER: true}, false, true)
                .replace(/import \* as dayjs from "dayjs";/g, 'import dayjs from "dayjs";'),
            loader: "ts",
        }));
    }}],
});
const browser = await chromium.launch({channel: "chrome", headless: true});
const page = await browser.newPage({viewport: {width: 1280, height: 900}});
const errors = [];
page.on("pageerror", error => errors.push(error.stack));
try {
    await page.setContent(`<style>
body {margin:40px;font:16px/24px sans-serif} .fn__none {display:none!important}
.protyle-wysiwyg [data-node-id] {position:relative;min-height:24px}
[contenteditable=true] {white-space:break-spaces;outline:none}
.sb {display:flex;flex-direction:column} [fold="1"] {height:38px;overflow:hidden!important}
.p {padding:3px} .tab-item-info {display:block} .av__cursor {height:1px}
.av__cell {height:24px} .tabs-title-editor {display:block!important}
.tabs[data-tabs-ready=true] > .tab-item > .tab-item-info {display:none}
.tab-item[data-tabs-hidden=true] {display:none}
</style><div id="host"></div>`);
    await page.addScriptTag({content: bundle.outputFiles[0].text});
    await page.evaluate(() => {
        const blank = () => Object.assign(document.createElement("div"), {className: "fn__none"});
        const noop = () => {};
        window.siyuan = {
            config: {editor: {fontSize: 16}, system: {container: "browser"}, appearance: {},
                keymap: structuredClone(navigationTest.Constants.SIYUAN_KEYMAP)},
            languages: {}, menus: {menu: {element: blank(), remove: noop}}, storage: {}, dialogs: [],
            layout: {}, blockPanels: [], mobile: undefined,
        };
        const toolbar = {element: blank(), subElement: blank(), isMultiSelectMode: () => false,
            render: noop, hide: noop};
        const host = document.querySelector("#host");
        const protyle = {element: host, contentElement: host, options: {action: [], render: {}}, lite: true,
            selectElement: blank(), toolbar, hint: {element: blank(), render: noop},
            block: {}, scroll: {}, undo: {recordFirstCaretRange: noop}, app: {plugins: []}};
        protyle.wysiwyg = new navigationTest.Wysiwyg(protyle);
        host.append(protyle.wysiwyg.element);
        window.testProtyle = protyle;
        window.placeCaret = (selector, offset = 0) => {
            const element = protyle.wysiwyg.element.querySelector(selector);
            const range = document.createRange();
            range.setStart(element.firstChild || element, offset);
            range.collapse(true);
            element.focus();
            getSelection().removeAllRanges();
            getSelection().addRange(range);
        };
    });
    const paragraph = (id, text = id) => `<div class="p" data-node-id="${id}" data-type="NodeParagraph"><div contenteditable="true">${text}</div></div>`;
    const setHTML = async html => page.evaluate(html => {
        navigationTest.destroyTabsRender(testProtyle.wysiwyg.element);
        navigationTest.resetVerticalNavigation(testProtyle.wysiwyg.element);
        testProtyle.wysiwyg.element.innerHTML = html;
    }, html);
    const anchor = () => page.evaluate(() => {
        const node = getSelection().anchorNode;
        return (node.nodeType === 1 ? node : node.parentElement).closest("[data-node-id]")?.dataset.nodeId;
    });
    await setHTML(`<div class="sb" data-node-id="folded" data-type="NodeSuperBlock" fold="1">${paragraph("first")}${paragraph("clipped")}</div>${paragraph("after")}`);
    await page.evaluate(() => placeCaret('[data-node-id="after"] > div'));
    await page.keyboard.press("ArrowUp");
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('[data-node-id="folded"]').evaluate(element =>
        element.classList.contains("protyle-wysiwyg--navigation") && element.contains(getSelection().anchorNode)), true);
    assert.notEqual(await anchor(), "clipped");
    await page.keyboard.press("ArrowDown");
    assert.equal(await anchor(), "after");
    console.log("PASS folded container navigation after keyup");

    for (const [className, type, style] of [
        ["sb", "NodeSuperBlock", ""], ["sb", "NodeSuperBlock", "flex-direction:row"],
        ["bq", "NodeBlockquote", ""], ["callout", "NodeCallout", ""], ["li", "NodeListItem", ""],
    ]) {
        const contents = paragraph("first") + paragraph("clipped");
        await setHTML(`${paragraph("before")}<div class="${className}" data-node-id="folded" data-type="${type}" fold="1" style="${style}">${className === "callout" ? `<div class="callout-content">${contents}</div>` : contents}</div>${paragraph("after")}`);
        for (const [source, enter, leave, destination] of [
            ["after", "ArrowUp", "ArrowUp", "before"], ["before", "ArrowDown", "ArrowDown", "after"],
        ]) {
            await page.evaluate(source => placeCaret(`[data-node-id="${source}"] > div`), source);
            await page.keyboard.press(enter);
            assert.equal(await page.locator('[data-node-id="folded"]').evaluate(element =>
                element.classList.contains("protyle-wysiwyg--navigation") && element.contains(getSelection().anchorNode)), true);
            await page.keyboard.press(leave);
            assert.equal(await anchor(), destination);
            assert.deepEqual(errors, []);
        }
        console.log(`PASS folded ${className} ${style} from both sides`);
    }

    await setHTML(`${paragraph("source")}<div style="height:24px;overflow:hidden">${paragraph("visible")}${paragraph("hidden")}</div>`);
    await page.evaluate(() => placeCaret('[data-node-id="source"] > div'));
    assert.equal(await page.evaluate(() => navigationTest.focusEditableAtGoalX(
        document.querySelector('[data-node-id="hidden"] > div'), "up", 60)), false);
    assert.equal(await anchor(), "source");
    console.log("PASS clipped target failure preserves Selection");
    await setHTML(`${paragraph("source")}<div style="clip-path:inset(0 0 50% 0)">${paragraph("visible")}${paragraph("hidden")}</div>`);
    await page.evaluate(() => placeCaret('[data-node-id="source"] > div'));
    assert.equal(await page.evaluate(() => navigationTest.focusEditableAtGoalX(
        document.querySelector('[data-node-id="hidden"] > div'), "up", 60)), false);
    assert.equal(await anchor(), "source");
    console.log("PASS clip-path hit-test failure preserves Selection");

    await setHTML(paragraph("last", "abcdef"));
    await page.evaluate(() => placeCaret('[data-node-id="last"] > div', 3));
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => getSelection().anchorOffset), 6);
    console.log("PASS document terminal line keeps its end-position behavior");

    await setHTML(`${paragraph("blank", "A\n\n")}${paragraph("after")}`);
    await page.evaluate(() => placeCaret('[data-node-id="blank"] > div'));
    await page.keyboard.press("ArrowDown");
    assert.equal(await anchor(), "blank");
    await page.keyboard.press("ArrowDown");
    assert.equal(await anchor(), "after");
    console.log("PASS soft blank line remains navigable");

    for (const kind of ["cell", "row", "gallery"]) {
        const selected = kind === "gallery" ? '<div class="av__gallery-item av__gallery-item--select" data-id="r">item</div>' :
            `<div class="av__row ${kind === "row" ? "av__row--select" : ""}" data-id="r"><div class="av__firstcol"><svg><use></use></svg></div><div class="av__cell ${kind === "cell" ? "av__cell--select" : ""}" data-col-id="c">cell</div></div>`;
        await setHTML(`<div class="av" data-node-id="database" data-type="NodeAttributeView" data-av-type="${kind === "gallery" ? "gallery" : "table"}" contenteditable="false"><div class="av__cursor" contenteditable="true"> </div><div class="av__body" data-group-id="g">${selected}</div></div>`);
        await page.evaluate(kind => {
            const av = testProtyle.wysiwyg.element.querySelector(".av");
            if (kind === "cell") {
                const point = {groupID: "g", rowID: "r", colID: "c"};
                navigationTest.setAVCellSelection(av, {anchor: point, focus: {...point}, cells: [
                    {...point, rowIndex: 0, colIndex: 0, column: {id: "c", type: "text"},
                        cell: {id: "value", value: {type: "text", text: {content: "cell"}}}},
                ]});
            } else {
                navigationTest.setAVItemAnchorState(av, "r", "g");
            }
            placeCaret(".av__cursor");
        }, kind);
        for (const key of ["ArrowDown", "ArrowUp"]) {
            await page.keyboard.press(key);
            assert.deepEqual(errors, []);
            assert.equal(await anchor(), "database");
            assert.equal(await page.evaluate(kind => {
                const av = testProtyle.wysiwyg.element.querySelector(".av");
                return kind === "cell" ? !!navigationTest.getAVCellSelection(av) && !!av.querySelector(".av__cell--select") :
                    !!navigationTest.getAVItemSelection(av) && !!av.querySelector(".av__row--select, .av__gallery-item--select");
            }, kind), true);
        }
        console.log(`PASS database ${kind} selection at both document boundaries after keyup`);
        await page.evaluate(html => testProtyle.wysiwyg.element.insertAdjacentHTML("beforeend", html), paragraph("av-after"));
        await page.keyboard.press("ArrowDown");
        assert.equal(await anchor(), "av-after");
        assert.equal(await page.evaluate(() => {
            const av = testProtyle.wysiwyg.element.querySelector(".av");
            return !!navigationTest.getAVCellSelection(av) || !!navigationTest.getAVItemSelection(av) ||
                !!av.querySelector(".av__cell--select, .av__row--select, .av__gallery-item--select");
        }), false);
        assert.deepEqual(errors, []);
        console.log(`PASS database ${kind} clears source selection only after leaving`);
    }

    for (const outside of [false, true]) {
        await setHTML(`${outside ? paragraph("before-tabs") : ""}<div class="tabs" data-node-id="tabs" data-type="NodeTabs" tabs-active-id="item"><div class="tab-item" data-node-id="item" data-type="NodeTabItem" data-tabs-hidden="false" data-tabs-editing="true"><div class="tab-item-info callout-info" contenteditable="false"><span class="tab-item-title callout-title" contenteditable="true">Title</span></div><div class="tab-item-content">${paragraph("tab-content")}</div></div></div>${outside ? paragraph("after-tabs") : ""}`);
        await page.evaluate(() => {
            testProtyle.wysiwyg.element.querySelector(".tab-item").dataset.tabsEditing = "true";
            navigationTest.tabsRender(testProtyle.wysiwyg.element, {readonly: () => false});
            placeCaret(".tab-item-title");
        });
        await page.keyboard.press("ArrowDown");
        assert.deepEqual(errors, []);
        assert.equal(await anchor(), "tab-content");
        await page.keyboard.press("ArrowUp");
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => {
            const node = getSelection().anchorNode;
            return !!(node.nodeType === 1 ? node : node.parentElement).closest(".tab-item-title");
        }), true);
        if (!outside) {
            await page.keyboard.press("ArrowUp");
            assert.equal(await anchor(), "item");
        }
        console.log(`PASS Tabs title/content round trip after keyup (outside=${outside})`);
    }
    await setHTML(`<div class="callout" data-node-id="outer" data-type="NodeCallout"><div class="callout-info" contenteditable="false"><span class="callout-title" contenteditable="true">Outer</span></div><div class="callout-content"><div class="tabs" data-node-id="tabs" data-type="NodeTabs" tabs-active-id="item"><div class="tab-item" data-node-id="item" data-type="NodeTabItem" data-tabs-hidden="false"><div class="tab-item-info callout-info" contenteditable="false"><span class="tab-item-title callout-title" contenteditable="true">Inner</span></div><div class="tab-item-content">${paragraph("nested-content")}</div></div></div></div></div>`);
    await page.evaluate(() => {
        document.querySelector(".tab-item").dataset.tabsEditing = "true";
        navigationTest.tabsRender(testProtyle.wysiwyg.element, {readonly: () => false});
        placeCaret(".tab-item-title");
    });
    await page.keyboard.press("ArrowDown");
    assert.equal(await anchor(), "nested-content");
    await page.keyboard.press("ArrowUp");
    assert.equal(await anchor(), "item");
    console.log("PASS nested Tabs uses its own title owner");
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
}
