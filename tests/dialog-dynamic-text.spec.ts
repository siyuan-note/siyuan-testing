import {Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {withKeywordSearch, submitSearch} from "./helpers/search";

const saveName = async (page: Page, name: string) => {
    await page.locator('[data-type="saveCriterion"]:visible').click();
    const dialog = page.locator('[data-key="dialog-savecriterion"]');
    await dialog.locator("input").fill(name);
    await dialog.locator("input").press("Enter");
    return dialog;
};

for (const branch of ["rename", "overwrite"] as const) {
    test(`preserves literal names in search ${branch} confirmation`, async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const document = await createTestDocument(`Dynamic Text ${branch}`);
        const first = `${document.title} <em>one</em> &amp; &#60; "quoted"`;
        const second = `${document.title} <strong>two</strong> &lt; &`;
        try {
            await withKeywordSearch(page, async session => {
                await submitSearch(page, session, document.title);
                let saved = page.waitForResponse("**/api/storage/setCriterion");
                await saveName(page, first);
                expect((await (await saved).json()).code).toBe(0);
                await expect(page.locator('[data-key="dialog-savecriterion"]')).toHaveCount(0);
                if (branch === "overwrite") {
                    await submitSearch(page, session, `${document.title} different`);
                    saved = page.waitForResponse("**/api/storage/setCriterion");
                    await saveName(page, second);
                    expect((await (await saved).json()).code).toBe(0);
                    await expect(page.locator('[data-key="dialog-savecriterion"]')).toHaveCount(0);
                    await submitSearch(page, session, document.title);
                }
                const inputDialog = await saveName(page, second);
                const confirm = page.locator('[data-key="dialog-confirm"]');
                await expect(confirm.locator("#confirmDialogConfirmBtn")).toBeVisible();
                const expected = await page.evaluate(({branch, first, second}) => {
                    const template = window.siyuan.languages[branch === "rename" ? "searchUpdateName" : "searchRemoveName"];
                    return template.replace("${x}", () => first).replace("${y}", () => second);
                }, {branch, first, second});
                await expect(confirm.locator(".ft__breakword")).toHaveText(expected);
                await expect(confirm.locator(".ft__breakword em, .ft__breakword strong")).toHaveCount(0);
                await confirm.locator("#cancelDialogConfirmBtn").click();
                await inputDialog.locator("input").press("Escape");
            });
        } finally {
            await siyuanAPI.post("/api/storage/removeCriterion", {name: first});
            await siyuanAPI.post("/api/storage/removeCriterion", {name: second});
        }
    });
}
