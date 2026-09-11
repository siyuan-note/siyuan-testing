import {CDPSession, Locator, Page, Route} from "@playwright/test";
import {expect, test} from "./fixtures";
import {withKeywordSearch} from "./helpers/search";
import {getDocumentEditor} from "./helpers/testNotebook";

test.use({hasTouch: true});

const withResizeDialog = async (page: Page, action: (dialog: Locator) => Promise<void>) => {
    await withKeywordSearch(page, async ({dialog}) => {
        await expect(dialog.locator(".b3-dialog__container")).toHaveCSS("transform", "none");
        const original = await page.evaluate(() => structuredClone(window.siyuan.storage["local-dialogposition"]));
        // 隔离拖动产生的窗口位置记录，避免影响其他用例及后续启动。
        const route = async (request: Route) => {
            if (request.request().postDataJSON().key === "local-dialogposition") {
                await request.fulfill({json: {code: 0, msg: "", data: null}});
            } else {
                await request.fallback();
            }
        };
        await page.route("**/api/storage/setLocalStorageVal", route);
        try {
            await action(dialog);
        } finally {
            const openDialog = page.locator('[data-key="dialog-globalsearch"]');
            if (await openDialog.count()) {
                await openDialog.locator(".b3-dialog__scrim").click({position: {x: 5, y: 5}});
                await expect(openDialog).toHaveCount(0);
            }
            await page.evaluate(value => {
                window.siyuan.storage["local-dialogposition"] = value;
            }, original);
            await page.unroute("**/api/storage/setLocalStorageVal", route);
        }
    });
};

const touchingSessions = new WeakSet<CDPSession>();

const beginTouch = async (session: CDPSession, handle: Locator) => {
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box).toBeTruthy();
    const point = {x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, id: 1};
    await expect.poll(() => handle.evaluate((element, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit === element || element.contains(hit);
    }, point), {message: "touch point must hit the actual resize handle"}).toBe(true);
    // 使用浏览器的真实触摸输入，验证命中区域而非直接向元素派发合成事件。
    await session.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [point]});
    touchingSessions.add(session);
    return point;
};

const endTouch = async (session: CDPSession, type: "touchEnd" | "touchCancel" = "touchEnd") => {
    if (touchingSessions.delete(session)) {
        await session.send("Input.dispatchTouchEvent", {type, touchPoints: []});
    }
};

for (const direction of ["r", "l", "t", "d", "rd", "ld", "rt", "lt"]) {
    test(`touching dialog ${direction} shows a visible resize guide and releases it`, async ({
        page, context, createTestDocument,
    }) => {
        await createTestDocument(`Resize guide ${direction}`, "Resize feedback target");
        const session = await context.newCDPSession(page);
        try {
            await withResizeDialog(page, async dialog => {
                const handle = dialog.locator(`.resize__${direction}`);
                try {
                    await beginTouch(session, handle);
                    await expect(handle).toHaveClass(/touch-resize-active/);
                    const style = await handle.evaluate(element => {
                        const css = getComputedStyle(element, "::after");
                        return {
                            content: css.content,
                            pointerEvents: css.pointerEvents,
                            width: parseFloat(css.width),
                            height: parseFloat(css.height),
                            background: css.backgroundColor,
                            borders: [css.borderRightWidth, css.borderLeftWidth, css.borderTopWidth, css.borderBottomWidth],
                            radii: [css.borderBottomRightRadius, css.borderBottomLeftRadius,
                                css.borderTopRightRadius, css.borderTopLeftRadius].map(parseFloat),
                        };
                    });
                    expect(style.content).not.toBe("none");
                    expect(style.pointerEvents).toBe("none");
                    if (direction.length === 2) {
                        expect(style.width).toBeGreaterThan(60);
                        expect(style.height).toBeGreaterThan(60);
                        expect(style.borders.filter(width => parseFloat(width) > 0)).toHaveLength(2);
                        expect(Math.max(...style.radii)).toBeGreaterThan(0);
                    } else {
                        expect(Math.max(style.width, style.height)).toBeGreaterThan(60);
                        expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
                    }
                    await endTouch(session);
                    await expect(dialog.locator(".touch-resize-active")).toHaveCount(0);
                    await expect(dialog.locator("[data-touch-resize-corner]")).toHaveCount(0);
                } finally {
                    await endTouch(session, "touchCancel");
                }
            });
        } finally {
            await session.detach();
        }
    });
}

