import {expect, Page} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";
import {IWorkspaceInfo, SiyuanAPI} from "./siyuanAPI";

export const DEFAULT_BASE_URL = "http://127.0.0.1:6807";
export const DEFAULT_TEST_WORKSPACE = path.join(homedir(), "SiYuan-Testing");

export const getBaseURL = () => process.env.SIYUAN_BASE_URL || DEFAULT_BASE_URL;
export const getExpectedWorkspace = () =>
    process.env.SIYUAN_EXPECT_WORKSPACE?.trim() || DEFAULT_TEST_WORKSPACE;

export const validateTestTarget = async (api: SiyuanAPI, baseURL: string) => {
    const target = new URL(baseURL);
    const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(target.hostname);
    if (!isLoopback && process.env.SIYUAN_ALLOW_REMOTE !== "1") {
        throw new Error(
            `Refusing to run against non-loopback target ${target.origin}. ` +
            "Set SIYUAN_ALLOW_REMOTE=1 only when this is an intentional test instance.",
        );
    }

    const configuredWorkspace = process.env.SIYUAN_EXPECT_WORKSPACE?.trim();
    if (!isLoopback && !configuredWorkspace) {
        throw new Error("SIYUAN_EXPECT_WORKSPACE is required for a remote test target.");
    }
    const expectedWorkspace = getExpectedWorkspace();
    if (isLoopback) {
        if (!path.isAbsolute(expectedWorkspace)) {
            throw new Error(`SIYUAN_EXPECT_WORKSPACE must be absolute, received ${expectedWorkspace}.`);
        }
        await mkdir(expectedWorkspace, {recursive: true});
    }
    let workspaceInfo: IWorkspaceInfo | undefined;
    await expect.poll(async () => {
        try {
            workspaceInfo = await api.getWorkspaceInfo();
            return true;
        } catch {
            return false;
        }
    }, {
        message: `waiting for SiYuan at ${target.origin}`,
        timeout: 15000,
    }).toBe(true);
    if (!workspaceInfo) {
        throw new Error(`SiYuan at ${target.origin} did not return workspace information.`);
    }

    // Windows 内核返回反斜杠路径，统一为正斜杠后再比较，避免分隔符差异导致误判
    const normalizeWorkspace = (value: string) =>
        value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
    if (normalizeWorkspace(workspaceInfo.workspaceDir) !== normalizeWorkspace(expectedWorkspace)) {
        throw new Error(
            `SiYuan is using workspace ${workspaceInfo.workspaceDir}, expected ${expectedWorkspace}.`,
        );
    }

    console.log(`[siyuan-testing] Target ${target.origin}, workspace ${workspaceInfo.workspaceDir}, ` +
        `version ${workspaceInfo.siyuanVer}`);
    return workspaceInfo;
};

export const openWorkspace = async (page: Page, path = "/") => {
    await page.goto(path);
    await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
    const dialog = page.locator('[data-key="dialog-changelog"]');
    if (await dialog.isVisible()) {
        await dialog.locator(".b3-dialog__scrim").click({force: true});
        await expect(dialog).toHaveCount(0);
    }
};

export const showDock = async (page: Page) => {
    const initiallyHidden = await page.evaluate(() => window.siyuan.config.uiLayout.hideDock);
    if (initiallyHidden) {
        await page.locator("#barDock").click();
        await expect.poll(() => page.evaluate(() => window.siyuan.config.uiLayout.hideDock)).toBe(false);
    }

    return async () => {
        if (page.isClosed()) {
            return;
        }
        const hidden = await page.evaluate(() => window.siyuan.config.uiLayout.hideDock);
        if (hidden !== initiallyHidden) {
            await page.locator("#barDock").click();
            await expect.poll(() => page.evaluate(() => window.siyuan.config.uiLayout.hideDock))
                .toBe(initiallyHidden);
        }
    };
};

export const showFileTree = async (page: Page) => {
    const restoreDock = await showDock(page);
    const fileTree = page.locator(".sy__file");
    const fileTreeLogo = fileTree.locator(".block__logo:visible");
    const fileDockItem = page.locator('.dock__item[data-type="file"]').first();
    const initiallyVisible = await fileTreeLogo.isVisible();
    const dockItems = fileDockItem.locator("xpath=parent::*");
    const activeDockItem = dockItems.locator(".dock__item--activefocus").first();
    const previousDockType = await activeDockItem.count() > 0 ? await activeDockItem.getAttribute("data-type") : null;
    if (!initiallyVisible) {
        await fileDockItem.click();
        if (!await fileTreeLogo.isVisible()) {
            await fileDockItem.click();
        }
        await expect(fileTreeLogo).toBeVisible();
    }

    return async () => {
        try {
            if (!initiallyVisible) {
                if (previousDockType && previousDockType !== "file") {
                    await dockItems.locator(`.dock__item[data-type="${previousDockType}"]`).click();
                    await expect(fileTreeLogo).toBeHidden();
                } else if (await fileTreeLogo.isVisible()) {
                    await fileDockItem.click();
                    await expect(fileTreeLogo).toBeHidden();
                }
            }
        } finally {
            await restoreDock();
        }
    };
};
