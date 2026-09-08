import {Locator, Page} from "@playwright/test";
import {expect, test as base} from "./fixtures";
import {showFileTree} from "./helpers/runtime";

interface IKeymapItem {
    default: string;
    custom: string;
    bindings?: {version: number; keys: string[]};
}

interface IKeymap {
    general: Record<string, IKeymapItem>;
    editor: {general: Record<string, IKeymapItem>};
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
    if (type === "remove") {
        await row.locator("[data-index]").hover();
    } else {
        await row.hover();
    }
    await row.locator(`[data-type="${type}"]`).click();
};

const recordKey = async (page: Page, key = "F9") => {
    await page.keyboard.press(`ControlOrMeta+Alt+Shift+${key}`);
};

test("saves a shortcut already assigned to the command palette and marks the conflict", async ({page, siyuanAPI, shortcutRow}) => {
    const binding = await page.evaluate(() => {
        const key = window.siyuan.config.keymap.general.commandPanel.custom;
        return {key, press: key.replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+")
            .replace(/⌃/g, "Control+").replace(/⌘/g, /Mac/.test(navigator.platform) ? "Meta+" : "Control+")};
    });
    expect(binding.key).not.toBe("");
    await clickAction(shortcutRow, "add");
    await page.keyboard.press(binding.press);
    await expect(shortcutRow.locator(".config-keymap__record")).toHaveCount(0);
    await expect(shortcutRow.locator('[data-index="1"]')).toHaveClass(/config-keymap__chip--conflict/);
    await expect(page.locator('[data-type="shared"], [data-type="priority-up"], [data-type="priority-down"]')).toHaveCount(0);
    await expect.poll(async () => {
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        return conf.keymap.general[action].bindings?.keys;
    }).toEqual(["⌘5", binding.key]);
    await page.reload();
    await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
    const row = await openKeymap(page);
    await expect(row).toHaveAttribute("data-keys", JSON.stringify(["⌘5", binding.key]));
    await expect(row.locator('[data-index="1"]')).toHaveClass(/config-keymap__chip--conflict/);
    await row.locator('[data-index="1"] .config-keymap__text').click();
    await expect(row.locator(".config-keymap__record")).toHaveCount(0);
    await row.locator('[data-type="add"]').click();
    await page.keyboard.press("Escape");
    await expect(row).toHaveAttribute("data-keys", JSON.stringify(["⌘5", binding.key]));
    await expect(row).toHaveAttribute("data-conflict", "true");
    await expect(row.locator('[data-index="1"]')).toHaveClass(/config-keymap__chip--conflict/);
    await expect(row.locator('[data-index="0"]')).not.toHaveClass(/config-keymap__chip--conflict/);
});

base("prefers the focused local shortcut and uses a fixed general order after reload", async ({page, siyuanAPI, createTestDocument}) => {
    const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
    const original = conf.keymap;
    const keymap = structuredClone(original);
    const assign = (item: IKeymapItem) => {
        item.custom = addedKey;
        item.bindings = {version: 1, keys: [addedKey]};
    };
    expect(JSON.stringify(original)).not.toContain(addedKey);
    assign(keymap.general.commandPanel);
    assign(keymap.general.goToTab5);
    assign(keymap.editor.general.fullscreen);
    try {
        await siyuanAPI.post("/api/setting/setKeymap", {data: keymap});
        const {editor} = await createTestDocument("Keymap Priority E2E", "Shortcut priority test");
        const protyle = editor.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " protyle ")][1]');
        const panel = page.locator('[data-key="dialog-commandpanel"]');
        for (let reload = 0; reload < 2; reload++) {
            if (reload) {
                await page.reload();
                await expect(editor).toBeVisible({timeout: 30000});
            }
            await editor.locator('[contenteditable="true"]').first().click();
            await recordKey(page);
            await expect(protyle).toHaveClass(/fullscreen/);
            await expect(panel).toHaveCount(0);
            await recordKey(page);
            await expect(protyle).not.toHaveClass(/fullscreen/);
            // 焦点移出编辑器后，相同按键按通用范围的固定顺序打开命令面板。
            await page.evaluate(() => {
                (document.activeElement as HTMLElement)?.blur();
                document.getSelection()?.removeAllRanges();
            });
            await recordKey(page);
            await expect(panel.locator("input")).toBeVisible();
            await panel.locator("input").press("Escape");
            await expect(panel).toHaveCount(0);
        }
    } finally {
        await page.goto("about:blank");
        await siyuanAPI.post("/api/setting/setKeymap", {data: original});
    }
});

