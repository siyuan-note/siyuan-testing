import {expect, Locator, Page} from "@playwright/test";

export const getNotebookTreeItem = (container: Locator | Page, notebookID: string) => container.locator(
    `li[data-type="navigation-root"][data-tree-key="notebook:${notebookID}"]`,
);

export const getTreeChild = async (tree: Locator, parent: Locator, id: string) => {
    const key = await parent.getAttribute("data-tree-key");
    expect(key).toBeTruthy();
    return tree.locator(`li[data-tree-key="${key}/${id}"]`);
};

export const isTreeChildInParentRange = (tree: Locator, parentKey: string, childKey: string) =>
    tree.evaluate((element, keys) => {
        const rows = Array.from(element.querySelectorAll("li[data-tree-key]"));
        const parentIndex = rows.findIndex(row => row.getAttribute("data-tree-key") === keys.parentKey);
        const childIndex = rows.findIndex(row => row.getAttribute("data-tree-key") === keys.childKey);
        if (parentIndex < 0 || childIndex <= parentIndex) return false;
        const parent = rows[parentIndex];
        const child = rows[childIndex];
        const parentLevel = Number(parent.getAttribute("aria-level"));
        const list = parent.closest('[role="tree"]');
        if (!Number.isFinite(parentLevel) || parentLevel < 1 || !list || list !== child.closest('[role="tree"]')) return false;
        return rows.slice(parentIndex + 1, childIndex)
            .every(row => Number(row.getAttribute("aria-level")) > parentLevel);
    }, {parentKey, childKey});

export const expectTreeChild = async (tree: Locator, parent: Locator, id: string) => {
    const child = await getTreeChild(tree, parent, id);
    await expect(child).toBeVisible({timeout: 15000});
    await expect(child).toHaveAttribute("data-node-id", id);
    const parentLevel = Number(await parent.getAttribute("aria-level"));
    expect(parentLevel).toBeGreaterThan(0);
    await expect(child).toHaveAttribute("aria-level", String(parentLevel + 1));
    const parentKey = (await parent.getAttribute("data-tree-key"))!;
    await expect.poll(() => isTreeChildInParentRange(tree, parentKey, `${parentKey}/${id}`), {
        message: "the child must remain after its parent and before the next peer or ancestor row",
    }).toBe(true);
    return child;
};

export const revealFileTreeItem = async (tree: Locator, item: Locator) => {
    const scroller = tree.locator(".file-tree__items");
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
                const container = row?.closest(".file-tree__items");
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
