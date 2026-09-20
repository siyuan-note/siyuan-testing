import {expect, test} from "./fixtures";
import {selectTextRange} from "./helpers/selection";
import {expectSemanticInlineText} from "./helpers/editorText";
import {getDocumentEditor} from "./helpers/testNotebook";
import {useDesktopFrontend} from "./helpers/desktopFrontend";

const contexts = [
    {name: "paragraph", prefix: ""},
    {name: "unordered list", prefix: "- "},
    {name: "ordered list", prefix: "1. "},
    {name: "task list", prefix: "- [ ] "},
];
const contents = [
    {name: "continuous characters", before: "", text: "1234567890".repeat(24)},
    {name: "spaces", before: "", text: "const result = example(argument); ".repeat(12)},
    {name: "preceding prose", before: "Example: ", text: "abcdefghij".repeat(24)},
];

// 验证行级代码折行后仍从首行开始：https://github.com/siyuan-note/siyuan/issues/19679
test.describe("inline code wrapping", () => {
    for (const context of contexts) {
        for (const content of contents) {
            test(`${context.name}: ${content.name} wraps without an empty first line`, async ({
                page, createTestDocument, siyuanAPI,
            }, testInfo) => {
                await useDesktopFrontend(page);
                const {editor, docID} = await createTestDocument("Inline Code Wrap E2E",
                    `${context.prefix}${content.before}\`seed\``);
                const code = editor.locator('span[data-type~="code"]').first();
                await expect.poll(async () => (await code.textContent())?.replace(/\u2060/g, "")).toBe("seed");
                await code.click();
                const offset = (await code.textContent())!.length - 1;
                await selectTextRange(code, code, offset, offset);
                await page.keyboard.insertText(content.text);
                await expect.poll(async () => (await code.textContent())?.replace(/\u2060/g, ""))
                    .toBe(`see${content.text}d`);

                for (const width of [1440, 800]) {
                    await page.setViewportSize({width, height: 900});
                    await code.scrollIntoViewIfNeeded();
                    // 逐字测量文本矩形，排除行内元素背景与内边距对首行判断的干扰。
                    const geometry = await code.evaluate(element => {
                        const editable = element.closest('[contenteditable="true"]');
                        if (!editable) {
                            throw new Error("inline code editable is missing");
                        }
                        const bounds = editable.getBoundingClientRect();
                        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                        const rects: DOMRect[] = [];
                        const splitWords: string[] = [];
                        let node: Node | null;
                        while ((node = walker.nextNode())) {
                            for (const match of node.textContent!.matchAll(/[a-z]+/gi)) {
                                const word = document.createRange();
                                word.setStart(node, match.index!);
                                word.setEnd(node, match.index! + match[0].length);
                                if (new Set(Array.from(word.getClientRects()).map(rect => Math.round(rect.top))).size > 1) {
                                    splitWords.push(match[0]);
                                }
                            }
                            for (let offset = 0; offset < (node.textContent?.length || 0); offset++) {
                                // 保留实际内容，仅跳过不可见连接字符与允许悬挂于行尾的空白。
                                if (/[\s\u2060]/.test(node.textContent![offset])) {
                                    continue;
                                }
                                const range = document.createRange();
                                range.setStart(node, offset);
                                range.setEnd(node, offset + 1);
                                rects.push(range.getBoundingClientRect());
                            }
                        }
                        const first = rects[0];
                        const marker = editable.closest('[data-type="NodeListItem"]')
                            ?.querySelector(":scope > .protyle-action")?.getBoundingClientRect();
                        return {
                            firstTop: first.top - bounds.top,
                            lineHeight: parseFloat(getComputedStyle(editable).lineHeight),
                            lines: new Set(rects.map(rect => Math.round(rect.top))).size,
                            splitWords,
                            overflow: Math.max(...rects.map(rect => rect.right - bounds.right)),
                            markerOffset: marker ? Math.abs(first.top + first.height / 2 -
                                marker.top - marker.height / 2) : null,
                        };
                    });
                    await testInfo.attach(`layout-${width}`, {
                        body: JSON.stringify(geometry, null, 2), contentType: "application/json",
                    });
                    await testInfo.attach(`editor-${width}`, {
                        body: await editor.screenshot({path: testInfo.outputPath(`editor-${width}.png`)}),
                        contentType: "image/png",
                    });
                    // 前面已有正文时允许元素整体换行；元素位于段首时不能留下空白首行。
                    expect.soft(geometry.firstTop, `first line at width ${width}`)
                        .toBeLessThan(geometry.lineHeight * (content.before ? 1.5 : 0.5));
                    expect.soft(geometry.lines, `wraps at width ${width}`).toBeGreaterThan(1);
                    expect.soft(geometry.overflow, `no horizontal overflow at width ${width}`).toBeLessThanOrEqual(1);
                    if (content.name === "spaces") {
                        expect.soft(geometry.splitWords, `preserves short words at width ${width}`).toEqual([]);
                    }
                    if (context.prefix && !content.before) {
                        expect(geometry.markerOffset).not.toBeNull();
                        expect.soft(geometry.markerOffset!, `marker alignment at width ${width}`)
                            .toBeLessThan(geometry.lineHeight / 2);
                    }
                }
                await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument(docID)))
                    .toContain(`see${content.text}d`);
                const saved = JSON.stringify(await siyuanAPI.readDocument(docID));
                expect(saved).not.toContain("\u2060");
                expect(saved).not.toContain("data-inline-boundary");
                await page.reload();
                const reloaded = await getDocumentEditor(page, docID);
                const reloadedCode = reloaded.locator('span[data-type~="code"]').first();
                await expectSemanticInlineText(reloadedCode, `see${content.text}d`);
                const firstLineOffset = await reloadedCode.evaluate(element => {
                    const range = document.createRange();
                    range.setStart(element.firstChild!, 1);
                    range.setEnd(element.firstChild!, 2);
                    const editable = element.closest('[contenteditable="true"]')!;
                    return (range.getBoundingClientRect().top - editable.getBoundingClientRect().top) /
                        parseFloat(getComputedStyle(editable).lineHeight);
                });
                expect(firstLineOffset).toBeLessThan(content.before ? 1.5 : 0.5);
            });
        }
    }
});
