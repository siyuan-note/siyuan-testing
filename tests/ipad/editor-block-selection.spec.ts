import {test, expect} from "../fixtures";
import {IpadSimulator, IPoint} from "../helpers/ipadSimulator";

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

const markdown = Array.from({length: 40}, (_, index) => `iPad selection paragraph ${index + 1}`).join("\n\n");

for (const direction of ["left-vertical", "left-diagonal", "right-upward"] as const) {
    test(`${direction} touch selects exactly four blocks and preserves them after release`, async ({
        createTestDocument, baseURL,
    }, testInfo) => {
        const document = await createTestDocument(`iPad ${direction}`, markdown);
        await ipad.open(baseURL!, document.docID);
        const before = await ipad.snapshot();
        const first = before.blocks[0];
        const fourth = before.blocks[3];
        expect(first.rect.top).toBeGreaterThanOrEqual(before.content.top);
        expect(fourth.rect.bottom).toBeLessThan(before.viewport.height - 30);
        const left = first.rect.left - 12;
        const right = first.rect.right + 12;
        expect(left).toBeGreaterThan(before.editor.left);
        expect(right).toBeLessThan(before.editor.right);
        const start: IPoint = direction === "right-upward" ?
            {x: right, y: fourth.rect.bottom - 6} : {x: left, y: first.rect.top + 6};
        const end: IPoint = direction === "right-upward" ?
            {x: right, y: first.rect.top + 6} :
            {x: direction === "left-diagonal" ? first.rect.left + 120 : left, y: fourth.rect.bottom - 6};
        const after = await ipad.drag(start, end, testInfo);
        const selected = before.blocks.slice(0, 4).map(block => block.id);
        expect(after.selected).toEqual(selected);
        expect(after.events.some(event => event.type === "touchend" && event.trusted)).toBe(true);
        expect(after.tracking).toBe(false);
        expect(after.hiddenRange).toBe(false);
        expect(after.scrollTop).toBe(before.scrollTop);
        // 再次执行手势，检查上一次监听清理后仍可正常划选。
        const next = await ipad.drag(start, {...end, y: direction === "right-upward" ? before.blocks[2].rect.top + 6 :
            before.blocks[1].rect.bottom - 6}, testInfo);
        expect(next.selected).toEqual(
            (direction === "right-upward" ? before.blocks.slice(2, 4) : before.blocks.slice(0, 2))
                .map(block => block.id),
        );
    });
}

test("touch scrolling inside content does not select blocks", async ({createTestDocument, baseURL}, testInfo) => {
    const document = await createTestDocument("iPad content scrolling", markdown);
    await ipad.open(baseURL!, document.docID);
    const before = await ipad.snapshot();
    const x = before.blocks[0].rect.left + 120;
    const startY = Math.min(before.content.bottom, before.viewport.height) - 100;
    const after = await ipad.drag({x, y: startY}, {x, y: startY - 180}, testInfo);
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop + 50);
    expect(after.selected).toEqual([]);
    expect(after.tracking).toBe(false);
    expect(after.hiddenRange).toBe(false);
});
