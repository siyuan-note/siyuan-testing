import {expect, test} from "./fixtures";
import {useDesktopFrontend} from "./helpers/desktopFrontend";

for (const format of [
    {type: "code", markdown: "`ordinary words remain intact`"},
    {type: "tag", markdown: "#ordinary words remain intact#"},
    {type: "kbd", markdown: "<kbd>ordinary words remain intact</kbd>"},
]) {
    test(`${format.type}: preserves short words after a long preceding token`, async ({page, createTestDocument}) => {
        await useDesktopFrontend(page);
        const {editor} = await createTestDocument("Inline Element Word Wrap E2E",
            "W".repeat(40) + " " + format.markdown);
        const inline = editor.locator(`span[data-type~="${format.type}"]`);
        for (let width = 760; width <= 1440; width += 40) {
            await page.setViewportSize({width, height: 900});
            const split = await inline.evaluate(element => {
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                const words: string[] = [];
                let node: Node | null;
                while ((node = walker.nextNode())) {
                    for (const match of node.textContent!.matchAll(/[a-z]+/gi)) {
                        const range = document.createRange();
                        range.setStart(node, match.index!);
                        range.setEnd(node, match.index! + match[0].length);
                        if (new Set(Array.from(range.getClientRects()).map(rect => Math.round(rect.top))).size > 1) {
                            words.push(match[0]);
                        }
                    }
                }
                return words;
            });
            expect.soft(split, `short words remain intact at width ${width}`).toEqual([]);
        }
    });
}
