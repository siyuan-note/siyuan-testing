import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {PRIMARY_MODIFIER, REDO_SHORTCUT, UNDO_SHORTCUT} from "./helpers/keyboard";
import {assertValidTableDOM, readOrdinaryTable} from "./helpers/tableAssertions";
import {getDocumentEditor} from "./helpers/testNotebook";

const ROW_COUNT = 600;
const rowKey = (index: number) => `Virtual-row-${String(index).padStart(4, "0")}`;
const values = () => Array.from({length: ROW_COUNT}, (_, index) => [rowKey(index), `Value ${index}`, `Link ${index}`]);
const markdown = () => ["| Key | Value | Link |", "| --- | --- | --- |",
    ...values().map((row, index) => `| ${row[0]} | ${row[1]} | [${row[2]}](https://example.com/${index}) |`),
].join("\n");
const expectedRows = () => [["Key", "Value", "Link"], ...values()];
const rowAt = (table: Locator, index: number) => table.locator("tbody > tr").filter({hasText: rowKey(index)});
const fragment = (table: Locator) => table.locator(".table__cell-editor .protyle-wysiwyg");

const expectVirtual = async (table: Locator) => {
    await expect(table.locator("table")).toHaveAttribute("data-sy-table-virtual-id");
    await expect.poll(() => table.locator("tbody > tr").count()).toBeLessThan(256);
    await assertValidTableDOM(table);
};

const scrollToRow = async (page: Page, table: Locator, index: number) => {
    const position = await table.evaluate((element, {index, count}) => {
        const viewport = element.closest(".protyle-content")!.getBoundingClientRect();
        const body = element.querySelector("tbody")!.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return {
            x: Math.max(rect.left, viewport.left) + 80,
            y: viewport.top + viewport.height / 2,
            delta: body.top + body.height * (index + 0.5) / count - viewport.top - viewport.height / 2,
        };
    }, {index, count: ROW_COUNT});
    await page.mouse.move(position.x, position.y);
    await page.mouse.wheel(0, position.delta || 1);
    await expect(rowAt(table, index)).toBeVisible();
    await expectVirtual(table);
};

const enterCell = async (page: Page, table: Locator, index: number, column = 1) => {
    const cell = rowAt(table, index).locator("td").nth(column);
    await cell.click({position: {x: 3, y: 3}});
    await expect(cell.locator(".table__cell-editor")).toBeVisible();
    // macOS 的 End 滚动到文档末尾，使用平台对应的行尾快捷键定位光标。
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await expect.poll(() => fragment(table).evaluate(element => {
        const selection = getSelection();
        if (!selection?.isCollapsed || !element.contains(selection.anchorNode)) {
            return false;
        }
        const trailing = document.createRange();
        trailing.selectNodeContents(element);
        trailing.setStart(selection.anchorNode!, selection.anchorOffset);
        return trailing.toString().replace(/\u200b/g, "") === "";
    })).toBe(true);
    await expectVirtual(table);
    return cell;
};

const activeCell = (table: Locator) => fragment(table).evaluate(element => {
    const cell = element.closest("td, th") as HTMLTableCellElement;
    const row = cell.parentElement as HTMLTableRowElement;
    const selection = getSelection();
    return {
        key: row.cells[0].textContent,
        column: cell.cellIndex,
        text: element.textContent?.replace(/\u200b/g, ""),
        hasCaret: !!selection?.isCollapsed && element.contains(selection.anchorNode),
    };
});

