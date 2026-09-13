import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";

const resizeTextarea = async (page: Page, input: Locator, delta: number) => {
    const box = await input.boundingBox();
    if (!box) {
        throw new Error("Textarea is not visible");
    }
    await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3 + delta, {steps: 12});
    await page.mouse.up();
};

const expectResizeBounds = async (page: Page, input: Locator) => {
    // 等待弹窗缩放动画结束后再定位原生拖拽手柄。
    await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) =>
        Math.abs(element.getBoundingClientRect().width - element.offsetWidth))).toBeLessThan(1);
    const original = await input.boundingBox();
    expect(original).not.toBeNull();
    await resizeTextarea(page, input, 180);
    await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(original!.height);
    await expect.poll(async () => (await input.boundingBox())!.width).toBe(original!.width);
    await resizeTextarea(page, input, 900);
    const maximum = Math.min(480, page.viewportSize()!.height / 2);
    await expect.poll(async () => (await input.boundingBox())!.height).toBeCloseTo(maximum, 0);
    await resizeTextarea(page, input, -900);
    await expect.poll(async () => (await input.boundingBox())!.height).toBeCloseTo(28, 0);
};

const openHistory = async (page: Page) => {
    await page.locator("#barWorkspace").click();
    await page.locator('.b3-menu[data-name="barWorkspace"]:not(.fn__none) [data-id="dataHistory"]').click();
    const history = page.locator('[data-key="dialog-history"]');
    await expect(history.locator(".b3-dialog__container")).toBeVisible();
    await history.locator('.layout-tab-bar [data-type="repo"]').click();
    return history;
};

test.describe("multiline input dialogs", () => {
    test.beforeEach(async ({fullEntryVisibility}) => {
        // 使用完整菜单配置，测试结束后由 fixture 恢复。
        void fullEntryVisibility;
    });

    test("AI writing returns focus after empty confirmation and supports bounded vertical resizing", async ({
        page, createTestDocument,
    }) => {
        const document = await createTestDocument("AI Dialog Resize", "");
        const paragraph = document.editor.locator('[data-type="NodeParagraph"] [contenteditable="true"]').first();
        await paragraph.click();
        await page.keyboard.type("/ai");
        await page.locator('.protyle-hint:not(.fn__none) [data-id="aiWriting"]').click();
        const dialog = page.locator(".b3-dialog--open").filter({has: page.locator("[data-dialog-input]")});
        const input = dialog.locator("textarea");
        await expect(input).toBeFocused();
        await dialog.locator("[data-input-confirm]").click();
        await expect(input).toBeVisible();
        await expect(input).toBeFocused();
        const message = await page.evaluate(() => window.siyuan.languages._kernel[142]);
        await expect(page.locator("#message")).toContainText(message);
        await page.keyboard.insertText("First line");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.insertText("Second line");
        await expect(input).toHaveValue("First line\nSecond line");
        await expectResizeBounds(page, input);
        await input.press("Escape");
        await expect(dialog).toHaveCount(0);
    });

    test("snapshot memo preserves line breaks after saving and reopening with bounded resizing", async ({
        page, createTestDocument, siyuanAPI,
    }) => {
        const {conf} = await siyuanAPI.post<{conf: {repo: {key: string}}}>("/api/system/getConf", {});
        // 仅初始化测试工作空间中尚未配置的仓库，不替换已有密钥。
        if (!conf.repo.key) {
            await siyuanAPI.post("/api/repo/initRepoKey", {});
        }
        const document = await createTestDocument("Snapshot Memo Multiline", `Snapshot seed ${Date.now()}`);
        const created = await siyuanAPI.post<{id: string; created: boolean}>("/api/repo/createSnapshot", {
            memo: `Snapshot memo ${document.docID}`,
        });
        expect(created.created).toBe(true);
        const history = await openHistory(page);
        const row = history.locator(`[data-type="repoitem"][data-id="${created.id}"]`);
        await expect(row).toBeVisible();
        await row.hover();
        await row.locator('[data-type="editSnapshotMemo"]').click();
        const dialog = page.locator('[data-key="dialog-snapshotmemo"]');
        const input = dialog.locator("textarea");
        const memo = `First ${document.docID}\n\n第二行 <tag> & text`;
        await input.fill(memo);
        const confirm = dialog.locator("[data-input-confirm]");
        await expect(confirm).toBeVisible();
        const [saved] = await Promise.all([
            page.waitForResponse("**/api/repo/setSnapshotMemo"),
            confirm.click(),
        ]);
        expect((await saved.json()).code).toBe(0);
        await expect(dialog).toHaveCount(0);
        const snapshots = await siyuanAPI.post<{snapshots: {id: string; memo: string}[]}>("/api/repo/getRepoSnapshots", {page: 1});
        expect(snapshots.snapshots.find(snapshot => snapshot.id === created.id)?.memo).toBe(memo);
        await page.reload();
        await expect(page.locator("#barSearch")).toBeVisible();
        const reopened = await openHistory(page);
        const savedRow = reopened.locator(`[data-type="repoitem"][data-id="${created.id}"]`);
        await savedRow.hover();
        await savedRow.locator('[data-type="editSnapshotMemo"]').click();
        await expect(input).toHaveValue(memo);
        await expect(input).toBeFocused();
        await expectResizeBounds(page, input);
        await input.press("Escape");
        await reopened.locator(".b3-dialog__close").click();
    });
});
