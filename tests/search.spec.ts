import {expect, test} from "./fixtures";
import {
    expectSearchIndex,
    runAndWaitForSearch,
    submitSearch,
    withKeywordSearch,
    withSearchMethod,
} from "./helpers/search";

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

    test("filters results to code blocks", async ({page, createTestDocument, siyuanAPI}) => {
        const marker = uniqueMarker("SearchCodeType");
        const document = await createTestDocument(
            "Search Block Type",
            `${marker} paragraph\n\n## ${marker} heading\n\n\`\`\`text\n${marker}\n\`\`\``,
        );
        await expectSearchIndex(siyuanAPI, marker, document.docID);
        const codeBlockID = await document.editor.locator('[data-type="NodeCodeBlock"]').getAttribute("data-node-id");
        expect(codeBlockID).not.toBeNull();

        await withKeywordSearch(page, async (search) => {
            await submitSearch(page, search, marker);
            await search.dialog.locator("#searchFilter").click();
            const filterDialog = page.locator('[data-key="dialog-searchtype"] .b3-dialog__container');
            await expect(filterDialog.locator('input[data-type="codeBlock"]')).toBeVisible();
            const typeSwitches = filterDialog.locator("input[data-type]");
            for (let index = 0; index < await typeSwitches.count(); index++) {
                const typeSwitch = typeSwitches.nth(index);
                if (await typeSwitch.getAttribute("data-type") === "codeBlock") {
                    await typeSwitch.check();
                } else {
                    await typeSwitch.uncheck();
                }
            }

            const response = await runAndWaitForSearch(page, search, request =>
                request.query === marker && request.types?.codeBlock === true &&
                Object.entries(request.types).every(([type, enabled]) => type === "codeBlock" ? enabled : !enabled),
            () => filterDialog.locator(".b3-button--text").click());
            expect(response.data.blocks.length).toBeGreaterThan(0);
            expect(response.data.blocks.every(block =>
                block.id === codeBlockID && block.rootID === document.docID && block.type === "NodeCodeBlock")).toBe(true);
            await expect(search.results.locator(`[data-node-id="${codeBlockID}"]`)).toBeVisible();
        });
    });

    test("limits results to a selected document path", async ({page, createTestDocument, siyuanAPI}) => {
        const marker = uniqueMarker("SearchPath");
        const target = await createTestDocument("Search Path Target", marker);
        const other = await createTestDocument("Search Path Other", marker);
        await expectSearchIndex(siyuanAPI, marker, target.docID);
        await expectSearchIndex(siyuanAPI, marker, other.docID);
        const targetLocation = await siyuanAPI.getDocumentPath(target.docID);

        await withKeywordSearch(page, async (search) => {
            await submitSearch(page, search, marker);
            await expect(search.results.locator(`[data-root-id="${target.docID}"]`).first()).toBeVisible();
            await expect(search.results.locator(`[data-root-id="${other.docID}"]`).first()).toBeVisible();

            await search.dialog.locator("#searchPath").click();
            const pathDialog = page.locator('[data-key="dialog-movepathto"] .b3-dialog__container');
            await expect(pathDialog.locator(".b3-text-field")).toBeVisible();
            const pathResponse = page.waitForResponse((response) => {
                if (!response.url().endsWith("/api/filetree/searchDocs")) {
                    return false;
                }
                try {
                    return response.request().postDataJSON().k === target.title;
                } catch {
                    return false;
                }
            });
            await pathDialog.locator(".b3-text-field").fill(target.title);
            await pathResponse;
            const pathItem = pathDialog.locator(
                `#foldList .b3-list-item[data-box="${target.notebookID}"][data-path="${targetLocation.path}"]`,
            );
            await expect(pathItem).toBeVisible();
            await pathItem.click();

            const response = await runAndWaitForSearch(page, search, request =>
                request.query === marker && request.paths?.length === 1,
            () => pathDialog.locator(".b3-button--text").click());
            expect(response.request.paths).toEqual([`${target.notebookID}/${target.docID}`]);
            expect(response.data.blocks.some(block => block.rootID === target.docID)).toBe(true);
            expect(response.data.blocks.some(block => block.rootID === other.docID)).toBe(false);
            await expect(search.results.locator(`[data-root-id="${target.docID}"]`).first()).toBeVisible();
            await expect(search.results.locator(`[data-root-id="${other.docID}"]`)).toHaveCount(0);
        });
    });

    test("searches with query syntax", async ({page, createTestDocument, siyuanAPI}) => {
        const marker = uniqueMarker("SearchQuerySyntax");
        const document = await createTestDocument("Search Query Syntax", marker);
        await expectSearchIndex(siyuanAPI, marker, document.docID);
        const query = `"${marker}"`;

        await withSearchMethod(page, "#iconQuote", async (search) => {
            const response = await runAndWaitForSearch(page, search,
                request => request.query === query && request.method === 1,
                () => search.input.fill(query));
            expect(response.data.blocks.some(block => block.rootID === document.docID)).toBe(true);
            await expect(search.results.locator(`[data-root-id="${document.docID}"]`).first()).toBeVisible();
        });
    });

    test("searches with a regular expression", async ({page, createTestDocument, siyuanAPI}) => {
        const prefix = uniqueMarker("SearchRegex");
        const marker = `${prefix}12345`;
        const document = await createTestDocument("Search Regex", marker);
        await expectSearchIndex(siyuanAPI, marker, document.docID);
        const query = `${prefix}\\d+`;

        await withSearchMethod(page, "#iconRegex", async (search) => {
            const response = await runAndWaitForSearch(page, search,
                request => request.query === query && request.method === 3,
                () => search.input.fill(query));
            expect(response.data.blocks.some(block => block.rootID === document.docID)).toBe(true);
            await expect(search.results.locator(`[data-root-id="${document.docID}"]`).first()).toBeVisible();
        });
    });

    test("replaces the selected search result", async ({page, createTestDocument, siyuanAPI}) => {
        const oldMarker = uniqueMarker("SearchReplaceOld");
        const newMarker = uniqueMarker("SearchReplaceNew");
        const document = await createTestDocument("Search Replace", `before ${oldMarker} after`);
        await expectSearchIndex(siyuanAPI, oldMarker, document.docID);

        await withKeywordSearch(page, async (search) => {
            await submitSearch(page, search, oldMarker);
            const result = search.results.locator(`[data-root-id="${document.docID}"]`).first();
            await expect(result).toBeVisible();
            await result.click();
            await search.dialog.locator("#searchReplace").click();
            const replaceInput = search.dialog.locator("#replaceInput");
            await expect(replaceInput).toBeVisible();
            await replaceInput.fill(newMarker);

            const replaceResponse = page.waitForResponse((response) => {
                if (!response.url().endsWith("/api/search/findReplace")) {
                    return false;
                }
                try {
                    const request = response.request().postDataJSON();
                    return request.r === newMarker && request.ids.length === 1;
                } catch {
                    return false;
                }
            });
            const refreshed = runAndWaitForSearch(page, search,
                request => request.query === oldMarker && request.method === 0,
                () => search.dialog.locator("#replaceBtn").click());
            const replaceResult = await (await replaceResponse).json();
            expect(replaceResult.code).toBe(0);
            expect((await refreshed).data.blocks.some(block => block.rootID === document.docID)).toBe(false);
        });

        await expectSearchIndex(siyuanAPI, newMarker, document.docID);
        await expectSearchIndex(siyuanAPI, oldMarker, document.docID, false);
        const persisted = JSON.stringify(await siyuanAPI.readDocument(document.docID));
        expect(persisted).toContain(newMarker);
        expect(persisted).not.toContain(oldMarker);
    });
});