base("prefers the active file tree shortcut when the keyboard target is the page body", async ({page, siyuanAPI, createTestDocument}) => {
    const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
    const original = conf.keymap;
    const keymap = structuredClone(original);
    expect(JSON.stringify(original)).not.toContain(addedKey);
    expect(JSON.stringify(original)).not.toContain(replacementKey);
    for (const item of [keymap.general.commandPanel, keymap.editor.general.rename]) {
        item.custom = addedKey;
        item.bindings = {version: 1, keys: [addedKey]};
    }
    keymap.general.selectOpen1.custom = replacementKey;
    keymap.general.selectOpen1.bindings = {version: 1, keys: [replacementKey]};
    let restoreFileTree: (() => Promise<void>) | undefined;
    try {
        await siyuanAPI.post("/api/setting/setKeymap", {data: keymap});
        const {docID} = await createTestDocument("Keymap File Tree Priority E2E", "File tree shortcut priority test");
        restoreFileTree = await showFileTree(page);
        await recordKey(page, "F10");
        const tree = page.locator(".sy__file.layout__tab--active");
        await expect(tree.locator(`.b3-list-item--focus[data-node-id="${docID}"]`)).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
        await recordKey(page);
        const dialog = page.locator('[data-key="dialog-rename"]');
        await expect(dialog.locator("input")).toBeVisible();
        await expect(page.locator('[data-key="dialog-commandpanel"]')).toHaveCount(0);
        await dialog.locator("input").press("Escape");
        await expect(dialog).toHaveCount(0);
    } finally {
        await restoreFileTree?.();
        await page.goto("about:blank");
        await siyuanAPI.post("/api/setting/setKeymap", {data: original});
    }
});

test("combines assignment filters with search and updates them after editing", async ({page, siyuanAPI, shortcutRow}) => {
    const filter = async (value: string) => page.locator(`[data-keymap-filter-value="${value}"]`).click();
    await filter("assigned");
    await expect(shortcutRow).toBeVisible();
    await filter("customized");
    await expect(shortcutRow).toBeHidden();
    await filter("unassigned");
    await expect(shortcutRow).toBeHidden();
    await filter("all");
    await clickAction(shortcutRow, "add");
    await recordKey(page);
    await filter("customized");
    await expect(shortcutRow).toBeVisible();
    await page.locator("#keymapInput").fill("NoMatchingShortcutName");
    await expect(shortcutRow).toBeHidden();
    await page.locator("#keymapInput").fill((await shortcutRow.locator(".b3-list-item__text").textContent())!.trim());
    await expect(shortcutRow).toBeVisible();
    await shortcutRow.locator('[data-index="1"]').hover();
    await shortcutRow.locator('[data-index="1"] [data-type="remove"]').click();
    await expect(shortcutRow).toBeHidden();
    await filter("assigned");
    await clickAction(shortcutRow, "remove");
    await expect(shortcutRow).toBeHidden();
    await filter("unassigned");
    await expect(shortcutRow).toBeVisible();
    await expect(shortcutRow.locator("[data-index]")).toHaveCount(0);
    await clickAction(shortcutRow, "reset");
    await expect(shortcutRow).toBeHidden();
    await filter("assigned");
    await expect(shortcutRow).toBeVisible();
    await expect.poll(async () => {
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        return conf.keymap.general[action].bindings?.keys;
    }).toEqual(["⌘5"]);
});

