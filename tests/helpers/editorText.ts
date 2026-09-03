import {expect, Locator} from "@playwright/test";

const INTERNAL_SEMANTIC_MARKERS = /^[\u200b\u2060\ufeff]+/u;

export const expectSemanticInlineText = async (element: Locator, expected: string) => {
    await expect.poll(async () =>
        (await element.textContent() || "").replace(INTERNAL_SEMANTIC_MARKERS, ""),
    ).toBe(expected);
};
