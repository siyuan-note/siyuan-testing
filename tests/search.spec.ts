import {expect, test} from "./fixtures";
import {expectSearchIndex, submitSearch, withKeywordSearch} from "./helpers/search";

const uniqueMarker = (prefix: string) =>
    `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 9)}`;

test.describe("global search", () => {
    test("finds a document title and opens the result", async ({page, createTestDocument, siyuanAPI}) => {
        const titleMarker = uniqueMarker("SearchTitle");
        const document = await createTestDocument(titleMarker, "Title search target content");
        await expectSearchIndex(siyuanAPI, document.title, document.docID);

        await withKeywordSearch(page, async (search) => {
            await submitSearch(page, search, document.title);
            const result = search.results.locator(
                `[data-type="search-item"][data-root-id="${document.docID}"]`,
            ).first();
            await expect(result).toBeVisible();
            await result.dblclick();
            await expect(search.dialog).toHaveCount(0);
            await expect(page.locator(`.protyle-title[data-node-id="${document.docID}"]`)).toBeVisible();
        });
    });

    test("finds English and Chinese content in the same document", async ({page, createTestDocument, siyuanAPI}) => {
        const suffix = uniqueMarker("");
        const query = `SearchEnglish${suffix} 搜索中文${suffix}`;
        const document = await createTestDocument("Search Multilingual", query);
        await expectSearchIndex(siyuanAPI, query, document.docID);

        await withKeywordSearch(page, async (search) => {
            const response = await submitSearch(page, search, query);
            expect(response.blocks.some(block => block.rootID === document.docID)).toBe(true);
            await expect(search.results.locator(`[data-root-id="${document.docID}"]`).first()).toBeVisible();
        });
    });

    test("refreshes the index after content changes", async ({page, createTestDocument, siyuanAPI}) => {
        const oldMarker = uniqueMarker("SearchBefore");
        const newMarker = uniqueMarker("SearchAfter");
        const document = await createTestDocument("Search Update", oldMarker);
        const paragraph = document.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const blockID = await paragraph.getAttribute("data-node-id");
        expect(blockID).not.toBeNull();
        await expectSearchIndex(siyuanAPI, oldMarker, document.docID);

        await siyuanAPI.updateBlock(blockID!, newMarker);
        await expectSearchIndex(siyuanAPI, newMarker, document.docID);
        await expectSearchIndex(siyuanAPI, oldMarker, document.docID, false);

        await withKeywordSearch(page, async (search) => {
            await submitSearch(page, search, oldMarker);
            await expect(search.results.locator(`[data-root-id="${document.docID}"]`)).toHaveCount(0);
            await submitSearch(page, search, newMarker);
            await expect(search.results.locator(`[data-root-id="${document.docID}"]`).first()).toBeVisible();
        });
    });

    test("removes a deleted document from search results", async ({page, createTestDocument, siyuanAPI}) => {
        const marker = uniqueMarker("SearchDeleted");
        const document = await createTestDocument("Search Delete", marker);
        await expectSearchIndex(siyuanAPI, marker, document.docID);

        await siyuanAPI.removeDocument(document.docID);
        await expectSearchIndex(siyuanAPI, marker, document.docID, false);

        await withKeywordSearch(page, async (search) => {
            await submitSearch(page, search, marker);
            await expect(search.results.locator(`[data-root-id="${document.docID}"]`)).toHaveCount(0);
        });
    });

    test("handles wildcard and injection-shaped text as search input", async ({page, createTestDocument, siyuanAPI}) => {
        const marker = uniqueMarker("SearchSpecial");
        const query = `${marker} %_') OR ('1'='1 ${marker}`;
        const document = await createTestDocument("Search Special Characters", query);
        await expectSearchIndex(siyuanAPI, query, document.docID);

        await withKeywordSearch(page, async (search) => {
            const response = await submitSearch(page, search, query);
            expect(response.blocks.some(block => block.rootID === document.docID)).toBe(true);
            await expect(search.results.locator(`[data-root-id="${document.docID}"]`).first()).toBeVisible();
        });
    });
});
