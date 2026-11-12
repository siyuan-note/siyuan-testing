import {expect, Locator} from "@playwright/test";

// Mobile uses a direct flex scroller, not the desktop .file-tree__items wrapper.
export const revealMobileFileTreeItem = async (tree: Locator, item: Locator) => {
    const scroller = tree.locator(':scope > .fn__flex-1').filter({has: tree.page().locator(':scope > [role="tree"]')});
    await expect(scroller).toBeVisible();
    const originalTop = await scroller.evaluate(element => element.scrollTop);
    const restore = async () => {
        if (await scroller.count()) await scroller.evaluate((element, top) => { element.scrollTop = top; }, originalTop);
    };
    const settleRender = () => scroller.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    try {
        await scroller.evaluate(element => { element.scrollTop = 0; });
        let previousVisible = "";
        await expect.poll(async () => {
            await settleRender();
            const position = await item.evaluateAll(elements => {
                const row = elements[0];
                const container = row?.closest('[role="tree"]')?.parentElement;
                if (!row || !container) return null;
                const rect = row.getBoundingClientRect();
                const viewport = container.getBoundingClientRect();
                return {top: rect.top, bottom: rect.bottom, viewportTop: viewport.top,
                    viewportBottom: viewport.bottom, scrollTop: container.scrollTop};
            });
            if (position && position.bottom > position.top && position.top >= position.viewportTop &&
                position.bottom <= position.viewportBottom) {
                const snapshot = JSON.stringify(position);
                const stable = snapshot === previousVisible;
                previousVisible = snapshot;
                return stable;
            }
            previousVisible = "";
            await scroller.evaluate((element, position) => {
                const delta = position ? (position.top + position.bottom -
                    position.viewportTop - position.viewportBottom) / 2 :
                    Math.max(1, Math.floor(element.clientHeight / 2));
                element.scrollTop = Math.max(0, Math.min(element.scrollHeight - element.clientHeight,
                    element.scrollTop + delta));
            }, position);
            await settleRender();
            return false;
        }, {timeout: 30000, intervals: [100], message: "scrolling the virtual file tree to a stable visible target row"}).toBe(true);
        await expect(item).toBeVisible();
        return restore;
    } catch (error) {
        await restore();
        throw error;
    }
};
