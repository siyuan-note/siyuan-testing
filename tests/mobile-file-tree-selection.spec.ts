import {devices, Locator, Page} from "@playwright/test";
import {test as base, expect} from "./fixtures";

const test = base.extend<{mobilePage: Page}>({
    mobilePage: async ({browser, baseURL}, use, testInfo) => {
        const context = await browser.newContext({...devices["iPhone 13"], baseURL});
        const page = await context.newPage();
        await use(page);
        if (testInfo.status !== "passed") {
            await testInfo.attach("mobile-page", {body: await page.screenshot(), contentType: "image/png"});
        }
        await context.close();
    },
});

const openTree = async (page: Page, docID: string, notebookID: string) => {
    await page.goto(`/stage/build/mobile/?id=${docID}`);
    await expect(page.locator("#toolbarFile")).toBeVisible({timeout: 30000});
    await page.locator("#toolbarFile").tap();
    const tree = page.locator('[data-type="sidebar-file"]');
    await expect(tree).toBeVisible();
    const notebook = tree.locator(`ul[data-url="${notebookID}"] > li[data-type="navigation-root"]`);
    await expect(notebook).toBeVisible();
    if (!await notebook.locator(".b3-list-item__arrow--open").count()) {
        await notebook.locator(".b3-list-item__toggle").tap();
    }
    return {tree, notebook, row: (id: string) => tree.locator(`li[data-type="navigation-file"][data-node-id="${id}"]`)};
};

const waitForTreeAnimation = async (page: Page) => {
    await expect.poll(() => page.locator('[data-type="sidebar-file"]').evaluate(element =>
        element.getAnimations({subtree: true}).filter(animation => animation.playState === "running").length,
    )).toBe(0);
};

const closeMenu = async (page: Page) => {
    await page.locator("#commonMenuScrim").tap({position: {x: 4, y: 4}});
    await expect(page.locator("#commonMenu")).toBeHidden();
};

const enterMultiSelect = async (page: Page, row: Locator, type = "more-file") => {
    await row.locator(`[data-type="${type}"]`).tap();
    await page.locator('#commonMenu [data-id="multiSelect"]').tap();
    const toolbar = page.locator('[data-type="sidebar-file"] > .protyle-util');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator(".multiSelectCount")).toHaveText("1");
    return toolbar;
};

test("mobile document multi-select follows open in new tab and supports empty selection and exit", async ({
    createTestDocument, mobilePage,
}) => {
    const first = await createTestDocument("Mobile tree selection first", "First document");
    const second = await createTestDocument("Mobile tree selection second", "Second document");
    const {row} = await openTree(mobilePage, first.docID, first.notebookID);
    await row(first.docID).locator('[data-type="more-file"]').tap();
    await expect(mobilePage.locator('#commonMenu [data-id="openInNewTab"] + [data-id="multiSelect"]')).toBeVisible();
    await mobilePage.locator('#commonMenu [data-id="multiSelect"]').tap();
    const toolbar = mobilePage.locator('[data-type="sidebar-file"] > .protyle-util');
    await expect(toolbar.locator(".multiSelectCount")).toHaveText("1");
    await row(second.docID).locator(".b3-list-item__text").tap();
    await expect(toolbar.locator(".multiSelectCount")).toHaveText("2");
    await expect(row(first.docID)).toHaveClass(/b3-list-item--focus/);
    await expect(row(second.docID)).toHaveClass(/b3-list-item--focus/);
    await toolbar.locator('[data-type="menu"]').tap();
    await expect(mobilePage.locator('#commonMenu [data-id="delete"]')).toBeVisible();
    await closeMenu(mobilePage);
    await row(first.docID).locator(".b3-list-item__text").tap();
    await row(second.docID).locator(".b3-list-item__text").tap();
    await expect(toolbar.locator(".multiSelectCount")).toHaveText("0");
    await expect(toolbar.locator('[data-type="menu"]')).toBeDisabled();
    await toolbar.locator('[data-type="exitMultiSelectMode"]').tap();
    await expect(toolbar).toBeHidden();
    await row(second.docID).locator(".b3-list-item__text").tap();
    await expect(mobilePage.locator("#toolbarName")).toHaveValue(second.title);
    await expect(mobilePage.locator("#editor .protyle-wysiwyg:visible")).toContainText("Second document");
});

test("mobile multi-select keeps document and notebook expansion arrows usable", async ({
    createTestDocument, mobilePage, siyuanAPI,
}) => {
    const parent = await createTestDocument("Mobile tree selection parent", "Parent document");
    const child = await createTestDocument("Mobile tree selection child", "Child document");
    await siyuanAPI.moveDocuments([child.docID], parent.docID);
    const {row, notebook} = await openTree(mobilePage, parent.docID, parent.notebookID);
    const toolbar = await enterMultiSelect(mobilePage, row(parent.docID));
    const toggle = row(parent.docID).locator(".b3-list-item__toggle");
    if (await row(parent.docID).locator(".b3-list-item__arrow--open").count()) {
        await toggle.tap();
        await expect(row(child.docID)).toHaveCount(0);
    }
    await toggle.tap();
    await expect(row(child.docID)).toBeVisible();
    await waitForTreeAnimation(mobilePage);
    await expect(toolbar.locator(".multiSelectCount")).toHaveText("1");
    await expect(row(parent.docID)).toHaveClass(/b3-list-item--focus/);
    await toggle.tap();
    await expect(row(child.docID)).toHaveCount(0);
    await expect(toolbar.locator(".multiSelectCount")).toHaveText("1");
    await notebook.locator(".b3-list-item__text").tap();
    await expect(toolbar.locator(".multiSelectCount")).toHaveText("2");
    await expect(notebook.locator(".b3-list-item__toggle")).not.toHaveClass(/fn__hidden/);
    await expect(notebook.locator(".b3-list-item__arrow")).toHaveClass(/b3-list-item__arrow--open/);
    await waitForTreeAnimation(mobilePage);
    await notebook.locator(".b3-list-item__toggle").tap();
    await expect(row(parent.docID)).toHaveCount(0);
    await expect(notebook).toHaveClass(/b3-list-item--focus/);
    await notebook.locator(".b3-list-item__toggle").tap();
    await expect(row(parent.docID)).toBeVisible();
    await expect(notebook).toHaveClass(/b3-list-item--focus/);
});

test("mobile notebook menu enters multi-select and supports mixed document selection", async ({
    createTestDocument, mobilePage,
}) => {
    const document = await createTestDocument("Mobile tree notebook selection", "Notebook selection");
    const {row, notebook} = await openTree(mobilePage, document.docID, document.notebookID);
    const toolbar = await enterMultiSelect(mobilePage, notebook, "more-root");
    await expect(notebook).toHaveClass(/b3-list-item--focus/);
    await row(document.docID).locator(".b3-list-item__text").tap();
    await expect(toolbar.locator(".multiSelectCount")).toHaveText("2");
    await toolbar.locator('[data-type="menu"]').tap();
    await expect(mobilePage.locator('#commonMenu [data-id="delete"]')).toBeVisible();
    await closeMenu(mobilePage);
    await toolbar.locator('[data-type="exitMultiSelectMode"]').tap();
    await expect(notebook).not.toHaveClass(/b3-list-item--focus/);
    await expect(row(document.docID)).not.toHaveClass(/b3-list-item--focus/);
});
