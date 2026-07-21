import {expect, Page} from "@playwright/test";
import {IWorkspaceInfo, SiyuanAPI} from "./siyuanAPI";

export const DEFAULT_BASE_URL = "http://127.0.0.1:6806";

export const getBaseURL = () => process.env.SIYUAN_BASE_URL || DEFAULT_BASE_URL;

export const validateTestTarget = async (api: SiyuanAPI, baseURL: string) => {
    const target = new URL(baseURL);
    const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(target.hostname);
    if (!isLoopback && process.env.SIYUAN_ALLOW_REMOTE !== "1") {
        throw new Error(
            `Refusing to run against non-loopback target ${target.origin}. ` +
            "Set SIYUAN_ALLOW_REMOTE=1 only when this is an intentional test instance.",
        );
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

    const expectedWorkspace = process.env.SIYUAN_EXPECT_WORKSPACE;
    const normalizeWorkspace = (value: string) => value.replace(/[\\/]+$/, "").toLocaleLowerCase();
    if (expectedWorkspace && normalizeWorkspace(workspaceInfo.workspaceDir) !== normalizeWorkspace(expectedWorkspace)) {
        throw new Error(
            `SiYuan is using workspace ${workspaceInfo.workspaceDir}, expected ${expectedWorkspace}.`,
        );
    }

    console.log(`[siyuan-testing] Target ${target.origin}, workspace ${workspaceInfo.workspaceDir}, ` +
        `version ${workspaceInfo.siyuanVer}`);
    return workspaceInfo;
};

export const openWorkspace = async (page: Page, path = "/") => {
    const changelogResponse = page.waitForResponse(response =>
        new URL(response.url()).pathname === "/api/system/getChangelog", {timeout: 30000});
    await page.goto(path);
    await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
    const response = await changelogResponse;
    const result = await response.json() as {data?: {show?: boolean}};
    if (result.data?.show) {
        const dialog = page.locator('[data-key="dialog-changelog"]');
        await expect(dialog).toBeVisible();
        await dialog.locator(".b3-dialog__scrim").click({force: true});
        await expect(dialog).toHaveCount(0);
    }
};
