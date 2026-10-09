import {expect, Locator, Page} from "@playwright/test";

// 使用完整页面和真实内核，仅替代浏览器缺少的宿主信息与原生消息桥。
export const emulateIOSHost = async (page: Page) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, "platform", {get: () => "MacIntel"});
        Object.defineProperty(window, "webkit", {value: {messageHandlers: new Proxy({}, {
            get: () => ({postMessage: () => Promise.resolve(true)}),
        })}, configurable: true});
    });
    await page.route("**/api/system/getConf", async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.data.conf.system.container = "ios";
        await route.fulfill({response, json: body});
    });
};

export const tapOnce = async (page: Page, target: Locator, position?: {x: number; y: number}, clicks = 1) => {
    await expect(target).toBeVisible();
    // 模拟 WebKit 已发送触摸但省略兼容点击的情况，不替换应用处理器，也不重试点击。
    await page.evaluate(() => {
        const state = {start: 0, end: 0, trusted: true, clicks: 0};
        const touch = (event: TouchEvent) => {
            if (event.type === "touchstart") state.start++;
            else state.end++;
            state.trusted = state.trusted && event.isTrusted;
        };
        const click = (event: MouseEvent) => {
            if (event.isTrusted && event.detail > 0) {
                event.preventDefault();
                event.stopImmediatePropagation();
            } else if (!event.isTrusted) {
                state.clicks++;
            }
        };
        window.addEventListener("touchstart", touch, true);
        window.addEventListener("touchend", touch, true);
        window.addEventListener("click", click, true);
        Object.assign(window, {__iosTapProbe: {state, remove() {
            window.removeEventListener("touchstart", touch, true);
            window.removeEventListener("touchend", touch, true);
            window.removeEventListener("click", click, true);
        }}});
    });
    try {
        await target.tap({position});
        const state = await page.evaluate(() => (window as unknown as {
            __iosTapProbe: {state: {start: number; end: number; trusted: boolean; clicks: number}};
        }).__iosTapProbe.state);
        expect(state).toEqual({start: 1, end: 1, trusted: true, clicks});
    } finally {
        await page.evaluate(() => {
            const runtime = window as unknown as {__iosTapProbe?: {remove: () => void}};
            runtime.__iosTapProbe?.remove();
            delete runtime.__iosTapProbe;
        });
    }
};
