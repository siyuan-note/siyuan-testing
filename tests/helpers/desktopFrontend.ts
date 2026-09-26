import {Page} from "@playwright/test";

// 文档导航统一加载桌面网页入口，避免客户端标识导致加载 Electron 专用资源。
export const useDesktopFrontend = async (page: Page) => {
    await page.route(/\/(?:\?.*)?$/, async route => {
        const url = new URL(route.request().url());
        if (route.request().isNavigationRequest() && url.pathname === "/") {
            url.pathname = "/stage/build/desktop/";
            await route.fulfill({status: 302, headers: {location: url.toString()}});
        } else {
            await route.continue();
        }
    });
};
