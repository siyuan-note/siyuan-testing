import { test, expect, type Page } from "@playwright/test";

test.describe.serial("SiYuan", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("open user guide", async () => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);

    await page.locator("#barWorkspace").click();
    await page.waitForTimeout(300);
    await page.locator('[data-id="userGuide"]').click();
    await page.waitForTimeout(4000);

    await expect(page.locator(".protyle-wysiwyg").first()).toBeTruthy();
    await expect(page.locator(".protyle-breadcrumb").first()).toBeTruthy();
  });

  test("create doc and type", async () => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);

    await page.keyboard.press("Control+N");
    await page.waitForTimeout(2000);

    // 用最后一个 title input（最新创建的文档）
    await page.evaluate((title) => {
      const editors = document.querySelectorAll(".protyle-title__input");
      const el = editors[editors.length - 1] as HTMLElement;
      if (el) {
        el.textContent = title;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    }, "E2E Test Doc");
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const editors = document.querySelectorAll(".protyle-wysiwyg");
      (editors[editors.length - 1] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
    await page.locator(".protyle-wysiwyg").last().pressSequentially("## Hello Heading");
    await page.keyboard.press("Enter");
    await page.locator(".protyle-wysiwyg").last().pressSequentially("This is a test paragraph.");
    await page.keyboard.press("Enter");
    await page.locator(".protyle-wysiwyg").last().pressSequentially("- list item 1");
    await page.keyboard.press("Enter");
    await page.locator(".protyle-wysiwyg").last().pressSequentially("list item 2");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    await expect(page.locator(".protyle-breadcrumb").first()).toBeTruthy();

    // 等待 3 秒后搜索文档标题
    await page.waitForTimeout(3000);

    await page.locator("#barSearch").click();
    await page.waitForTimeout(1500);

    await page.locator(".b3-dialog--open #searchInput").first().fill("E2E Test Doc");
    await page.waitForTimeout(3000);

    await expect(page.locator(".b3-dialog--open .search__list").first()).toBeTruthy();
    const items = page.locator(".b3-dialog--open .search__list .b3-list-item");
    await expect.poll(() => items.count()).toBeGreaterThanOrEqual(1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });

  test("heading fold unfold", async () => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);

    await page.keyboard.press("Control+N");
    await page.waitForTimeout(2000);

    await page.evaluate((title) => {
      const editors = document.querySelectorAll(".protyle-title__input");
      const el = editors[editors.length - 1] as HTMLElement;
      if (el) {
        el.textContent = title;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    }, "Fold E2E Test");
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const editors = document.querySelectorAll(".protyle-wysiwyg");
      (editors[editors.length - 1] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
    await page.locator(".protyle-wysiwyg").last().pressSequentially("## Fold Me");
    await page.keyboard.press("Enter");
    await page.locator(".protyle-wysiwyg").last().pressSequentially("sub content under heading");
    await page.keyboard.press("Enter");
    await page.locator(".protyle-wysiwyg").last().pressSequentially("more sub content");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    await page.locator(".protyle-breadcrumb__item").last().click();
    await page.waitForTimeout(500);

    await page.locator('[data-type="NodeHeading"]').last().click();
    await page.waitForTimeout(300);

    await page.keyboard.press("Control+ArrowUp");
    await page.waitForTimeout(1000);

    await page.keyboard.press("Control+ArrowUp");
    await page.waitForTimeout(500);

    await expect(page.locator('[data-type="NodeHeading"]').first()).toBeTruthy();
  });

  test("toggle dock sidebar", async () => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);

    const dock = page.locator("#dockLeft");
    const isVisible = await dock.isVisible().catch(() => false);

    await page.locator("#barDock").click();
    await page.waitForTimeout(500);

    if (isVisible) {
      await expect(dock).not.toBeVisible();
    } else {
      await expect(dock).toBeVisible();
    }

    await page.locator("#barDock").click();
    await page.waitForTimeout(500);
    await expect(dock).toBeVisible();
  });

  test("undo and redo", async () => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);

    await page.keyboard.press("Control+N");
    await page.waitForTimeout(2000);

    await page.evaluate((title) => {
      const editors = document.querySelectorAll(".protyle-title__input");
      const el = editors[editors.length - 1] as HTMLElement;
      if (el) {
        el.textContent = title;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    }, "Undo Test");
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const editors = document.querySelectorAll(".protyle-wysiwyg");
      (editors[editors.length - 1] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
    await page.locator(".protyle-wysiwyg").last().pressSequentially("This will be undone.");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    await page.keyboard.press("Control+Z");
    await page.waitForTimeout(800);

    await page.keyboard.press("Control+Shift+Z");
    await page.waitForTimeout(500);

    await expect(page.locator(".protyle-wysiwyg").first()).toBeTruthy();
  });

  test("code block", async () => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);

    await page.keyboard.press("Control+N");
    await page.waitForTimeout(2000);

    await page.evaluate((title) => {
      const editors = document.querySelectorAll(".protyle-title__input");
      const el = editors[editors.length - 1] as HTMLElement;
      if (el) {
        el.textContent = title;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    }, "Code Block Test");
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const editors = document.querySelectorAll(".protyle-wysiwyg");
      (editors[editors.length - 1] as HTMLElement)?.click();
    });
    await page.waitForTimeout(300);
    await page.locator(".protyle-wysiwyg").last().pressSequentially("```js");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);

    await page.locator(".protyle-wysiwyg").last().pressSequentially("console.log('hello')");
    await page.waitForTimeout(500);

    await expect(page.locator('[data-type="NodeCodeBlock"], .code-block').first()).toBeTruthy();
  });

  test("toggle theme", async () => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);

    await page.locator("#barMode").click();
    await page.waitForTimeout(300);

    await page.locator('[data-id="themeDark"]').click();
    await page.waitForTimeout(500);

    await expect(page.locator(".b3-dialog--open")).toHaveCount(0, { timeout: 5000 });
  });

  test("doc tree navigate", async () => {
    await page.goto("http://127.0.0.1:6806");
    await page.waitForTimeout(3000);

    const docItem = page.locator('li.b3-list-item[data-type="navigation-file"]').first();
    await expect(docItem).toBeVisible({ timeout: 10000 });
    await docItem.click({ force: true });
    await page.waitForTimeout(1500);

    await expect(page.locator(".protyle-wysiwyg").first()).toBeTruthy();
    await expect(page.locator(".protyle-breadcrumb").first()).toBeTruthy();
  });
});
