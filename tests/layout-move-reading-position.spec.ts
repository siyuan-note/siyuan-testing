import {expect, test} from "./fixtures";
import {writeFile} from "node:fs/promises";
import {openWorkspace} from "./helpers/runtime";

for (const focusMode of ["reading", "cursor-at-start", "cursor-in-view"]) {
    test(`preserves reading position when dragging a split: ${focusMode}`, async ({page, createTestDocument, siyuanAPI}, testInfo) => {
        await openWorkspace(page);
        const initialLayout = await page.evaluate(() => window.siyuan.config.uiLayout);
        const markdown = Array.from({length: 80}, (_, index) =>
            `Paragraph ${String(index + 1).padStart(3, "0")} - Reading position marker. This paragraph provides enough text to wrap when the pane width changes. ` +
            "The current reading position should remain visible after moving the tab to the other side.",
        ).join("\n\n");
        try {
            await createTestDocument(`Split Reading ${focusMode}`, markdown);
            const header = page.locator('.layout__center li[data-type="tab-header"].item--focus').last();
            await header.click({button: "right"});
            const split = page.locator('#commonMenu [data-id="split"]');
            await split.hover();
            await split.locator('[data-id="splitLR"]').click();
            const panes = page.locator('.layout__center [data-type="wnd"]');
            await expect(panes).toHaveCount(2);
            const sourceHeader = panes.last().locator('li[data-type="tab-header"].item--focus');
            const tabID = await sourceHeader.getAttribute("data-id");
            const panel = page.locator(`.protyle[data-id="${tabID}"]`);
            await expect(panel).toHaveAttribute("data-loading", "finished");
            const content = panel.locator(".protyle-content");
            await expect(content).toBeVisible();
            if (focusMode === "cursor-at-start") {
                await panel.locator('.protyle-wysiwyg > [data-node-id]').first().click();
            }
            await content.hover();
            await page.mouse.wheel(0, 1700);
            await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
            // 等待滚动和布局连续稳定，避免将滚动动画计入拖动结果。
            let previous = -1;
            let stable = 0;
            await expect.poll(async () => {
                const top = await content.evaluate(element => element.scrollTop);
                stable = top === previous ? stable + 1 : 0;
                previous = top;
                return stable;
            }, {intervals: [100]}).toBeGreaterThanOrEqual(4);
            if (focusMode === "cursor-in-view") {
                const box = await content.boundingBox();
                await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
            }
            const before = await content.evaluate(element => {
                const rect = element.getBoundingClientRect();
                const blocks = Array.from(element.querySelectorAll<HTMLElement>('.protyle-wysiwyg > [data-node-id]'));
                const anchor = blocks.find(block => block.getBoundingClientRect().bottom > rect.top + 1)!;
                return {scrollTop: element.scrollTop, anchorID: anchor.dataset.nodeId!, text: anchor.textContent,
                    offset: anchor.getBoundingClientRect().top - rect.top, width: rect.width};
            });
            await page.screenshot({path: testInfo.outputPath("before.png")});
            const target = panes.first().locator(".layout-tab-container");
            const bounds = await target.boundingBox();
            const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
            await sourceHeader.dispatchEvent("dragstart", {dataTransfer});
            const coordinates = {clientX: bounds!.x + 10, clientY: bounds!.y + bounds!.height / 2};
            await target.dispatchEvent("dragenter", {dataTransfer, ...coordinates});
            const tip = panes.first().locator(".layout-tab-container__drag");
            await expect(tip).toBeVisible();
            await expect(tip).toHaveCSS("width", `${bounds!.width / 2}px`);
            const samples = await content.evaluate(async (element, options) => {
                const samples: {time: number; scrollTop: number; offset: number; width: number}[] = [];
                const start = performance.now();
                // 在同一任务内触发放置并开始采样，覆盖移动后的第一帧，避免漏掉瞬间回顶。
                const eventInit = {bubbles: true, cancelable: true, dataTransfer: options.dataTransfer, ...options.coordinates};
                options.tip!.dispatchEvent(new DragEvent("drop", eventInit));
                options.header!.dispatchEvent(new DragEvent("dragend", eventInit));
                while (performance.now() - start < 1200) {
                    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                    const rect = element.getBoundingClientRect();
                    const anchor = element.querySelector(`[data-node-id="${options.anchorID}"]`)!;
                    samples.push({time: performance.now() - start, scrollTop: element.scrollTop,
                        offset: anchor.getBoundingClientRect().top - rect.top, width: rect.width});
                }
                return samples;
            }, {anchorID: before.anchorID, tip: await tip.elementHandle(), header: await sourceHeader.elementHandle(),
                dataTransfer, coordinates});
            await expect(panes).toHaveCount(2);
            await expect(panes.first().locator(`li[data-id="${tabID}"]`)).toHaveCount(1);
            const after = samples[samples.length - 1];
            console.log(JSON.stringify({focusMode, before, after, minScroll: Math.min(...samples.map(item => item.scrollTop)),
                maxOffsetChange: Math.max(...samples.map(item => Math.abs(item.offset - before.offset)))}));
            await testInfo.attach("reading-position", {body: Buffer.from(JSON.stringify({before, samples}, null, 2)), contentType: "application/json"});
            await writeFile(testInfo.outputPath("reading-position.json"), JSON.stringify({before, samples}, null, 2));
            await page.screenshot({path: testInfo.outputPath("after.png")});
            expect(Math.abs(after.offset - before.offset), "reading anchor offset after moving the pane").toBeLessThanOrEqual(4);
            expect(Math.max(...samples.map(item => Math.abs(item.offset - before.offset))),
                "reading anchor must stay in place from the first painted frame").toBeLessThanOrEqual(4);
        } finally {
            await siyuanAPI.post("/api/system/setUILayout", {layout: initialLayout});
            await page.reload();
            await expect(page.locator("#barSearch")).toBeVisible({timeout: 30000});
        }
    });
}