test.describe("large table virtualization", () => {
    test("saves every cell edit without mounting offscreen rows or losing unchanged content", async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument("Virtual Table Input E2E", markdown());
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        await scrollToRow(page, table, 400);
        await enterCell(page, table, 400);
        const samples = await table.evaluateHandle(element => {
            const state = {rows: [] as number[], controller: new AbortController()};
            // 在捕获阶段记录输入时的实际行数，避免事后重新虚拟化掩盖瞬间展开整表的问题。
            element.addEventListener("beforeinput", () => state.rows.push(element.querySelector("table")!.rows.length),
                {capture: true, signal: state.controller.signal});
            return state;
        });
        const expected = expectedRows();
        try {
            for (const text of ["x", "y", "z"]) {
                await page.keyboard.type(text);
                expected[401][1] += text;
                await expectVirtual(table);
                await expect.poll(() => activeCell(table)).toEqual({
                    key: rowKey(400), column: 1, text: expected[401][1], hasCaret: true,
                });
                await expect.poll(() => readOrdinaryTable(siyuanAPI, docID), {timeout: 30000}).toEqual(expected);
            }
            const counts = await samples.evaluate(state => state.rows);
            expect(counts).toHaveLength(3);
            expect(Math.max(...counts), "no keystroke materializes the complete table").toBeLessThan(256);
        } finally {
            await samples.evaluate(state => state.controller.abort());
            await samples.dispose();
        }
        await page.keyboard.press("Escape");
        await page.reload();
        const reloaded = (await getDocumentEditor(page, docID)).locator(':scope > [data-type="NodeTable"]');
        await scrollToRow(page, reloaded, 400);
        await expect(rowAt(reloaded, 400).locator("td").nth(1)).toHaveText("Value 400xyz");
        await expect.poll(() => readOrdinaryTable(siyuanAPI, docID), {timeout: 30000}).toEqual(expected);
    });

    test("restores the logical cell and caret with undo and redo after offscreen rows", async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument("Virtual Table Undo E2E", markdown());
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        await scrollToRow(page, table, 400);
        await enterCell(page, table, 400);
        await page.keyboard.type("x");
        const changed = expectedRows();
        changed[401][1] += "x";
        await expectVirtual(table);
        await expect.poll(() => readOrdinaryTable(siyuanAPI, docID), {timeout: 30000}).toEqual(changed);
        for (const [shortcut, text] of [[UNDO_SHORTCUT, "Value 400"], [REDO_SHORTCUT, "Value 400x"],
            [UNDO_SHORTCUT, "Value 400"]]) {
            await page.keyboard.press(shortcut);
            await expect.poll(() => activeCell(table), {timeout: 30000}).toEqual({
                key: rowKey(400), column: 1, text, hasCaret: true,
            });
            await expect.poll(() => fragment(table).evaluate(element => {
                const selection = getSelection()!;
                const range = document.createRange();
                range.selectNodeContents(element);
                range.setEnd(selection.anchorNode!, selection.anchorOffset);
                return range.toString().replace(/\u200b/g, "");
            })).toBe(text);
        }
        // 在恢复后的光标处输入，验证实际插入位置而非仅检查选区元数据。
        await page.keyboard.type("q");
        const final = expectedRows();
        final[401][1] += "q";
        await expect.poll(() => readOrdinaryTable(siyuanAPI, docID), {timeout: 30000}).toEqual(final);
        await page.keyboard.press("Escape");
        await page.reload();
        const reloaded = (await getDocumentEditor(page, docID)).locator(':scope > [data-type="NodeTable"]');
        await scrollToRow(page, reloaded, 400);
        await expect(rowAt(reloaded, 400).locator("td").nth(1)).toHaveText("Value 400q");
    });

    test("keeps browser composition and cell-local copy, cut, and paste virtualized", async ({
        page, context, baseURL, createTestDocument, siyuanAPI,
    }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write", "local-network-access"], {
            origin: new URL(baseURL!).origin,
        });
        const {docID, editor} = await createTestDocument("Virtual Table IME Clipboard E2E", markdown());
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        await scrollToRow(page, table, 400);
        await enterCell(page, table, 400);
        const cdp = await context.newCDPSession(page);
        try {
            // 由浏览器输入通道产生组合输入事件，覆盖内嵌编辑器与外层捕获监听器的交接。
            await cdp.send("Input.imeSetComposition", {text: "中", selectionStart: 1, selectionEnd: 1});
            await expect(fragment(table)).toContainText("Value 400中");
            await expectVirtual(table);
            expect(await readOrdinaryTable(siyuanAPI, docID)).toEqual(expectedRows());
            await cdp.send("Input.imeSetComposition", {text: "中文", selectionStart: 2, selectionEnd: 2});
            await expect(fragment(table)).toContainText("Value 400中文");
            await expectVirtual(table);
            await cdp.send("Input.insertText", {text: "中文"});
        } finally {
            await cdp.detach();
        }
        const changed = expectedRows();
        changed[401][1] += "中文";
        await expect.poll(() => readOrdinaryTable(siyuanAPI, docID), {timeout: 30000}).toEqual(changed);
        await expectVirtual(table);
        await page.keyboard.press(`${PRIMARY_MODIFIER}+A`);
        await expect.poll(() => page.evaluate(() => getSelection()?.toString().replace(/\u200b/g, ""))).toBe("Value 400中文");
        await expectVirtual(table);
        await page.keyboard.press(`${PRIMARY_MODIFIER}+C`);
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Value 400中文");
        await expectVirtual(table);
        await page.keyboard.press(`${PRIMARY_MODIFIER}+X`);
        const cleared = expectedRows();
        cleared[401][1] = "";
        await expect.poll(() => readOrdinaryTable(siyuanAPI, docID), {timeout: 30000}).toEqual(cleared);
        await expectVirtual(table);
        await page.keyboard.press(`${PRIMARY_MODIFIER}+V`);
        await expect.poll(() => readOrdinaryTable(siyuanAPI, docID), {timeout: 30000}).toEqual(changed);
        await expectVirtual(table);
        await page.keyboard.press("Escape");
        await page.reload();
        const reloaded = (await getDocumentEditor(page, docID)).locator(':scope > [data-type="NodeTable"]');
        await scrollToRow(page, reloaded, 400);
        await expect(rowAt(reloaded, 400).locator("td").nth(1)).toHaveText("Value 400中文");
    });

    test("navigates across row chunks and appends a persisted row from the final cell", async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const {docID, editor} = await createTestDocument("Virtual Table Navigation E2E", markdown());
        const table = editor.locator(':scope > [data-type="NodeTable"]');
        await scrollToRow(page, table, 329);
        await enterCell(page, table, 329, 2);
        await page.keyboard.press("Tab");
        await expect(rowAt(table, 330).locator("td").nth(0).locator(".table__cell-editor")).toBeVisible();
        await page.keyboard.press("Shift+Tab");
        await expect(rowAt(table, 329).locator("td").nth(2).locator(".table__cell-editor")).toBeVisible();
        await page.keyboard.press("Enter");
        await expect(rowAt(table, 330).locator("td").nth(2).locator(".table__cell-editor")).toBeVisible();
        await page.keyboard.press("Escape");
        await scrollToRow(page, table, ROW_COUNT - 1);
        await enterCell(page, table, ROW_COUNT - 1, 2);
        await page.keyboard.press("Tab");
        await expect(table.locator("tbody > tr").last().locator("td").first().locator(".table__cell-editor")).toBeVisible();
        await page.keyboard.type("Added row");
        await page.keyboard.press("Escape");
        const final = [...expectedRows(), ["Added row", "", ""]];
        await expect.poll(() => readOrdinaryTable(siyuanAPI, docID), {timeout: 30000}).toEqual(final);
        await assertValidTableDOM(table);
        await page.reload();
        const reloaded = (await getDocumentEditor(page, docID)).locator(':scope > [data-type="NodeTable"]');
        await expect.poll(() => readOrdinaryTable(siyuanAPI, docID), {timeout: 30000}).toEqual(final);
        await assertValidTableDOM(reloaded);
    });
});
