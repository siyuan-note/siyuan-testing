import type {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {showDock} from "./helpers/runtime";

type DockType = "bookmark" | "outline" | "tag";

test.describe("dock panel filters", () => {
    test("filters bookmark groups and restores them after clearing the query", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
        const targetBookmark = `E2EBookmarkFilterTarget${suffix}`;
        const otherBookmark = `E2EBookmarkFilterOther${suffix}`;
        const document = await createTestDocument(
            "Bookmark Filter",
            `Target bookmark block ${suffix}\n\nOther bookmark block ${suffix}`,
        );
        const paragraphs = document.editor.locator(':scope > [data-type="NodeParagraph"]');
        await expect(paragraphs).toHaveCount(2);
        const targetBlockID = await paragraphs.nth(0).getAttribute("data-node-id");
        const otherBlockID = await paragraphs.nth(1).getAttribute("data-node-id");
        expect(targetBlockID).not.toBeNull();
        expect(otherBlockID).not.toBeNull();
        await siyuanAPI.setBlockAttrs(targetBlockID!, {bookmark: targetBookmark});
        await siyuanAPI.setBlockAttrs(otherBlockID!, {bookmark: otherBookmark});
        await expect.poll(async () => {
            const bookmarks = await siyuanAPI.getBookmarks();
            return [targetBookmark, otherBookmark].every(name => bookmarks.some(item => item.name === name));
        }, {timeout: 30000}).toBe(true);

        const dock = await openDockPanel(page, "bookmark");
        try {
            const targetGroup = dock.panel.locator(
                `li[data-treetype="bookmark"][data-bookmark="${targetBookmark}"]`,
            );
            const otherGroup = dock.panel.locator(
                `li[data-treetype="bookmark"][data-bookmark="${otherBookmark}"]`,
            );
            await expect(targetGroup).toBeVisible({timeout: 15000});
            await expect(otherGroup).toBeVisible({timeout: 15000});

            await setDockFilter(dock.panel, `target${suffix}`.toLowerCase());
            await expect(targetGroup).toBeVisible();
            await expect(dock.panel.locator(
                `li[data-treetype="bookmark"][data-node-id="${targetBlockID}"]`,
            )).toBeVisible();
            await expect(otherGroup).toHaveCount(0);

            await setDockFilter(dock.panel, "");
            await expect(targetGroup).toBeVisible();
            await expect(otherGroup).toBeVisible();

            await siyuanAPI.setBlockAttrs(targetBlockID!, {bookmark: ""});
            await siyuanAPI.setBlockAttrs(otherBlockID!, {bookmark: ""});
            await expect.poll(async () => {
                const bookmarks = await siyuanAPI.getBookmarks();
                return [targetBookmark, otherBookmark].every(name => !bookmarks.some(item => item.name === name));
            }, {timeout: 30000}).toBe(true);
        } finally {
            await clearDockFilter(dock.panel);
            await dock.restore();
        }
    });

    test("keeps a matching tag's ancestor path and restores unrelated tags", async ({
        createTestDocument,
        page,
        siyuanAPI,
    }) => {
        const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
        const parentTag = `E2EFilterParent${suffix}`;
        const childTag = `E2EFilterTarget${suffix}`;
        const fullChildTag = `${parentTag}/${childTag}`;
        const otherTag = `E2EFilterOther${suffix}`;
        await createTestDocument(
            "Tag Filter",
            `Tagged content ${suffix} #${fullChildTag}# #${otherTag}#`,
        );
        await expect.poll(async () => {
            const tags = (await siyuanAPI.searchTags(childTag)).tags;
            return tags.some(tag => tag.replace(/<[^>]+>/g, "") === fullChildTag);
        }, {timeout: 30000}).toBe(true);

        const dock = await openDockPanel(page, "tag");
        try {
            const parentNode = dock.panel.locator(`li[data-treetype="tag"][data-label="${parentTag}"]`);
            const childNode = dock.panel.locator(`li[data-treetype="tag"][data-label="${fullChildTag}"]`);
            const otherNode = dock.panel.locator(`li[data-treetype="tag"][data-label="${otherTag}"]`);
            await expect(parentNode).toBeVisible({timeout: 15000});
            await expect(otherNode).toBeVisible({timeout: 15000});

            await setDockFilter(dock.panel, childTag.toLowerCase());
            await expect(parentNode).toBeVisible();
            await expect(childNode).toBeVisible();
            await expect(otherNode).toHaveCount(0);

            await setDockFilter(dock.panel, "");
            await expect(parentNode).toBeVisible();
            await expect(otherNode).toBeVisible();
        } finally {
            await clearDockFilter(dock.panel);
            await dock.restore();
        }
    });

    test("keeps a matching heading's ancestor path and restores the outline", async ({
        createTestDocument,
        page,
    }) => {
        const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
        const parentHeading = `Outline Filter Parent ${suffix}`;
        const childHeading = `Outline Filter Child Target ${suffix}`;
        const siblingHeading = `Outline Filter Sibling ${suffix}`;
        const document = await createTestDocument("Outline Filter", [
            `# ${parentHeading}`,
            "Parent body",
            `## ${childHeading}`,
            "Child body",
            `## ${siblingHeading}`,
            "Sibling body",
        ].join("\n\n"));
        const headings = document.editor.locator(':scope > [data-type="NodeHeading"]');
        await expect(headings).toHaveCount(3);
        const headingIDs = await headings.evaluateAll(elements => elements.map(
            element => element.getAttribute("data-node-id")!,
        ));

        const dock = await openDockPanel(page, "outline");
        try {
            const nodes = dock.panel.locator('li[data-treetype="outline"]');
            await expect(nodes).toHaveCount(3, {timeout: 15000});
            const parentNode = dock.panel.locator(
                `li[data-treetype="outline"][data-node-id="${headingIDs[0]}"]`,
            );
            const childNode = dock.panel.locator(
                `li[data-treetype="outline"][data-node-id="${headingIDs[1]}"]`,
            );
            if (!await childNode.isVisible()) {
                await parentNode.locator(":scope > .b3-list-item__toggle").click();
            }
            await expect(nodes.filter({visible: true})).toHaveCount(3);

            await setDockFilter(dock.panel, "target");
            const visibleNodes = nodes.filter({visible: true});
            await expect(visibleNodes).toHaveCount(2);
            await expect(visibleNodes.nth(0).locator(":scope > .b3-list-item__text")).toHaveText(parentHeading);
            await expect(visibleNodes.nth(1).locator(":scope > .b3-list-item__text")).toHaveText(childHeading);
            await expect(nodes.filter({hasText: siblingHeading}).filter({visible: true})).toHaveCount(0);

            await setDockFilter(dock.panel, "");
            await expect(nodes.filter({visible: true})).toHaveCount(3);
        } finally {
            await clearDockFilter(dock.panel);
            await dock.restore();
        }
    });
});

