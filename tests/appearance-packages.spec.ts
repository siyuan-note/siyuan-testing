import {randomUUID} from "node:crypto";
import {expect, test} from "./fixtures";
import {SiyuanAPI} from "./helpers/siyuanAPI";

const writePackageFile = async (api: SiyuanAPI, root: string, name: string, content: string) => {
    await api.writeWorkspaceFile(`${root}/${name}`, name.split("/").pop()!, "text/plain", Buffer.from(content));
};

test.describe("appearance packages in synced data", () => {
    test("loads a theme with relative assets, refreshes same-version CSS, and falls back after removal", async ({
        page, siyuanAPI, globalSettings, createTestDocument,
    }) => {
        await createTestDocument("Appearance Theme Package E2E", "Theme package resource loading");
        const name = `e2e-theme-${randomUUID()}`;
        const root = `/data/themes/${name}`;
        const original = globalSettings.appearance;
        const selected = {...original, mode: 0, modeOS: false, themeLight: name, themeJS: false};
        const style = (value: string) => `@import url("assets/nested.css");\n:root { --e2e-appearance-package: ${value}; }`;

        try {
            await writePackageFile(siyuanAPI, root, "theme.json", JSON.stringify({
                name, author: "SiYuan Testing", version: "1.0.0", minAppVersion: "3.0.0",
                modes: ["light"], frontends: ["all"],
            }));
            await writePackageFile(siyuanAPI, root, "assets/nested.css", ":root { --e2e-package-asset: loaded; }");
            await writePackageFile(siyuanAPI, root, "theme.css", style("first"));
            await siyuanAPI.setAppearance(selected);

            await expect(page.locator("html")).toHaveAttribute("data-light-theme", name);
            await expect.poll(() => page.evaluate(() => {
                const styles = getComputedStyle(document.documentElement);
                return [styles.getPropertyValue("--e2e-appearance-package").trim(),
                    styles.getPropertyValue("--e2e-package-asset").trim()];
            })).toEqual(["first", "loaded"]);

            await writePackageFile(siyuanAPI, root, "theme.css", style("second"));
            await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement)
                .getPropertyValue("--e2e-appearance-package").trim()), {timeout: 30000}).toBe("second");
            expect((await siyuanAPI.readWorkspaceFile<{version: string}>(`${root}/theme.json`)).version).toBe("1.0.0");

            await page.reload();
            await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
            await expect(page.locator("html")).toHaveAttribute("data-light-theme", name);
            await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement)
                .getPropertyValue("--e2e-appearance-package").trim())).toBe("second");

            await siyuanAPI.removeWorkspaceFile(root);
            const refreshed = await siyuanAPI.setAppearance(selected);
            expect(refreshed.themeLight).toBe("daylight");
            await expect(page.locator("html")).toHaveAttribute("data-light-theme", "daylight");
            await expect(page.locator("#themeStyle")).toHaveCount(0);
        } finally {
            await siyuanAPI.setAppearance(original);
            await siyuanAPI.removeWorkspaceFile(root);
        }
    });

    test("loads a data icon package through the appearance URL and removes it when unavailable", async ({
        page, siyuanAPI, globalSettings, createTestDocument,
    }) => {
        await createTestDocument("Appearance Icon Package E2E", "Icon package resource loading");
        const name = `e2e-icons-${randomUUID()}`;
        const root = `/data/icons/${name}`;
        const original = globalSettings.appearance;
        const selected = {...original, icon: name};

        try {
            await writePackageFile(siyuanAPI, root, "icon.json", JSON.stringify({
                name, author: "SiYuan Testing", version: "1.0.0", minAppVersion: "3.0.0",
            }));
            await writePackageFile(siyuanAPI, root, "icon.js",
                `document.documentElement.dataset.e2eIconPackage = ${JSON.stringify(name)};`);
            await siyuanAPI.setAppearance(selected);
            await expect(page.locator("html")).toHaveAttribute("data-e2e-icon-package", name);
            await expect(page.locator("#iconScript")).toHaveAttribute("src",
                new RegExp(`/appearance/icons/${name}/icon\\.js\\?v=1\\.0\\.0(?:&revision=[^&]+)?$`));

            await page.reload();
            await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
            await expect(page.locator("html")).toHaveAttribute("data-e2e-icon-package", name);

            await siyuanAPI.removeWorkspaceFile(root);
            const refreshed = await siyuanAPI.setAppearance(selected);
            expect(refreshed.icon).toBe("litheness");
            await expect(page.locator("#iconScript")).toHaveCount(0);
            await expect(page.locator("#iconDefaultScript")).toHaveAttribute("src", /\/appearance\/icons\/litheness\/icon\.js/);
        } finally {
            await siyuanAPI.setAppearance(original);
            await siyuanAPI.removeWorkspaceFile(root);
            await page.locator("html").evaluate(element => element.removeAttribute("data-e2e-icon-package"));
        }
    });
});
