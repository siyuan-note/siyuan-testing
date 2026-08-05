import {Locator} from "@playwright/test";

export const selectTextRange = async (startEditable: Locator, endEditable: Locator,
                                      startOffset: number, endOffset: number) => {
    const endHandle = await endEditable.elementHandle();
    if (!endHandle) {
        throw new Error("range end is unavailable");
    }
    try {
        await startEditable.evaluate((startElement, options) => {
            const getTextNode = (element: Element) =>
                document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
            const startText = getTextNode(startElement);
            const endText = getTextNode(options.endElement);
            if (!startText || !endText) {
                throw new Error("range text boundary is unavailable");
            }
            startElement.focus();
            const range = document.createRange();
            range.setStart(startText, Math.min(options.startOffset, startText.textContent?.length || 0));
            range.setEnd(endText, Math.min(options.endOffset, endText.textContent?.length || 0));
            const selection = getSelection();
            if (!selection) {
                throw new Error("selection is unavailable");
            }
            selection.removeAllRanges();
            selection.addRange(range);
        }, {endElement: endHandle, endOffset, startOffset});
    } finally {
        await endHandle.dispose();
    }
};

export const getTextRangeState = async (editor: Locator) => editor.evaluate(element => {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0) {
        return undefined;
    }
    const range = selection.getRangeAt(0);
    const getBlockID = (node: Node) => {
        const currentElement = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
        const blockElement = currentElement?.closest("[data-node-id]");
        return blockElement && element.contains(blockElement) ? blockElement.getAttribute("data-node-id") || "" : "";
    };
    return {
        collapsed: range.collapsed,
        endBlockID: getBlockID(range.endContainer),
        endOffset: range.endOffset,
        startBlockID: getBlockID(range.startContainer),
        startOffset: range.startOffset,
    };
});
