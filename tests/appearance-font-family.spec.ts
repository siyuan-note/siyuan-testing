import {expect, test} from "./fixtures";
import {openWorkspace} from "./helpers/runtime";

test.describe("editor font families", () => {
    test("selects, sorts, and persists multiple editor fonts", async ({page, siyuanAPI, createTestDocument}) => {
        await createTestDocument("Editor Font Families E2E", "Font fallback test");
        const originalEditor = (await siyuanAPI.getConf()).conf.editor;
        const clearedEditor = await siyuanAPI.setEditor({
            ...originalEditor,
            fontFamily: "",
            fontWeight: 400,
            fontFamilyDisplay: "",
            fontFamilies: [],
        });

        try {
            await page.reload();
            await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontFamilies))
                .toEqual(clearedEditor.fontFamilies);

            await page.locator("#barWorkspace").click();
            const workspaceMenu = page.locator('.b3-menu[data-name="barWorkspace"]:not(.fn__none)');
            await expect(workspaceMenu).toBeVisible();
            await workspaceMenu.locator('[data-id="config"]').click();

            const settingsDialog = page.locator('[data-key="dialog-setting"].b3-dialog--open');
            await expect(settingsDialog.locator(".b3-dialog__container")).toBeVisible();
            await settingsDialog.locator('.config__side .b3-list-item[data-name="appearance"]').click();
            const fontConfig = settingsDialog.locator('[data-font-config-key="fontFamilies"]');
            const fontInput = fontConfig.locator('[id="editor.fontFamilies"]');
            const defaultFontName = await page.evaluate(() => window.siyuan.languages.default);
            await expect(fontInput).toBeVisible();
            await expect(fontInput).toHaveValue(defaultFontName);
            await fontInput.click();

            const fontMenu = page.locator(".b3-menu:not(.fn__none)", {
                has: page.locator('[data-type="available-fonts"]'),
            });
            await expect(fontMenu).toBeVisible();
            await expect(fontMenu.locator('[data-type="selected-fonts"]')).toHaveCount(0);
            await expect(fontMenu.locator('[data-type="available-fonts"] .b3-menu__label[data-family=""]'))
                .toHaveCount(0);
            const availableFonts = fontMenu.locator('[data-type="available-fonts"] .b3-menu__label[data-family]');
            const fontIndexes = await availableFonts.evaluateAll((elements) => {
                const families = new Set<string>();
                const indexes: number[] = [];
                elements.forEach((element, index) => {
                    const family = (element as HTMLElement).dataset.family;
                    if (family && !families.has(family) && indexes.length < 2) {
                        families.add(family);
                        indexes.push(index);
                    }
                });
                return indexes;
            });
            expect(fontIndexes, "the system font menu should expose at least two distinct families").toHaveLength(2);
            const selectedFonts = await Promise.all(fontIndexes.map(async (index) => {
                const font = availableFonts.nth(index);
                return {
                    family: await font.getAttribute("data-family") as string,
                    weight: Number(await font.getAttribute("data-weight")),
                    displayName: await font.getAttribute("data-name") as string,
                };
            }));

            await availableFonts.nth(fontIndexes[0]).click();
            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontFamilies))
                .toEqual([selectedFonts[0]]);
            await expect(fontInput).toHaveValue(selectedFonts[0].displayName);
            await availableFonts.nth(fontIndexes[1]).click();
            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontFamilies))
                .toEqual(selectedFonts);
            await expect(fontInput).toHaveValue(selectedFonts.map((font) => font.displayName).join(", "));

            const selectedList = fontConfig.locator('[data-type="selected-fonts"]');
            await expect(selectedList).toBeVisible();
            expect(await selectedList.evaluate((element) =>
                element.previousElementSibling?.classList.contains("fn__hr--small") &&
                element.previousElementSibling.previousElementSibling?.classList.contains("b3-label__text"))).toBe(true);
            const selectedChips = selectedList.locator(".b3-chip");
            await expect(selectedChips).toHaveCount(2);
            expect(await selectedChips.evaluateAll((chips) => chips.every((chip) => {
                const chipRect = chip.getBoundingClientRect();
                const textRect = chip.querySelector(".config-font-family__text")?.getBoundingClientRect();
                return textRect && Math.abs((chipRect.top + chipRect.bottom) / 2 -
                    (textRect.top + textRect.bottom) / 2) < 0.5;
            }))).toBe(true);
            const firstChipBox = await selectedChips.nth(0).boundingBox();
            const secondChipBox = await selectedChips.nth(1).boundingBox();
            expect(firstChipBox).not.toBeNull();
            expect(secondChipBox).not.toBeNull();
            await page.mouse.move(secondChipBox!.x + secondChipBox!.width / 2,
                secondChipBox!.y + secondChipBox!.height / 2);
            await page.mouse.down();
            await page.mouse.move(firstChipBox!.x + 2, firstChipBox!.y + firstChipBox!.height / 2, {steps: 5});
            await page.mouse.up();
            const sortedFonts = [selectedFonts[1], selectedFonts[0]];
            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontFamilies))
                .toEqual(sortedFonts);
            await expect(fontInput).toHaveValue(sortedFonts.map((font) => font.displayName).join(", "));
            await expect.poll(() => selectedChips.evaluateAll((chips) =>
                chips.map((chip) => (chip as HTMLElement).dataset.family))).toEqual(sortedFonts.map((font) => font.family));
            await expect.poll(() => page.evaluate(() =>
                getComputedStyle(document.documentElement).getPropertyValue("--b3-font-family-editor").trim()))
                .toBe(await page.evaluate((fonts) => fonts.map((font) => CSS.escape(font.family)).join(", "), sortedFonts));
            await expect.poll(() => page.locator("#siyuanStyle").evaluate((style) => style.textContent))
                .toContain("var(--b3-font-family-editor)");
            expect((await siyuanAPI.getConf()).conf.editor.fontFamilies).toEqual(sortedFonts);

            await selectedChips.nth(0).locator('[data-type="font-remove"]').click();
            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontFamilies))
                .toEqual([sortedFonts[1]]);
            await expect(fontInput).toHaveValue(sortedFonts[1].displayName);
            await selectedChips.nth(0).locator('[data-type="font-remove"]').click();
            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontFamilies)).toEqual([]);
            await expect(fontInput).toHaveValue(defaultFontName);
            await expect(selectedList).toBeHidden();
            await expect.poll(() => page.evaluate(() =>
                getComputedStyle(document.documentElement).getPropertyValue("--b3-font-family-editor").trim()))
                .toBe("var(--b3-font-family-protyle)");

            await page.reload();
            await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
            await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontFamilies)).toEqual([]);
            expect((await siyuanAPI.getConf()).conf.editor.fontFamilies).toEqual([]);
        } finally {
            await siyuanAPI.setEditor(originalEditor);
            if (!page.isClosed()) {
                await openWorkspace(page);
                await expect.poll(() => page.evaluate(() => window.siyuan.config.editor.fontFamilies))
                    .toEqual(originalEditor.fontFamilies);
            }
        }
    });
});