test("shows the conflict filter only when needed and colors only conflicting bindings", async ({page, siyuanAPI, shortcutRow}) => {
    void shortcutRow;
    const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
    // 构造两个独立默认绑定，排除测试工作空间中已有冲突的影响。
    const clear = (value: unknown) => {
        if (!value || typeof value !== "object") {
            return;
        }
        const item = value as Record<string, unknown>;
        if (typeof item.custom === "string") {
            item.custom = "";
            delete item.bindings;
        } else {
            Object.values(item).forEach(clear);
        }
    };
    clear(conf.keymap);
    conf.keymap.general.goToTab5 = {default: "⌘5", custom: "⌘5"};
    conf.keymap.general.goToTab6 = {default: "⌘6", custom: "⌘6"};
    await siyuanAPI.post("/api/setting/setKeymap", {data: conf.keymap});
    await page.reload();
    await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
    const row = await openKeymap(page);
    const conflictFilter = page.locator('[data-keymap-filter-value="conflict"]');
    await expect(conflictFilter).toBeHidden();
    await clickAction(row, "add");
    await page.keyboard.press("ControlOrMeta+6");
    await expect(conflictFilter).toBeVisible();
    await expect(row.locator('[data-index="0"]')).not.toHaveClass(/config-keymap__chip--conflict/);
    const chip = row.locator('[data-index="1"]');
    await expect(chip).toHaveClass(/config-keymap__chip--conflict/);
    const colorsMatch = await chip.evaluate(element => {
        const probe = document.createElement("span");
        probe.style.cssText = "background-color:var(--b3-font-background1);color:var(--b3-font-color1)";
        element.append(probe);
        const actual = getComputedStyle(element);
        const expected = getComputedStyle(probe);
        const matches = actual.color === expected.color && actual.backgroundColor === expected.backgroundColor;
        probe.remove();
        return matches;
    });
    expect(colorsMatch).toBe(true);
    await conflictFilter.click();
    await page.locator("#keymapInput").fill("");
    await expect(page.locator('#keymapList .config-keymap__row:visible')).toHaveCount(2);
    await chip.hover();
    await chip.locator('[data-type="remove"]').click();
    await expect(conflictFilter).toBeHidden();
    await expect(page.locator('[data-keymap-filter-value="all"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".config-keymap__chip--conflict")).toHaveCount(0);
    await expect.poll(async () => {
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        return conf.keymap.general[action].bindings?.keys;
    }).toEqual(["⌘5"]);
});

test("always shows shortcut removal buttons without shifting on hover and labels the add button", async ({page, siyuanAPI, shortcutRow}) => {
    const addLabel = await page.evaluate(() => Reflect.get(window.siyuan, "languages").keymapAdd as string);
    await expect(shortcutRow.locator('[data-type="add"]')).toHaveAttribute("aria-label", addLabel);
    await clickAction(shortcutRow, "add");
    await recordKey(page);
    await expect.poll(async () => {
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        return conf.keymap.general[action].bindings?.keys;
    }).toEqual(["⌘5", addedKey]);
    await page.locator("#keymapInput").click();
    const chip = shortcutRow.locator('[data-index="0"]');
    const remove = chip.locator('[data-type="remove"]');
    await expect(remove).toHaveCSS("opacity", "0.68");
    await expect(remove).toHaveCSS("pointer-events", "auto");
    const before = await chip.boundingBox();
    const removeBefore = await remove.boundingBox();
    expect(before).not.toBeNull();
    expect(removeBefore).not.toBeNull();

    await chip.hover();
    await expect(remove).toHaveCSS("opacity", "0.68");
    expect(await chip.boundingBox()).toEqual(before);
    expect(await remove.boundingBox()).toEqual(removeBefore);
    await expect(shortcutRow.locator('[data-index="1"] [data-type="remove"]')).toHaveCSS("opacity", "0.68");

    await page.locator("#keymapInput").hover();
    await remove.focus();
    await expect(remove).toHaveCSS("opacity", "0.68");
});

test("adds a binding and preserves both bindings after reload", async ({page, siyuanAPI, shortcutRow}) => {
    await clickAction(shortcutRow, "add");
    await recordKey(page);
    await expect(shortcutRow.locator(".config-keymap__text")).toHaveCount(2);
    await expect.poll(async () => {
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        return conf.keymap.general[action].bindings?.keys;
    }).toEqual(["⌘5", addedKey]);

    await page.reload();
    await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
    const row = await openKeymap(page);
    await expect(row).toHaveAttribute("data-keys", JSON.stringify(["⌘5", addedKey]));
    await expect(row.locator(".config-keymap__text")).toHaveCount(2);

    // 文字和删除按钮必须在同一个带边框的按键容器内。
    const bounds = await row.locator('[data-index="1"]').evaluate(element => {
        const chip = element.getBoundingClientRect();
        const remove = element.querySelector('[data-type="remove"]')!.getBoundingClientRect();
        const text = element.querySelector(".config-keymap__text")!;
        return {
            border: getComputedStyle(element).borderTopWidth,
            textBorder: getComputedStyle(text).borderTopWidth,
            contained: remove.left >= chip.left && remove.right <= chip.right &&
                remove.top >= chip.top && remove.bottom <= chip.bottom,
        };
    });
    expect(bounds).toEqual({border: "1px", textBorder: "0px", contained: true});
});

test("keeps existing shortcuts read-only and continues recording after duplicate input", async ({page, siyuanAPI, shortcutRow}) => {
    await clickAction(shortcutRow, "add");
    await recordKey(page);
    const expected = JSON.stringify(["⌘5", addedKey]);
    await expect(shortcutRow).toHaveAttribute("data-keys", expected);

    await shortcutRow.locator('[data-index="1"] .config-keymap__text').click();
    await expect(shortcutRow.locator(".config-keymap__record")).toHaveCount(0);
    await expect(shortcutRow.locator('[data-type="update"]')).toHaveCount(0);
    await clickAction(shortcutRow, "add");
    await page.keyboard.press("Escape");
    await expect(shortcutRow).toHaveAttribute("data-keys", expected);
    await expect(shortcutRow.locator(".config-keymap__record")).toHaveCount(0);

    await clickAction(shortcutRow, "add");
    await page.locator("#keymapInput").click();
    await expect(shortcutRow.locator(".config-keymap__record")).toHaveCount(0);
    await expect(shortcutRow).toHaveAttribute("data-keys", expected);

    await clickAction(shortcutRow, "add");
    await recordKey(page);
    await expect(shortcutRow.locator(".config-keymap__record")).toBeFocused();
    await expect(shortcutRow).toHaveAttribute("data-keys", expected);
    await recordKey(page, "F10");
    await expect(shortcutRow).toHaveAttribute("data-keys", JSON.stringify(["⌘5", addedKey, replacementKey]));
    await expect(shortcutRow.locator(".config-keymap__record")).toHaveCount(0);
    await shortcutRow.locator('[data-index="2"] [data-type="remove"]').click();
    await expect(shortcutRow).toHaveAttribute("data-keys", expected);

    await expect.poll(async () => {
        const {conf} = await siyuanAPI.post<{conf: {keymap: IKeymap}}>("/api/system/getConf", {});
        return conf.keymap.general[action].bindings?.keys;
    }).toEqual(["⌘5", addedKey]);
});

test("removes individual bindings, hides empty controls and restores defaults", async ({page, siyuanAPI, shortcutRow}) => {
    const reset = shortcutRow.locator('[data-type="reset"]');
    await shortcutRow.hover();
    expect(await reset.boundingBox()).toBeNull();
    await clickAction(shortcutRow, "add");
    await recordKey(page);
    await shortcutRow.locator('[data-index="0"]').hover();
    await shortcutRow.locator('[data-index="0"] [data-type="remove"]').click();
    await expect(shortcutRow).toHaveAttribute("data-keys", JSON.stringify([addedKey]));
    await expect(shortcutRow.locator(".config-keymap__record")).toHaveCount(0);
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
