import {Locator, Page} from "@playwright/test";
import {expect, test as base} from "./fixtures";

interface IKeymapItem {
    default: string;
    custom: string;
    bindings?: {version: number; keys: string[]};
}

interface IKeymap {
    general: Record<string, IKeymapItem>;
    editor: unknown;
    plugin: unknown;
}

const action = "goToTab5";
const addedKey = "⌥⇧⌘F9";
const replacementKey = "⌥⇧⌘F10";
const rowSelector = `[data-key="general\u200b${action}"]`;

const openKeymap = async (page: Page) => {
    await page.locator("#barWorkspace").click();
    await page.locator('.b3-menu[data-name="barWorkspace"]:not(.fn__none) [data-id="config"]').click();
    const dialog = page.locator('[data-key="dialog-setting"].b3-dialog--open');
    await dialog.locator('.config__side [data-name="keymap"]').click();
    const row = dialog.locator(rowSelector);
    await dialog.locator("#keymapInput").fill((await row.locator(".b3-list-item__text").textContent())!.trim());
    await expect(row).toBeVisible();
    return row;
};

const test = base.extend<{shortcutRow: Locator}>({
    shortcutRow: async ({page, siyuanAPI, createTestDocument, fullEntryVisibility}, use) => {
        void fullEntryVisibility;
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        const original = conf.keymap;
        // 使用未占用的组合键，避免测试覆盖用户或其他命令的绑定。
        expect(JSON.stringify(original)).not.toContain(addedKey);
        expect(JSON.stringify(original)).not.toContain(replacementKey);
        const keymap = structuredClone(original);
        keymap.general[action] = {default: "⌘5", custom: "⌘5"};
        try {
            await siyuanAPI.post("/api/setting/setKeymap", {data: keymap});
            await createTestDocument("Keymap Bindings E2E", "Shortcut configuration test");
            await use(await openKeymap(page));
        } finally {
            // 先关闭页面，避免卸载回调把测试设置再次写回内核。
            if (!page.isClosed()) {
                await page.goto("about:blank");
            }
            await siyuanAPI.post("/api/setting/setKeymap", {data: original});
        }
    },
});

const clickAction = async (row: Locator, type: string) => {
    await row.hover();
    await row.locator(`[data-type="${type}"]`).click();
};

const recordKey = async (page: Page, key = "F9") => {
    await page.keyboard.press(`ControlOrMeta+Alt+Shift+${key}`);
};

test("adds a binding and preserves both bindings after reload", async ({page, siyuanAPI, shortcutRow}) => {
    await clickAction(shortcutRow, "add");
    await recordKey(page);
    await expect(shortcutRow.locator('[data-type="update"]')).toHaveCount(2);
    await expect.poll(async () => {
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        return conf.keymap.general[action].bindings?.keys;
    }).toEqual(["⌘5", addedKey]);

    await page.reload();
    await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
    const row = await openKeymap(page);
    await expect(row).toHaveAttribute("data-keys", JSON.stringify(["⌘5", addedKey]));
    await expect(row.locator('[data-type="update"]')).toHaveCount(2);

    // 文字和删除按钮必须在同一个带边框的按键容器内。
    const bounds = await row.locator('[data-index="1"]').evaluate(element => {
        const chip = element.getBoundingClientRect();
        const remove = element.querySelector('[data-type="remove"]')!.getBoundingClientRect();
        const update = element.querySelector('[data-type="update"]')!;
        return {
            border: getComputedStyle(element).borderTopWidth,
            textBorder: getComputedStyle(update).borderTopWidth,
            contained: remove.left >= chip.left && remove.right <= chip.right &&
                remove.top >= chip.top && remove.bottom <= chip.bottom,
        };
    });
    expect(bounds).toEqual({border: "1px", textBorder: "0px", contained: true});
});

test("cancels recording without changing bindings and edits only the selected binding", async ({page, siyuanAPI, shortcutRow}) => {
    await clickAction(shortcutRow, "add");
    await recordKey(page);
    const expected = JSON.stringify(["⌘5", addedKey]);
    await expect(shortcutRow).toHaveAttribute("data-keys", expected);

    await shortcutRow.locator('[data-index="1"] [data-type="update"]').click();
    await page.keyboard.press("Escape");
    await expect(shortcutRow).toHaveAttribute("data-keys", expected);
    await expect(shortcutRow.locator("input")).toHaveCount(0);

    await clickAction(shortcutRow, "add");
    await page.locator("#keymapInput").click();
    await expect(shortcutRow.locator("input")).toHaveCount(0);
    await expect(shortcutRow).toHaveAttribute("data-keys", expected);

    await clickAction(shortcutRow, "add");
    await recordKey(page);
    await expect(shortcutRow.locator("input")).toHaveCount(0);
    await expect(shortcutRow).toHaveAttribute("data-keys", expected);

    await shortcutRow.locator('[data-index="1"] [data-type="update"]').click();
    await recordKey(page, "F10");
    await expect(shortcutRow).toHaveAttribute("data-keys", JSON.stringify(["⌘5", replacementKey]));
    await expect.poll(async () => {
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        return conf.keymap.general[action].bindings?.keys;
    }).toEqual(["⌘5", replacementKey]);
});

test("removes individual bindings, hides empty controls and restores defaults", async ({page, siyuanAPI, shortcutRow}) => {
    const reset = shortcutRow.locator('[data-type="reset"]');
    await shortcutRow.hover();
    expect(await reset.boundingBox()).toBeNull();
    await clickAction(shortcutRow, "add");
    await recordKey(page);
    await shortcutRow.locator('[data-index="0"] [data-type="remove"]').click();
    await expect(shortcutRow).toHaveAttribute("data-keys", JSON.stringify([addedKey]));
    await expect(shortcutRow.locator("input")).toHaveCount(0);
    await clickAction(shortcutRow, "remove");
    await expect(shortcutRow.locator('[data-index], .config-keymap__empty')).toHaveCount(0);
    await expect(shortcutRow.locator('[data-type="add"]')).toHaveCount(1);
    await expect.poll(async () => {
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        return conf.keymap.general[action].bindings?.keys;
    }).toEqual([]);

    await clickAction(shortcutRow, "reset");
    await expect(shortcutRow).toHaveAttribute("data-keys", JSON.stringify(["⌘5"]));
    expect(await reset.boundingBox()).toBeNull();
    await expect.poll(async () => {
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        return conf.keymap.general[action].bindings?.keys;
    }).toEqual(["⌘5"]);
});