const openDockPanel = async (page: Page, type: DockType) => {
    const restoreDockVisibility = await showDock(page);
    const dockItem = page.locator(`.dock__item[data-type="${type}"]`).first();
    const dockItems = dockItem.locator("xpath=parent::*");
    const activeDockItem = dockItems.locator(".dock__item--activefocus, .dock__item--active").first();
    const previousDockType = await activeDockItem.count() > 0 ? await activeDockItem.getAttribute("data-type") : null;
    const panel = page.locator(`.sy__${type}:visible`).last();
    const initiallyVisible = await panel.isVisible();
    if (!initiallyVisible) {
        if (await dockItem.evaluate(element => element.classList.contains("dock__item--active"))) {
            await dockItem.click();
        }
        await dockItem.click();
    }
    await expect(panel).toBeVisible();

    return {
        panel,
        restore: async () => {
            if (page.isClosed()) {
                return;
            }
            if (previousDockType && previousDockType !== type) {
                await dockItems.locator(`.dock__item[data-type="${previousDockType}"]`).first().click();
            } else if (!initiallyVisible && await panel.isVisible()) {
                await dockItem.click();
            }
            await restoreDockVisibility();
        },
    };
};

const setDockFilter = async (panel: Locator, value: string) => {
    const input = panel.locator("input.b3-text-field.search__label");
    if (!await input.isVisible()) {
        const searchIcon = panel.locator('.block__icon[data-type="search"]');
        await panel.locator(":scope > .block__icons").hover();
        await expect(searchIcon).toBeVisible();
        await searchIcon.click();
    }
    await expect(input).toBeVisible();
    await input.fill(value);
    await expect(input).toHaveValue(value);
};

const clearDockFilter = async (panel: Locator) => {
    if (!await panel.isVisible().catch(() => false)) {
        return;
    }
    const input = panel.locator("input.b3-text-field.search__label");
    if (await input.count() === 0 || await input.inputValue() === "") {
        return;
    }
    await setDockFilter(panel, "");
};
