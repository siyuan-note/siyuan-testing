import {test, expect} from "../fixtures";
import {IpadSimulator} from "../helpers/ipadSimulator";

let ipad: IpadSimulator;

for (const returnByHistory of [false, true]) {
    test(`native reading position survives returning by ${returnByHistory ? "back" : "tab"}`, async ({
        createTestDocument, baseURL, fullEntryVisibility,
    }, testInfo) => {
        test.setTimeout(300000);
        const destination = await createTestDocument("iPad reading destination", "Destination.");
        const document = await createTestDocument("iPad reading position",
            `[Next](siyuan://blocks/${destination.docID})\n\n` + Array.from({length: 70}, (_,index) =>
                `Paragraph ${index + 1}. Reading position verification. Swipe without tapping the text. ` +
                "Keep the old caret position while reading later paragraphs.").join("\n\n"));
        await ipad.open(baseURL!, document.docID);
        const tabPoint = (id: string) => ipad.evaluate<{x: number; y: number}>(`(() => {
            const editor = document.querySelector('.protyle-title[data-node-id="${id}"]').closest('.protyle');
            const tab = document.querySelector('.layout-tab-bar [data-id="' + editor.dataset.id + '"]');
            const bar = tab.parentElement;
            const tr = tab.getBoundingClientRect();
            const br = bar.getBoundingClientRect();
            if (tr.left < br.left) { bar.scrollLeft += tr.left - br.left; }
            if (tr.right > br.right) { bar.scrollLeft += tr.right - br.right; }
            const r = tab.getBoundingClientRect();
            return {x:r.left+r.width/2, y:r.top+r.height/2};
        })()`);
        const active = () => ipad.evaluate<string>(`Array.from(document.querySelectorAll('.protyle-title[data-node-id]'))
            .find(e => e.getBoundingClientRect().height > 0)?.dataset.nodeId`, true);
        await ipad.evaluate(`(() => {
            document.querySelector('.layout-tab-bar .item--focus').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
            document.querySelector('[data-href="siyuan://blocks/${destination.docID}"]').click();
            return true;
        })()`);
        await expect.poll(active).toBe(destination.docID);
        await ipad.evaluate(`(() => {
            document.querySelector('.layout-tab-bar .item--focus').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
            return true;
        })()`);
        await ipad.tap(await tabPoint(document.docID), testInfo);
        await expect.poll(active).toBe(document.docID);
        for (let index = 0; index < 3; index++) {
            const {content} = await ipad.snapshot();
            const x = content.left + (content.right-content.left)*0.75;
            await ipad.drag({x,y:content.top+(content.bottom-content.top)*0.8},
                {x,y:content.top+(content.bottom-content.top)*0.3},testInfo);
        }
        const before = await ipad.snapshot();
        expect(before.scrollTop).toBeGreaterThan(500);
        const anchor = before.blocks.find(block => block.rect.bottom > before.content.top);
        expect(anchor).toBeTruthy();
        await ipad.tap(await tabPoint(destination.docID), testInfo);
        await expect.poll(active).toBe(destination.docID);
        await ipad.tap(returnByHistory ? await ipad.controlPoint("barBack") : await tabPoint(document.docID), testInfo);
        await expect.poll(active).toBe(document.docID);
        await expect.poll(async () => {
            const after = await ipad.snapshot();
            return Math.abs(after.scrollTop-before.scrollTop);
        }).toBeLessThan(2);
        const after = await ipad.snapshot();
        expect(Math.abs(after.blocks.find(block => block.id === anchor!.id)!.rect.top-anchor!.rect.top)).toBeLessThan(2);
    });
}

