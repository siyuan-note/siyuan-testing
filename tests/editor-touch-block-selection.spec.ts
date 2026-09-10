import {test, expect} from "./fixtures";

test.use({hasTouch: true});

test("canceling a side touch selection releases tracking and allows the next gesture", async ({
    page, context, createTestDocument,
}) => {
    const {editor} = await createTestDocument("Touch selection cancellation",
        Array.from({length: 8}, (_, index) => `Cancellation paragraph ${index + 1}`).join("\n\n"));
    const blocks = editor.locator(":scope > [data-node-id]");
    const ids = await blocks.evaluateAll(elements => elements.map(element => element.getAttribute("data-node-id")));
    const first = await blocks.nth(0).boundingBox();
    const fourth = await blocks.nth(3).boundingBox();
    expect(first).toBeTruthy();
    expect(fourth).toBeTruthy();
    const session = await context.newCDPSession(page);
    let touching = false;
    const touch = async (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", x: number, y: number) => {
        await session.send("Input.dispatchTouchEvent", {
            type,
            touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{x, y, id: 1}],
        });
        touching = type === "touchStart" || type === "touchMove";
    };
    try {
        await page.evaluate(() => {
            document.addEventListener("touchcancel", event => {
                document.documentElement.dataset.testTouchCancelTrusted = String(event.isTrusted);
            }, {once: true, capture: true});
        });
        const x = first!.x - 12;
        await touch("touchStart", x, first!.y + 6);
        await touch("touchMove", x, fourth!.y + fourth!.height - 6);
        await expect.poll(() => editor.locator(".protyle-wysiwyg--select").evaluateAll(elements =>
            elements.map(element => element.getAttribute("data-node-id")))).toEqual(ids.slice(0, 4));
        await touch("touchCancel", x, fourth!.y);
        await expect(page.locator("html")).toHaveAttribute("data-test-touch-cancel-trusted", "true");
        await expect.poll(() => page.evaluate(() => !document.onmousemove && !document.onmouseup)).toBe(true);
        await expect(editor).not.toHaveClass(/protyle-wysiwyg--hiderange|fn__pointer-none/);
        const second = await blocks.nth(1).boundingBox();
        await touch("touchStart", x, first!.y + 6);
        await touch("touchMove", x, second!.y + second!.height - 6);
        await touch("touchEnd", x, second!.y);
        await expect.poll(() => editor.locator(".protyle-wysiwyg--select").evaluateAll(elements =>
            elements.map(element => element.getAttribute("data-node-id")))).toEqual(ids.slice(0, 2));
    } finally {
        if (touching) {
            await touch("touchCancel", 0, 0);
        }
        await session.detach();
    }
});
