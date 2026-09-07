import {Locator, Page, expect} from "@playwright/test";

export const commandPanel = (page: Page) => page.locator('[data-key="dialog-commandpanel"]');

export const openCommandPanel = async (page: Page) => {
    await expect(commandPanel(page)).toHaveCount(0);
    const shortcut = await page.evaluate(() => {
        const key = window.siyuan.config.keymap.general.commandPanel.custom;
        if (!key) {
            throw new Error("The test workspace needs a configured Command Palette shortcut");
        }
        return key.replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+").replace(/⌃/g, "Control+")
            .replace(/⌘/g, /Mac/.test(navigator.platform) ? "Meta+" : "Control+");
    });
    await page.keyboard.press(shortcut);
    const panel = commandPanel(page);
    await expect(panel.locator("input")).toBeVisible();
    await expect(panel.locator("input")).toBeFocused();
    return panel;
};

export const runPaletteCommand = async (page: Page, id: string, method: "enter" | "click" = "enter") => {
    const panel = await openCommandPanel(page);
    const input = panel.locator("input");
    await input.fill(id);
    const item = panel.locator(`[data-command-id="${id}"]`);
    await expect(item, `Command ${id} should be available for the captured context`).toBeVisible();
    if (method === "click") {
        await item.click();
    } else {
        await expect(item).toHaveClass(/b3-list-item--focus/);
        await input.press("Enter");
    }
    await expect(panel).toHaveCount(0);
};

export const focusCommandTarget = async (target: Locator) => {
    await expect(target).toBeVisible();
    await target.evaluate(element => {
        const editable = element.matches('[contenteditable="true"]') ? element :
            element.closest('[contenteditable="true"]') || element.querySelector('[contenteditable="true"]');
        if (!editable) {
            throw new Error("Command target has no editable container");
        }
        (editable as HTMLElement).focus();
        const range = document.createRange();
        range.selectNodeContents(element.matches("td, th") ? element : editable);
        range.collapse(false);
        const selection = getSelection();
        if (!selection) {
            throw new Error("Selection is unavailable");
        }
        selection.removeAllRanges();
        selection.addRange(range);
    });
};
