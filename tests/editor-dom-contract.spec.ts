import {expect, test} from "@playwright/test";
import {expectTreeChild, getNotebookTreeItem, getTreeChild, isTreeChildInParentRange} from "./helpers/fileTree";
import {getTitle, isDocumentTitleFocused} from "./helpers/richTitle";
import {IpadNavigation} from "./helpers/ipadNavigation";
import type {IpadSimulator} from "./helpers/ipadSimulator";

test("file tree helpers identify flat notebook rows and exact child occurrences", async ({page}) => {
    await page.setContent(`<div class="sy__file"><ul role="tree">
        <li data-type="navigation-root" data-node-id="" data-tree-key="notebook:first" aria-level="1">First</li>
        <li data-type="navigation-file" data-node-id="parent" data-tree-key="notebook:first/parent" aria-level="2">Parent</li>
        <li data-type="navigation-file" data-node-id="child" data-tree-key="notebook:first/parent/child" aria-level="3">Child</li>
        <li data-type="navigation-root" data-node-id="" data-tree-key="notebook:second" aria-level="1">Second</li>
        <li data-type="navigation-file" data-node-id="child" data-tree-key="notebook:second/child" aria-level="2">Other occurrence</li>
    </ul></div>`);
    const tree = page.locator(".sy__file");
    const root = getNotebookTreeItem(tree, "first");
    await expect(root).toHaveText("First");
    const parent = await expectTreeChild(tree, root, "parent");
    const child = await expectTreeChild(tree, parent, "child");
    await expect(child).toHaveText("Child");
    await expect(await getTreeChild(tree, root, "child")).toHaveCount(0);
    const parentKey = "notebook:first/parent";
    const childKey = `${parentKey}/child`;
    await parent.evaluate(element => element.before(element.nextElementSibling!));
    expect(await isTreeChildInParentRange(tree, parentKey, childKey)).toBe(false);
    await parent.evaluate(element => element.after(element.previousElementSibling!));
    expect(await isTreeChildInParentRange(tree, parentKey, childKey)).toBe(true);
    await parent.evaluate(element => element.insertAdjacentHTML("afterend",
        '<li data-tree-key="notebook:first/peer" aria-level="2">Peer</li>'));
    expect(await isTreeChildInParentRange(tree, parentKey, childKey)).toBe(false);
    await tree.locator('[data-tree-key="notebook:first/peer"]').evaluate(element => element.remove());
    await getNotebookTreeItem(tree, "second").evaluate(element => element.after(element.previousElementSibling!));
    expect(await isTreeChildInParentRange(tree, parentKey, childKey)).toBe(false);
    await child.evaluate(element => element.remove());
    await expect(await getTreeChild(tree, parent, "child")).toHaveCount(0);
    await expect(await getTreeChild(tree, getNotebookTreeItem(tree, "second"), "child"))
        .toHaveText("Other occurrence");
});

test("title focus follows the rich editing host and its selection rather than the nested text node", async ({page}) => {
    await page.setContent(`<div class="protyle-title" data-node-id="doc">
        <div class="protyle-title__rich"><div class="protyle-wysiwyg" contenteditable="true">
            <div data-type="NodeParagraph"><div class="protyle-title__input" contenteditable="true">Document title</div></div>
        </div></div><div class="protyle-attr">Desktop Tablet Mobile Font family</div>
    </div><div id="body" contenteditable="true">Body</div>`);
    const title = getTitle(page, "doc");
    await expect(title).toHaveText("Document title");
    const host = page.locator(".protyle-title");
    await title.evaluate(element => {
        (element.closest(".protyle-wysiwyg") as HTMLElement).focus();
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
    });
    expect(await title.evaluate(element => element === document.activeElement)).toBe(false);
    expect(await isDocumentTitleFocused(host)).toBe(true);
    await page.locator("#body").focus();
    expect(await isDocumentTitleFocused(host)).toBe(false);
    await page.locator(".protyle-wysiwyg").focus();
    await page.evaluate(() => getSelection()!.removeAllRanges());
    expect(await isDocumentTitleFocused(host)).toBe(false);
});

for (const expanded of [false, true]) {
    test(`iPad tree preparation restores an unmounted notebook that was ${expanded ? "expanded" : "collapsed"}`,
        async ({page}, testInfo) => {
            await page.setContent(`<button id="barDock">Dock</button><div>
                <button class="dock__item dock__item--activefocus" data-type="file">Files</button></div>
                <div class="sy__file"><div class="block__logo">Files</div>
                <div class="file-tree__items" style="height:100px;overflow:auto">
                    <div style="height:600px;position:relative"></div>
                </div></div>`);
            await page.evaluate(initiallyExpanded => {
                Object.assign(window, {siyuan: {config: {uiLayout: {hideDock: false}}}});
                const list = document.querySelector<HTMLElement>(".file-tree__items")!;
                list.dataset.expanded = String(initiallyExpanded);
                const render = () => {
                    list.querySelector("li")?.remove();
                    if (list.scrollTop < 125 || list.scrollTop > 225) return;
                    const row = document.createElement("li");
                    row.dataset.treeKey = "notebook:target";
                    row.style.cssText = "position:absolute;top:200px;height:28px;width:100%";
                    row.setAttribute("aria-expanded", list.dataset.expanded!);
                    row.innerHTML = '<button class="b3-list-item__toggle">Toggle</button>Notebook';
                    row.querySelector("button")!.onclick = () => {
                        list.dataset.expanded = String(list.dataset.expanded !== "true");
                        row.setAttribute("aria-expanded", list.dataset.expanded);
                    };
                    list.firstElementChild!.appendChild(row);
                };
                list.addEventListener("scroll", () => requestAnimationFrame(render));
                list.scrollTop = 400;
                render();
            }, expanded);
            const simulator = {evaluate: (expression: string) => page.evaluate(expression)} as unknown as IpadSimulator;
            const navigation = new IpadNavigation(simulator, testInfo);
            const row = page.locator('[data-tree-key="notebook:target"]');
            await expect(row).toHaveCount(0);
            const restore = await navigation.prepareFileTree("target");
            await expect(row).toHaveAttribute("aria-expanded", "true");
            await row.locator("button").click();
            await page.locator(".file-tree__items").evaluate(element => { element.scrollTop = 400; });
            await expect(row).toHaveCount(0);
            await restore();
            await expect(page.locator(".file-tree__items")).toHaveAttribute("data-expanded", String(expanded));
            expect(await page.locator(".file-tree__items").evaluate(element => element.scrollTop)).toBe(400);
        });
}
