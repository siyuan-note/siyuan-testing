import {Locator, Page} from "@playwright/test";
import {test, expect} from "./fixtures";
import {emulateIOSHost, tapOnce} from "./helpers/iosInput";

test.use({hasTouch: true});
test.beforeEach(async ({page}) => { await emulateIOSHost(page); });
test.afterEach(async ({page}) => { await page.unrouteAll({behavior: "wait"}); });

const settings = (page: Page) => page.locator('[data-key="dialog-setting"].b3-dialog--open');
const menu = (page: Page) => page.locator('#commonMenu:not(.fn__none)');

const openSettings = async (page: Page) => {
    await tapOnce(page, page.locator("#barWorkspace"));
    await expect(menu(page)).toBeVisible();
    await tapOnce(page, menu(page).locator('[data-id="config"]'));
    await expect(settings(page).locator(".b3-dialog__container")).toBeVisible();
    return settings(page);
};

const dismissSettings = async (page: Page) => {
    await tapOnce(page, settings(page).locator(".b3-dialog__scrim"), {x: 5, y: 5});
    await expect(settings(page)).toHaveCount(0);
};

test("iOS menu and settings sidebar respond to their first touch", async ({page, createTestDocument}) => {
    await createTestDocument("iOS first touch", "Control activation document");
    const dialog = await openSettings(page);
    for (const name of ["file", "appearance", "editor", "file"]) {
        const item = dialog.locator(`.config__side [data-name="${name}"]`);
        await tapOnce(page, item);
        await expect(item).toHaveClass(/b3-list-item--focus/);
    }
    await dismissSettings(page);
});

test("iOS settings switch and label each toggle once and persist", async ({page, createTestDocument, siyuanAPI}) => {
    await createTestDocument("iOS switch activation", "Switch activation document");
    const dialog = await openSettings(page);
    await tapOnce(page, dialog.locator('.config__side [data-name="file"]'));
    const checkbox = dialog.locator('input[id="fileTree.alwaysSelectOpenedFile"]');
    const original = await checkbox.isChecked();
    const persisted = async () => (await siyuanAPI.getConf()).conf.fileTree.alwaysSelectOpenedFile;
    try {
        await tapOnce(page, checkbox);
        await expect(checkbox).toBeChecked({checked: !original});
        await expect.poll(persisted).toBe(!original);
        const label = checkbox.locator("xpath=ancestor::label[1]");
        // label 的默认行为会再向关联的 checkbox 派发一次点击，值只应切换一次。
        await tapOnce(page, label, {x: 10, y: 10}, 2);
        await expect(checkbox).toBeChecked({checked: original});
        await expect.poll(persisted).toBe(original);
    } finally {
        if (await checkbox.isChecked() !== original) await checkbox.setChecked(original);
        await expect.poll(persisted).toBe(original);
    }
    await dismissSettings(page);
});

test("iOS settings closes on the first outside touch and can reopen", async ({page, createTestDocument}) => {
    await createTestDocument("iOS settings dismissal", "Outside touch document");
    await openSettings(page);
    await dismissSettings(page);
    await openSettings(page);
    await dismissSettings(page);
});

test("iOS block menu closes on a body touch and clears block highlighting", async ({page, createTestDocument}) => {
    const {editor} = await createTestDocument("iOS gutter activation", "First paragraph\n\nSecond paragraph");
    const first = editor.locator(':scope > [data-node-id]').first();
    const id = await first.getAttribute("data-node-id");
    await first.hover();
    const gutter = page.locator(`.protyle-gutters button[data-node-id="${id}"]`).first();
    await tapOnce(page, gutter);
    await expect(menu(page)).toBeVisible();
    await editor.locator('[contenteditable="true"]').last().tap();
    await expect(menu(page)).toBeHidden();
    await expect(editor.locator(".protyle-wysiwyg--hl, .protyle-wysiwyg--select")).toHaveCount(0);
    await expect(editor).toContainText("First paragraph");
    await expect(editor).toContainText("Second paragraph");
});

test("iOS scrolling a settings page does not activate controls", async ({page, context, createTestDocument}) => {
    await createTestDocument("iOS scroll activation", "Scroll isolation document");
    const dialog = await openSettings(page);
    await tapOnce(page, dialog.locator('.config__side [data-name="file"]'));
    const controls = dialog.locator('input[type="checkbox"]');
    const values = (locator: Locator) => locator.evaluateAll(elements => elements.map(e => (e as HTMLInputElement).checked));
    const before = await values(controls);
    const content = dialog.locator('.config__tab-container:visible');
    const box = await content.boundingBox();
    expect(box).toBeTruthy();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height * 0.8;
    const scroll = () => content.evaluate(element => element.scrollTop);
    const initialScroll = await scroll();
    const session = await context.newCDPSession(page);
    let touching = false;
    try {
        await session.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y, id: 1}]});
        touching = true;
        for (let step = 1; step <= 5; step++) {
            await session.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x, y: y-step*30, id: 1}]});
        }
        await session.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
        touching = false;
        await expect.poll(scroll).toBeGreaterThan(initialScroll);
        expect(await values(controls)).toEqual(before);
    } finally {
        if (touching) await session.send("Input.dispatchTouchEvent", {type: "touchCancel", touchPoints: []});
        await session.detach();
    }
    await dismissSettings(page);
});

test("iOS Command F focuses search and Escape restores the same caret without inserting f", async ({page, createTestDocument}) => {
    const {editor} = await createTestDocument("iOS search focus", "Search caret preservation");
    // 本例只检查焦点和正文，不将临时文档范围及搜索窗口状态写入共享工作空间。
    await page.route("**/api/storage/setLocalStorageVal", async route => {
        const {key} = route.request().postDataJSON();
        if (["local-searchdata", "local-searchkeys", "local-dialogposition"].includes(key)) {
            await route.fulfill({json: {code: 0, msg: "", data: null}});
        } else {
            await route.fallback();
        }
    });
    const editable = editor.locator('[contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    const caret = () => editable.evaluate(element => {
        const selection = getSelection()!;
        const range = selection.getRangeAt(0);
        return {text: element.textContent, start: range.startOffset, end: range.endOffset,
            inside: element.contains(range.startContainer)};
    });
    const before = await caret();
    await page.keyboard.press("Meta+f");
    const input = page.locator('.b3-dialog--open #searchInput');
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
    await expect.poll(caret, {message: "wait for dialog removal and caret restoration"}).toEqual(before);
});