test("native tab switches preserve cross-document back and forward history without body taps", async ({
    createTestDocument, baseURL, fullEntryVisibility,
}, testInfo) => {
    test.setTimeout(300000);
    const c = await createTestDocument("iPad tab C", "Third document.");
    const b = await createTestDocument("iPad tab B", `[Next](siyuan://blocks/${c.docID})`);
    const a = await createTestDocument("iPad tab A", `[Next](siyuan://blocks/${b.docID})`);
    await ipad.open(baseURL!, a.docID);
    const active = () => ipad.evaluate<string>(`(() => {
        const titles = Array.from(document.querySelectorAll('.protyle-title[data-node-id]'));
        return titles.find(title => title.getBoundingClientRect().height > 0)?.getAttribute('data-node-id');
    })()`, true);
    // 准备三个保留的页签，验证阶段仅通过系统触摸切换页签和导航按钮。
    for (const [current, next] of [[a, b], [b, c], [c, undefined]] as const) {
        await expect.poll(active).toBe(current.docID);
        await ipad.evaluate(`(() => {
            document.querySelector('.layout-tab-bar .item--focus').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
            return true;
        })()`);
        if (next) {
            await ipad.evaluate(`(() => {
                const editor = document.querySelector('.protyle-title[data-node-id="${current.docID}"]').closest('.protyle');
                editor.querySelector('[data-href="siyuan://blocks/${next.docID}"]').click();
                return true;
            })()`);
        }
    }
    for (const doc of [a, b, c]) {
        const point = await ipad.evaluate<{x: number; y: number}>(`(() => {
            const editor = document.querySelector('.protyle-title[data-node-id="${doc.docID}"]').closest('.protyle');
            const tab = document.querySelector('.layout-tab-bar [data-id="' + editor.dataset.id + '"]');
            const bar = tab.parentElement;
            const tr = tab.getBoundingClientRect();
            const br = bar.getBoundingClientRect();
            if (tr.left < br.left) { bar.scrollLeft += tr.left - br.left; }
            if (tr.right > br.right) { bar.scrollLeft += tr.right - br.right; }
            const r = tab.getBoundingClientRect();
            return {x:r.left + r.width / 2, y:r.top + r.height / 2};
        })()`);
        await ipad.tap(point, testInfo);
        await expect.poll(active).toBe(doc.docID);
    }
    for (const [control, expected] of [
        ["barBack", b], ["barBack", a], ["barForward", b], ["barForward", c],
    ] as const) {
        await ipad.tap(await ipad.controlPoint(control), testInfo);
        await expect.poll(active, {message: `${control} must display ${expected.title}`}).toBe(expected.docID);
    }
});

test.beforeAll(async () => {
    test.setTimeout(150000);
    ipad = await IpadSimulator.create();
});

test.afterEach(async () => {
    await ipad?.leave();
});

test.afterAll(async () => {
    await ipad?.close();
});

for (const revisitParagraph of [false, true]) {
    test(revisitParagraph ?
        "back restores the latest tapped text offset within the previous paragraph" :
        "native paragraph taps navigate back and forward to exact text offsets", async ({
            createTestDocument, baseURL, fullEntryVisibility,
        }, testInfo) => {
        test.setTimeout(240000);
        const document = await createTestDocument("iPad navigation history",
            "First paragraph contains enough text for precise navigation.\n\n" +
            "Second paragraph has a different navigation destination.");
        await ipad.open(baseURL!, document.docID);
        const before = await ipad.snapshot();
        expect(before.blocks).toHaveLength(2);
        const [first, second] = before.blocks;
        let firstOffset = 8;
        const secondOffset = 17;
        // 触摸坐标由指定字符边界生成，预期偏移独立于应用的导航记录和坐标命中实现。
        await ipad.tap(await ipad.textPoint(first.id, firstOffset), testInfo);
        if (revisitParagraph) {
            firstOffset = 22;
            await ipad.tap(await ipad.textPoint(first.id, firstOffset), testInfo);
        }
        await ipad.tap(await ipad.textPoint(second.id, secondOffset), testInfo);
        await ipad.tap(await ipad.controlPoint("barBack"), testInfo);
        await expect.poll(() => ipad.caret(), {
            timeout: 30000, message: "back must restore the first paragraph and its exact offset",
        })
            .toEqual({id: first.id, start: firstOffset, end: firstOffset});
        await ipad.tap(await ipad.controlPoint("barForward"), testInfo);
        await expect.poll(() => ipad.caret(), {
            timeout: 30000, message: "forward must restore the second paragraph and its exact offset",
        })
            .toEqual({id: second.id, start: secondOffset, end: secondOffset});
    });
}
