import {test, expect} from "../fixtures";
import {IpadSimulator} from "../helpers/ipadSimulator";

let ipad: IpadSimulator;

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
