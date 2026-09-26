import {test, expect} from "../fixtures";
import {IpadSimulator} from "../helpers/ipadSimulator";
import {IpadNavigation} from "../helpers/ipadNavigation";

let ipad: IpadSimulator;

test.beforeAll(async () => {
    test.setTimeout(150000);
    ipad = await IpadSimulator.create();
});
test.afterEach(async () => { await ipad?.leave(); });
test.afterAll(async () => { await ipad?.close(); });

test("native file-tree navigation discards the old forward branch", async ({
    createTestDocument, baseURL, fullEntryVisibility,
}, testInfo) => {
    test.setTimeout(420000);
    const a = await createTestDocument("iPad history branch A", "First destination.");
    const b = await createTestDocument("iPad history branch B", "Second destination.");
    const c = await createTestDocument("iPad history branch C", "Third destination.");
    await ipad.open(baseURL!, c.docID);
    const navigation = new IpadNavigation(ipad, testInfo);
    await navigation.pinCurrentTab();
    const restore = await navigation.prepareFileTree(a.notebookID);
    try {
        for (const doc of [a, b, c]) await navigation.openFromTree(doc.docID);
        await navigation.history("barBack", b.docID);
        await navigation.history("barBack", a.docID);
        await navigation.history("barForward", b.docID);
        await navigation.history("barForward", c.docID);
        await navigation.history("barBack", b.docID);
        await navigation.openFromTree(a.docID);
        await expect.poll(() => ipad.evaluate<boolean>(
            `document.getElementById('barForward').classList.contains('toolbar__item--disabled')`, true)).toBe(true);
        await navigation.history("barBack", b.docID);
        await navigation.history("barForward", a.docID);
    } finally {
        await restore();
    }
});

for (const closeTab of [false, true]) {
    test(closeTab ? "native history reopens a closed tab at its reading position" :
        "native internal-link navigation restores the reading position", async ({
        createTestDocument, baseURL, fullEntryVisibility,
    }, testInfo) => {
        test.setTimeout(300000);
        const destination = await createTestDocument("iPad link destination", "Destination.");
        const source = await createTestDocument("iPad link reading position", Array.from({length: 85}, (_, index) =>
            `Paragraph ${index+1}. Keep this paragraph visible after navigating away and returning. ` +
            `Long reading text fills the viewport. [Go to destination](siyuan://blocks/${destination.docID})`)
            .join("\n\n"));
        await ipad.open(baseURL!, source.docID);
        const navigation = new IpadNavigation(ipad, testInfo);
        // URL 打开时可能恢复标题输入焦点，先进入无键盘的阅读状态再测导航。
        await ipad.evaluate(`(() => {
            document.activeElement?.blur();
            getSelection()?.removeAllRanges();
            return true;
        })()`);
        let previousViewport = "";
        let stableViewport = 0;
        await expect.poll(async () => {
            const viewport = await ipad.evaluate<{width: number; height: number; visible: number}>(
                `({width:innerWidth, height:innerHeight, visible:visualViewport.height})`, true);
            const value = JSON.stringify(viewport);
            stableViewport = value === previousViewport && Math.abs(viewport.height-viewport.visible) < 2 ?
                stableViewport+1 : 0;
            previousViewport = value;
            return stableViewport;
        }, {intervals: [100], timeout: 15000, message: "wait for keyboard dismissal and stable touch coordinates"})
            .toBeGreaterThanOrEqual(3);
        await navigation.pinCurrentTab();
        await ipad.tap(await navigation.point(".layout-tab-bar .item--focus"), testInfo);
        await navigation.expectDocument(source.docID);
        await navigation.swipe();
        await navigation.swipe();
        const before = await navigation.readingPosition();
        expect(before.scrollTop).toBeGreaterThan(500);
        await ipad.tap(await navigation.linkPoint(destination.docID), testInfo);
        await navigation.expectDocument(destination.docID);
        await navigation.pinCurrentTab();
        await navigation.history("barBack", source.docID);
        await navigation.expectReadingPosition(before);
        if (closeTab) {
            await ipad.tap(await navigation.point(".layout-tab-bar .item--focus .item__close"), testInfo);
            await navigation.expectDocument(destination.docID);
            await expect.poll(() => ipad.evaluate<boolean>(
                `!!document.querySelector('.protyle-title[data-node-id="${source.docID}"]')`, true)).toBe(false);
            await navigation.history("barBack", source.docID);
            await navigation.expectReadingPosition(before);
        } else {
            await navigation.history("barForward", destination.docID);
        }
    });
}
