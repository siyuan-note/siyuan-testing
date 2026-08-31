import {Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openWorkspace} from "./helpers/runtime";

interface IBazaarConfig extends Record<string, unknown> {
    trust: boolean;
    petalDisabled: boolean;
}

interface IGlobalPluginState {
    globalPetalDisabled: boolean;
    globalPetalRevision: number;
    globalPetalChanged: boolean;
}

const openBazaarSettings = async (page: Page) => {
    await page.locator("#barWorkspace").click();
    const workspaceMenu = page.locator('.b3-menu[data-name="barWorkspace"]:not(.fn__none)');
    await expect(workspaceMenu).toBeVisible();
    await workspaceMenu.locator('[data-id="config"]').click();

    const settingsDialog = page.locator('[data-key="dialog-setting"].b3-dialog--open');
    await expect(settingsDialog.locator(".b3-dialog__container")).toBeVisible();
    await settingsDialog.locator('.config__side .b3-list-item[data-name="bazaar"]').click();
    const globalSwitch = settingsDialog.locator('[data-type="plugins-enable"]');
    await expect(globalSwitch).toBeVisible();
    return globalSwitch;
};

test("synchronizes the global plugin switch across windows", async ({
    context,
    fullEntryVisibility,
    page,
    siyuanAPI,
}) => {
    void fullEntryVisibility;
    const {conf} = await siyuanAPI.post<{conf: {bazaar: IBazaarConfig}}>("/api/system/getConf", {});
    const originalBazaar = structuredClone(conf.bazaar);
    const setBazaar = (bazaar: IBazaarConfig) => siyuanAPI.post<IBazaarConfig>("/api/setting/setBazaar", {
        ...bazaar,
        app: "plugin-global-state-e2e",
    });
    const setDisabled = (petalDisabled: boolean) => siyuanAPI.post<IGlobalPluginState>(
        "/api/setting/setBazaarPetalDisabled", {petalDisabled});
    const peer = await context.newPage();

    let releaseInstalledPlugins!: () => void;
    const installedPluginsGate = new Promise<void>((resolve) => {
        releaseInstalledPlugins = resolve;
    });
    let markInstalledPluginsRequested!: () => void;
    const installedPluginsRequested = new Promise<void>((resolve) => {
        markInstalledPluginsRequested = resolve;
    });
    const installedPluginsURL = "**/api/bazaar/getInstalledPlugin";
    let releaseDisableResponse: (() => void) | undefined;
    await page.route(installedPluginsURL, async (route) => {
        markInstalledPluginsRequested();
        await installedPluginsGate;
        await route.continue();
    });

    try {
        await setBazaar({...originalBazaar, trust: true});
        await setDisabled(false);
        await openWorkspace(page);
        await openWorkspace(peer);

        const primarySwitch = await openBazaarSettings(page);
        await installedPluginsRequested;
        await expect(primarySwitch).toBeDisabled();
        releaseInstalledPlugins();
        await expect(primarySwitch).toBeEnabled({timeout: 30000});
        await page.unroute(installedPluginsURL);

        const peerSwitch = await openBazaarSettings(peer);
        await expect(peerSwitch).toBeEnabled({timeout: 30000});
        await expect(primarySwitch).toBeChecked();
        await expect(peerSwitch).toBeChecked();

        const disableResponseGate = new Promise<void>((resolve) => {
            releaseDisableResponse = resolve;
        });
        let markDisableProcessed!: () => void;
        const disableProcessed = new Promise<void>((resolve) => {
            markDisableProcessed = resolve;
        });
        const setDisabledURL = "**/api/setting/setBazaarPetalDisabled";
        await page.route(setDisabledURL, async (route) => {
            const response = await route.fetch();
            markDisableProcessed();
            await disableResponseGate;
            await route.fulfill({response});
        });

        await primarySwitch.click();
        await disableProcessed;
        await expect(primarySwitch).toBeDisabled();
        await expect.poll(() => peer.evaluate(() => window.siyuan.config.bazaar.petalDisabled)).toBe(true);
        await expect(peerSwitch).not.toBeChecked();
        releaseDisableResponse?.();
        await expect(primarySwitch).toBeEnabled();
        await page.unroute(setDisabledURL);

        await peerSwitch.click();
        await expect.poll(() => page.evaluate(() => window.siyuan.config.bazaar.petalDisabled)).toBe(false);
        await expect(primarySwitch).toBeChecked();
        await expect(peerSwitch).toBeChecked();
    } finally {
        releaseInstalledPlugins();
        releaseDisableResponse?.();
        await page.unrouteAll({behavior: "wait"});
        if (!peer.isClosed()) {
            await peer.close();
        }
        await setBazaar(originalBazaar);
        if (!page.isClosed()) {
            await expect.poll(() => page.evaluate(() => window.siyuan.config.bazaar.petalDisabled))
                .toBe(originalBazaar.petalDisabled);
        }
    }
});