for (const reason of ["cancel", "blur"]) {
    test(`dialog resize survives ${reason} and accepts the next drag`, async ({page, context, createTestDocument}) => {
        await createTestDocument(`Resize ${reason}`, "Resize interruption target");
        const session = await context.newCDPSession(page);
        try {
            await withResizeDialog(page, async dialog => {
                const handle = dialog.locator(".resize__r");
                const container = dialog.locator(".b3-dialog__container");
                try {
                    await beginTouch(session, handle);
                    await expect(handle).toHaveClass(/touch-resize-active/);
                    if (reason === "blur") {
                        // 无头浏览器切换页面不保证窗口失焦，派发窗口事件验证已注册的清理路径。
                        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
                        await expect(dialog.locator(".touch-resize-active")).toHaveCount(0);
                    }
                    await endTouch(session, "touchCancel");
                    await expect(dialog.locator(".touch-resize-active")).toHaveCount(0);
                    const before = await container.boundingBox();
                    const point = await beginTouch(session, handle);
                    await session.send("Input.dispatchTouchEvent", {
                        type: "touchMove", touchPoints: [{...point, x: point.x - 40}],
                    });
                    await endTouch(session);
                    await expect.poll(async () => (await container.boundingBox())!.width)
                        .toBeLessThan(before!.width - 20);
                    await expect(dialog.locator(".touch-resize-active")).toHaveCount(0);
                } finally {
                    await endTouch(session, "touchCancel");
                }
            });
        } finally {
            await session.detach();
        }
    });
}

test("mouse resizing and touching the move handle do not show touch resize guides", async ({
    page, context, createTestDocument,
}) => {
    await createTestDocument("Resize input isolation", "Resize input target");
    const session = await context.newCDPSession(page);
    try {
        await withResizeDialog(page, async dialog => {
            try {
                await beginTouch(session, dialog.locator(".resize__move:visible").first());
                await expect(dialog.locator(".touch-resize-active")).toHaveCount(0);
                await endTouch(session);
                const handle = dialog.locator(".resize__r");
                await handle.hover();
                await page.mouse.down();
                await expect(dialog.locator(".touch-resize-active")).toHaveCount(0);
                await page.mouse.up();
            } finally {
                await endTouch(session, "touchCancel");
                await page.mouse.up();
            }
        });
    } finally {
        await session.detach();
    }
});

test("document tabs remain tappable after releasing a dialog resize handle", async ({
    page, context, createTestDocument,
}) => {
    const first = await createTestDocument("Resize tab first", "First tab content");
    const second = await createTestDocument("Resize tab second", "Second tab content");
    const session = await context.newCDPSession(page);
    try {
        await withResizeDialog(page, async dialog => {
            try {
                await beginTouch(session, dialog.locator(".resize__rd"));
                await endTouch(session);
                await expect(dialog.locator(".touch-resize-active")).toHaveCount(0);
            } finally {
                await endTouch(session, "touchCancel");
            }
        });
        await page.locator(".layout-tab-bar .item").filter({hasText: first.title}).first().tap();
        await expect(await getDocumentEditor(page, first.docID)).toBeVisible();
        await expect(page.locator(`.protyle-title[data-node-id="${second.docID}"]:visible`)).toHaveCount(0);
        await page.locator(".layout-tab-bar .item").filter({hasText: second.title}).first().tap();
        await expect(await getDocumentEditor(page, second.docID)).toBeVisible();
        await expect(page.locator(`.protyle-title[data-node-id="${first.docID}"]:visible`)).toHaveCount(0);
    } finally {
        await session.detach();
    }
});
