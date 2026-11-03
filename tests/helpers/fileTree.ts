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
