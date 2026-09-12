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
                const currentChip = session.dialog.locator('#criteria [data-type="set-criteria"].b3-chip--current');
                await expect(currentChip).toHaveText(first);
                await expect(currentChip.locator("em, strong")).toHaveCount(0);
                await session.dialog.locator('[data-type="saveCriterion"]').click();
                const nameInput = page.locator('[data-key="dialog-savecriterion"] input');
                await expect(nameInput).toHaveValue(first);
                await expect(nameInput).toBeFocused();
                expect(await nameInput.evaluate((input: HTMLInputElement) =>
                    [input.selectionStart, input.selectionEnd])).toEqual([0, first.length]);
                await nameInput.press("Escape");
                if (branch === "overwrite") {
                    await submitSearch(page, session, `${document.title} different`);
                    saved = page.waitForResponse("**/api/storage/setCriterion");
                    await saveName(page, second);
                    expect((await (await saved).json()).code).toBe(0);
                    await expect(page.locator('[data-key="dialog-savecriterion"]')).toHaveCount(0);
                    await expect(currentChip).toHaveText(second);
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
                saved = page.waitForResponse("**/api/storage/setCriterion");
                await confirm.locator("#confirmDialogConfirmBtn").click();
                expect((await (await saved).json()).code).toBe(0);
                await expect(inputDialog).toHaveCount(0);
                await expect(currentChip).toHaveText(second);
                await expect(currentChip.locator("em, strong")).toHaveCount(0);
                await expect(session.dialog.locator('#criteria [data-type="set-criteria"]')
                    .filter({hasText: document.title})).toHaveCount(1);
                await submitSearch(page, session, `${document.title} changed`);
                await session.dialog.locator('#criteria [data-type="set-criteria"]')
                    .filter({hasText: document.title}).click();
                await expect(session.input).toHaveValue(document.title);
                await expect(currentChip).toHaveText(second);
            });
        } finally {
            await siyuanAPI.post("/api/storage/removeCriterion", {name: first});
            await siyuanAPI.post("/api/storage/removeCriterion", {name: second});
        }
    });
}
