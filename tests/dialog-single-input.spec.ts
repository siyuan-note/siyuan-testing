import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openBlockMenu} from "./helpers/blockMenu";
import {showFileTree} from "./helpers/runtime";
import {getDocumentEditor, ITestDocument} from "./helpers/testNotebook";

interface ISyNode {
    ID?: string;
    Data?: string;
    Type?: string;
    Properties?: Record<string, string>;
    Children?: ISyNode[];
}

const flatten = (node: ISyNode): ISyNode[] => [node, ...(node.Children || []).flatMap(flatten)];

const openRename = async (page: Page, document: ITestDocument) => {
    const restoreTree = await showFileTree(page);
    try {
        const tree = page.locator(".sy__file:visible");
        const item = tree.locator(`li[data-type="navigation-file"][data-node-id="${document.docID}"]`);
        if (!await item.isVisible()) {
            const root = tree.locator(`ul[data-url="${document.notebookID}"] > li[data-type="navigation-root"]`);
            if (!await root.locator(".b3-list-item__arrow--open").isVisible()) {
                await root.locator(":scope > .b3-list-item__toggle").click();
            }
        }
        await item.locator(":scope > .b3-list-item__text").click({button: "right"});
        await page.locator('#commonMenu:not(.fn__none) [data-id="rename"]').click();
        const dialog = page.locator('[data-key="dialog-rename"]');
        await expect(dialog.locator(".b3-dialog__container")).toBeVisible();
        return {dialog, restoreTree: async () => {
            if (await dialog.count()) {
                await dialog.locator("input").press("Escape");
                await expect(dialog).toHaveCount(0);
            }
            await restoreTree();
        }};
    } catch (error) {
        await restoreTree();
        throw error;
    }
};

const expectInputReady = async (input: Locator, value: string) => {
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(value);
    await expect(input).toHaveAttribute("spellcheck", "false");
    expect(await input.evaluate((element: HTMLInputElement) =>
        [element.selectionStart, element.selectionEnd])).toEqual([0, value.length]);
};

test.describe("single-input dialogs", () => {
    test.beforeEach(async ({fullEntryVisibility}) => {
        // 使用完整菜单配置，测试结束后由 fixture 恢复。
        void fullEntryVisibility;
    });

    test("ignores composing Enter and saves a document title with ordinary Enter", async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const document = await createTestDocument("Input Dialog IME");
        const {dialog, restoreTree} = await openRename(page, document);
        const input = dialog.locator("input");
        const titles: string[] = [];
        page.on("request", request => {
            if (new URL(request.url()).pathname === "/api/filetree/renameDoc") {
                titles.push(request.postDataJSON().title);
            }
        });
        try {
            await expectInputReady(input, document.title);
            const title = `${document.title} 中文`;
            // 合成组合事件验证应用事件处理；操作系统候选窗口仍需手动回归。
            await input.dispatchEvent("compositionstart", {data: ""});
            await input.fill(title);
            await input.dispatchEvent("keydown", {key: "Enter", code: "Enter", isComposing: true});
            await expect(dialog.locator(".b3-dialog__container")).toBeVisible();
            expect(titles).toEqual([]);
            await input.dispatchEvent("compositionend", {data: "中文"});
            const saved = page.waitForResponse("**/api/filetree/renameDoc");
            await input.press("Enter");
            expect((await (await saved).json()).code).toBe(0);
            await expect(dialog).toHaveCount(0);
            expect(titles).toEqual([title]);
            await expect.poll(async () =>
                (await siyuanAPI.readDocument<ISyNode>(document.docID)).Properties?.title).toBe(title);
        } finally {
            await restoreTree();
        }
    });

    test("keeps an invalid name open and accepts a corrected name", async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const document = await createTestDocument("Input Dialog Validation");
        const {dialog, restoreTree} = await openRename(page, document);
        try {
            const input = dialog.locator("input");
            await input.fill("invalid\tname");
            await input.press("Enter");
            await expect(dialog.locator(".b3-dialog__container")).toBeVisible();
            await expect(input).toHaveValue("invalid\tname");
            const message = await page.evaluate(() => window.siyuan.languages.fileNameRule);
            await expect(page.locator("#message")).toContainText(message);
            expect((await siyuanAPI.readDocument<ISyNode>(document.docID)).Properties?.title)
                .toBe(document.title);
            const title = `${document.title} corrected`;
            await input.fill(title);
            await dialog.locator(".b3-dialog__action .b3-button--text").click();
            await expect(dialog).toHaveCount(0);
            await expect.poll(async () =>
                (await siyuanAPI.readDocument<ISyNode>(document.docID)).Properties?.title).toBe(title);
        } finally {
            await restoreTree();
        }
    });

    for (const close of ["cancel", "Escape", "scrim"] as const) {
        test(`discards a renamed title on ${close}`, async ({page, createTestDocument, siyuanAPI}) => {
            const document = await createTestDocument(`Input Dialog Close ${close}`);
            const {dialog, restoreTree} = await openRename(page, document);
            try {
                await dialog.locator("input").fill(`${document.title} discarded`);
                if (close === "Escape") {
                    await dialog.locator("input").press("Escape");
                } else if (close === "cancel") {
                    await dialog.locator(".b3-dialog__action .b3-button--cancel").click();
                } else {
                    await dialog.locator(".b3-dialog__scrim").click({position: {x: 5, y: 5}});
                }
                await expect(dialog).toHaveCount(0);
                expect((await siyuanAPI.readDocument<ISyNode>(document.docID)).Properties?.title)
                    .toBe(document.title);
            } finally {
                await restoreTree();
            }
        });
    }

    test("waits for the asset rename response before closing and persists the new reference", async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const document = await createTestDocument("Input Dialog Async Asset", "Asset seed");
        const name = `dialog-${Date.now()}.txt`;
        const content = "Input dialog asset contents";
        const uploaded = await siyuanAPI.uploadAsset(document.docID, name, "text/plain", Buffer.from(content));
        const assetPath = uploaded.succMap[name];
        expect(assetPath).toBeTruthy();
        const paragraphID = await document.editor.locator('[data-type="NodeParagraph"]').first()
            .getAttribute("data-node-id");
        await siyuanAPI.updateBlock(paragraphID!, `[${name}](${assetPath})`);
        await page.reload();
        const editor = await getDocumentEditor(page, document.docID);
        await editor.locator(`span[data-type="a"][data-href="${assetPath}"]`).click({button: "right"});
        await page.locator('#commonMenu:not(.fn__none) [data-id="rename"]').click();
        const dialog = page.locator('[data-key="dialog-renameassets"]');
        await expect(dialog.locator(".b3-dialog__container")).toBeVisible();
        const newName = `renamed-${Date.now()}.txt`;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let received!: () => void;
        const arrived = new Promise<void>(resolve => { received = resolve; });
        // 暂停真实请求的响应，不使用计时等待模拟慢网络。
        await page.route("**/api/asset/renameAsset", async route => {
            const response = await route.fetch();
            received();
            await gate;
            await route.fulfill({response});
        });
        try {
            await dialog.locator("input").fill(newName);
            const saved = page.waitForResponse("**/api/asset/renameAsset");
            await dialog.locator("input").press("Enter");
            await arrived;
            await expect(dialog.locator(".b3-dialog__container")).toBeVisible();
            await expect(dialog.locator("input")).toHaveValue(newName);
            release();
            const response = await (await saved).json();
            expect(response.code).toBe(0);
            await expect(dialog).toHaveCount(0);
            const newPath = response.data.newPath as string;
            expect(newPath).not.toBe(assetPath);
            await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(document.docID)), {
                timeout: 30000,
            }).toContain(newPath);
            await page.reload();
            await expect((await getDocumentEditor(page, document.docID))
                .locator(`span[data-type="a"][data-href="${newPath}"]`)).toBeVisible();
            expect(await siyuanAPI.readWorkspaceText(`/data/${newPath}`)).toBe(content);
            await siyuanAPI.removeWorkspaceFile(`/data/${newPath}`);
        } finally {
            release();
            await page.unrouteAll({behavior: "wait"});
        }
    });

    for (const close of ["confirm", "cancel", "Escape"] as const) {
        test(`restores the callout text selection after ${close}`, async ({page, createTestDocument, siyuanAPI}) => {
            const document = await createTestDocument(`Input Dialog Selection ${close}`, "> [!NOTE]\n> before selected after");
            const callout = document.editor.locator('[data-type="NodeCallout"]').first();
            await expect(callout).toBeVisible();
            const blockID = await callout.getAttribute("data-node-id");
            const editable = callout.locator('.callout-content [contenteditable="true"]').first();
            const menu = await openBlockMenu(page, callout, callout.locator(".callout-info"));
            const turnInto = menu.locator('[data-id="turnInto"]').first();
            await turnInto.hover();
            const custom = turnInto.locator('[data-id="calloutCustom"]');
            await expect(custom).toBeVisible();
            // 设置非折叠选区，随后通过真实菜单打开弹窗。
            await editable.evaluate(element => {
                const text = element.firstChild;
                if (!text || text.nodeType !== Node.TEXT_NODE) {
                    throw new Error("callout text node is unavailable");
                }
                const start = text.textContent!.indexOf("selected");
                const range = element.ownerDocument.createRange();
                range.setStart(text, start);
                range.setEnd(text, start + "selected".length);
                const selection = getSelection()!;
                selection.removeAllRanges();
                selection.addRange(range);
            });
            await custom.click();
            const dialog = page.locator(".b3-dialog--open").filter({has: page.locator(".b3-dialog__content label input")});
            await expect(dialog.locator(".b3-dialog__container")).toBeVisible();
            const input = dialog.locator("input");
            await expectInputReady(input, "NOTE");
            const label = await page.evaluate(() => window.siyuan.languages.type);
            await expect(dialog.locator("label")).toContainText(label);
            await input.fill("CUSTOM");
            if (close === "confirm") {
                await dialog.locator(".b3-dialog__action .b3-button--text").click();
            } else if (close === "cancel") {
                await dialog.locator(".b3-dialog__action .b3-button--cancel").click();
            } else {
                await input.press("Escape");
            }
            await expect(dialog).toHaveCount(0);
            await expect.poll(() => editable.evaluate(element => {
                const selection = getSelection();
                return selection && element.contains(selection.anchorNode) && element.contains(selection.focusNode) ?
                    selection.toString() : null;
            })).toBe("selected");
            await expect(callout).toHaveAttribute("data-subtype", close === "confirm" ? "CUSTOM" : "NOTE");
            await page.keyboard.insertText("replaced");
            await expect(editable).toHaveText("before replaced after");
            await expect.poll(async () => flatten(await siyuanAPI.readDocument<ISyNode>(document.docID))
                .filter(node => node.Type === "NodeText").map(node => node.Data).join(""), {
                timeout: 30000,
            }).toContain("before replaced after");
            await page.reload();
            const restored = (await getDocumentEditor(page, document.docID)).locator(`[data-node-id="${blockID}"]`);
            await expect(restored).toHaveAttribute("data-subtype", close === "confirm" ? "CUSTOM" : "NOTE");
            await expect(restored).toContainText("before replaced after");
        });
    }
});
