import {Locator, Page, Request, Route} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openBlockMenu} from "./helpers/blockMenu";
import {getDocumentEditor} from "./helpers/testNotebook";
import {IRiffCardBlock, SiyuanAPI} from "./helpers/siyuanAPI";

const QUICK_DECK_ID = "20230218211946-2kw8jgx";

const requestFlashcardMutation = async (page: Page, action: () => Promise<void>) => {
    const response = page.waitForResponse(item =>
        ["/api/transactions", "/api/flashcard/createQuickSources"].includes(new URL(item.url()).pathname),
    {timeout: 15000});
    await action();
    expect((await response).ok()).toBe(true);
};

const chooseQuickCardAction = async (page: Page, block: Locator, action: "quickMakeCard" | "removeCard") => {
    const menu = await openBlockMenu(page, block);
    const menuItem = menu.locator(`[data-id="${action}"]`).first();
    await expect(menuItem).toBeVisible();
    await requestFlashcardMutation(page, () => menuItem.click());
};

const waitForCard = async (api: SiyuanAPI, docID: string, blockID: string) => {
    let card: IRiffCardBlock | undefined;
    await expect.poll(async () => {
        const result = await api.getTreeRiffCards(docID);
        card = result.blocks.find(item => item.id === blockID);
        return {
            blockID: card?.id || "",
            deckID: card?.ial?.["custom-riff-decks"] || "",
            total: result.total,
        };
    }, {timeout: 30000}).toEqual({blockID, deckID: QUICK_DECK_ID, total: 1});
    return card!;
};

const waitForNoCards = async (api: SiyuanAPI, docID: string) => {
    await expect.poll(async () => {
        const result = await api.getTreeRiffCards(docID);
        return {blockCount: result.blocks.length, total: result.total};
    }, {timeout: 30000}).toEqual({blockCount: 0, total: 0});
};

const clickDocumentReviewMenu = async (page: Page, editor: Locator) => {
    const protyle = editor.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' protyle ')][1]",
    );
    await protyle.locator(".protyle-title__icon").click();
    const menu = page.locator("#commonMenu:not(.fn__none)");
    const riffCardMenu = menu.locator('[data-id="riffCard"]').first();
    await expect(riffCardMenu).toBeVisible();
    await riffCardMenu.hover();
    const reviewItem = riffCardMenu.locator('.b3-menu__submenu [data-id="spaceRepetition"]').first();
    await expect(reviewItem).toBeVisible();
    const statusResponse = page.waitForResponse(item =>
        new URL(item.url()).pathname === "/api/flashcard/getMigrationStatus", {timeout: 15000});
    await reviewItem.click();
    const response = await statusResponse;
    expect(response.ok()).toBe(true);
    expect(await response.finished()).toBeNull();
};

const openDocumentReview = async (page: Page, editor: Locator) => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === "/api/flashcard/startSession", {timeout: 15000});
    await clickDocumentReviewMenu(page, editor);
    expect((await response).ok()).toBe(true);
    const review = page.locator('[data-key="dialog-opencard"]');
    await expect(review).toBeVisible();
    await expect(review.locator(".card__block")).toBeVisible();
    return review;
};

const closeReview = async (page: Page, review: Locator) => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === "/api/flashcard/finishSession", {timeout: 15000});
    await page.keyboard.press("Escape");
    await expect(review).toBeHidden();
    const finishResponse = await response;
    expect(finishResponse.ok()).toBe(true);
    expect(await finishResponse.finished()).toBeNull();
};

const closeVisibleReview = async (page: Page, review?: Locator, waitForVisible = false) => {
    const visibleReview = review ?? page.locator('[data-key="dialog-opencard"]').last();
    if (waitForVisible) {
        await visibleReview.waitFor({state: "visible", timeout: 15000}).catch(() => undefined);
    }
    if (await visibleReview.isVisible().catch(() => false)) {
        await closeReview(page, visibleReview);
    }
};

const closeReviewAndRemoveCard = async (page: Page, review: Locator, paragraph: Locator) => {
    await closeReview(page, review);
    await chooseQuickCardAction(page, paragraph, "quickMakeCard");
};

const waitForAnimationFrames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
}));

// 新版闪卡尚未发布，发布前暂不执行以下端到端测试。
test.describe.skip("flashcards", () => {
    test("adds and removes a block flashcard with reload persistence", {tag: "@smoke"}, async ({
        createTestDocument,
        fullEntryVisibility,
        page,
        siyuanAPI,
    }) => {
        const content = `Flashcard lifecycle ${Date.now()}`;
        const document = await createTestDocument("Flashcard Lifecycle E2E", content);
        let paragraph = document.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const blockID = await paragraph.getAttribute("data-node-id");
        expect(blockID).toBeTruthy();

        await chooseQuickCardAction(page, paragraph, "quickMakeCard");
        const card = await waitForCard(siyuanAPI, document.docID, blockID!);
        expect(card.content).toContain(content);
        expect(card.riffCard.reps).toBe(0);
        expect(card.riffCard.state).toBe(0);

        await page.reload();
        let reloadedEditor = await getDocumentEditor(page, document.docID);
        paragraph = reloadedEditor.locator(`[data-node-id="${blockID}"]`);
        await waitForCard(siyuanAPI, document.docID, blockID!);

        await chooseQuickCardAction(page, paragraph, "quickMakeCard");
        await waitForNoCards(siyuanAPI, document.docID);
        await page.reload();
        reloadedEditor = await getDocumentEditor(page, document.docID);
        await expect(reloadedEditor.locator(`[data-node-id="${blockID}"]`))
            .not.toHaveAttribute("custom-riff-decks", QUICK_DECK_ID);
    });

    test("reviews a document flashcard and persists its progress", async ({
        createTestDocument,
        fullEntryVisibility,
        page,
        siyuanAPI,
    }) => {
        const content = `Flashcard review ${Date.now()}`;
        const document = await createTestDocument("Flashcard Review E2E", content);
        let paragraph = document.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const blockID = await paragraph.getAttribute("data-node-id");
        expect(blockID).toBeTruthy();

        await chooseQuickCardAction(page, paragraph, "quickMakeCard");
        const initialCard = await waitForCard(siyuanAPI, document.docID, blockID!);
        const dueCards = await siyuanAPI.getTreeRiffDueCards(document.docID);
        expect(dueCards.cards).toHaveLength(1);
        expect(dueCards.cards[0]).toMatchObject({
            blockID,
            cardID: initialCard.riffCardID,
            deckID: QUICK_DECK_ID,
            reps: 0,
            state: 0,
        });

        const reviewDialog = await openDocumentReview(page, document.editor);
        await expect(reviewDialog.locator(".card__block")).toContainText(content, {timeout: 15000});
        const showAnswer = reviewDialog.locator('[data-flashcard-action="reveal"] button[data-type="show"]');
        if (await showAnswer.isVisible()) {
            await showAnswer.click();
        }
        const ratingButton = reviewDialog.locator('[data-flashcard-action="ratings"] button[data-rating="good"]');
        await expect(ratingButton).toBeVisible();
        const reviewResponse = page.waitForResponse(item =>
            new URL(item.url()).pathname === "/api/flashcard/reviewCard", {timeout: 15000});
        await ratingButton.click();
        expect((await reviewResponse).ok()).toBe(true);
        await expect(reviewDialog.locator(".card__v2-completion")).toBeVisible({timeout: 15000});

        await expect.poll(async () => {
            const result = await siyuanAPI.getTreeRiffCards(document.docID);
            const reviewed = result.blocks.find(item => item.id === blockID)?.riffCard;
            return reviewed ? {reps: reviewed.reps, state: reviewed.state} : undefined;
        }, {timeout: 30000}).toEqual({reps: 1, state: 1});

        await closeReview(page, reviewDialog);
        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        paragraph = reloadedEditor.locator(`[data-node-id="${blockID}"]`);
        const reviewedCard = (await siyuanAPI.getTreeRiffCards(document.docID)).blocks
            .find(item => item.id === blockID);
        expect(reviewedCard?.riffCard).toMatchObject({reps: 1, state: 1});

        await chooseQuickCardAction(page, paragraph, "quickMakeCard");
        await waitForNoCards(siyuanAPI, document.docID);
    });

    test("does not review a card while its content is still rendering", async ({
        createTestDocument,
        fullEntryVisibility,
        page,
        siyuanAPI,
    }) => {
        const content = `Flashcard pending render ${Date.now()}`;
        const document = await createTestDocument("Flashcard Pending Render E2E", content);
        const paragraph = document.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const blockID = await paragraph.getAttribute("data-node-id");
        expect(blockID).toBeTruthy();
        await chooseQuickCardAction(page, paragraph, "quickMakeCard");
        await waitForCard(siyuanAPI, document.docID, blockID!);

        let releaseRender!: () => void;
        const renderGate = new Promise<void>((resolve) => {
            releaseRender = resolve;
        });
        const renderPattern = "**/api/flashcard/getRenderModel";
        let reviewRequests = 0;
        const trackReviewRequest = (request: Request) => {
            if (new URL(request.url()).pathname === "/api/flashcard/reviewCard") {
                reviewRequests++;
            }
        };
        page.on("request", trackReviewRequest);
        const handleRender = async (route: Route) => {
            await renderGate;
            await route.continue();
        };
        await page.route(renderPattern, handleRender);
        let review: Locator | undefined;
        try {
            review = await openDocumentReview(page, document.editor);
            const contentElement = review.locator('.card__block[aria-busy="true"]');
            await expect(contentElement).toBeVisible();
            await expect(review.locator('[data-type="show"]')).toBeDisabled();
            await page.keyboard.press("Space");
            await page.keyboard.press("Space");

            releaseRender();
            await expect(review.locator('[data-flashcard-front]')).toContainText(content, {timeout: 15000});
            await expect(review.locator('.card__block[aria-busy="false"]')).toBeVisible();
            expect(reviewRequests).toBe(0);
        } finally {
            releaseRender();
            await page.unroute(renderPattern, handleRender);
            page.off("request", trackReviewRequest);
            await closeVisibleReview(page, review);
        }
        await chooseQuickCardAction(page, paragraph, "quickMakeCard");
        await waitForNoCards(siyuanAPI, document.docID);
    });

    test("starts only one review session while the first session is opening", async ({
        createTestDocument,
        fullEntryVisibility,
        page,
        siyuanAPI,
    }) => {
        const content = `Flashcard single session ${Date.now()}`;
        const document = await createTestDocument("Flashcard Single Session E2E", content);
        const paragraph = document.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const blockID = await paragraph.getAttribute("data-node-id");
        expect(blockID).toBeTruthy();
        await chooseQuickCardAction(page, paragraph, "quickMakeCard");
        await waitForCard(siyuanAPI, document.docID, blockID!);

        let releaseSession!: () => void;
        const sessionGate = new Promise<void>((resolve) => {
            releaseSession = resolve;
        });
        const sessionPattern = "**/api/flashcard/startSession";
        let sessionRequests = 0;
        const handleSession = async (route: Route) => {
            sessionRequests++;
            await sessionGate;
            await route.continue();
        };
        await page.route(sessionPattern, handleSession);
        let review: Locator | undefined;
        try {
            await clickDocumentReviewMenu(page, document.editor);
            await expect.poll(() => sessionRequests, {timeout: 15000}).toBe(1);
            const duplicateSessionRequest = page.waitForRequest(item =>
                new URL(item.url()).pathname === "/api/flashcard/startSession", {timeout: 1500})
                .then(() => true, (error) => {
                    if (error instanceof Error && error.name === "TimeoutError") {
                        return false;
                    }
                    throw error;
                });
            await clickDocumentReviewMenu(page, document.editor);
            expect(await duplicateSessionRequest).toBe(false);
            expect(sessionRequests).toBe(1);
            releaseSession();
            review = page.locator('[data-key="dialog-opencard"]');
            await expect(review).toHaveCount(1);
            await expect(review).toBeVisible({timeout: 15000});
            await expect(review.locator('[data-flashcard-front]')).toContainText(content, {timeout: 15000});
            expect(sessionRequests).toBe(1);
        } finally {
            releaseSession();
            await page.unroute(sessionPattern, handleSession);
            await closeVisibleReview(page, review, sessionRequests > 0);
        }
        await chooseQuickCardAction(page, paragraph, "quickMakeCard");
        await waitForNoCards(siyuanAPI, document.docID);
    });

    test("reveals children of a folded heading flashcard", async ({
        createTestDocument,
        fullEntryVisibility,
        page,
        siyuanAPI,
    }) => {
        const suffix = Date.now();
        const question = `Folded flashcard question ${suffix}`;
        const answer = `Folded flashcard answer ${suffix}`;
        const document = await createTestDocument("Flashcard Folded Heading E2E", `# ${question}\n\n${answer}`);
        let heading = document.editor.locator(':scope > [data-type="NodeHeading"]').first();
        const headingID = await heading.getAttribute("data-node-id");
        expect(headingID).toBeTruthy();
        await chooseQuickCardAction(page, heading, "quickMakeCard");
        await waitForCard(siyuanAPI, document.docID, headingID!);
        await siyuanAPI.setBlockAttrs(headingID!, {fold: "1"});
        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        heading = reloadedEditor.locator(`[data-node-id="${headingID}"]`);
        await expect(heading).toHaveAttribute("fold", "1");

        const review = await openDocumentReview(page, reloadedEditor);
        await expect(review.locator('[data-flashcard-front]')).toContainText(question, {timeout: 15000});
        const showAnswer = review.locator('[data-flashcard-action="reveal"] [data-type="show"]');
        await expect(showAnswer).toBeVisible();
        await showAnswer.click();
        await expect(review.getByText(answer, {exact: true})).toBeVisible();

        await closeReviewAndRemoveCard(page, review, heading);
        await waitForNoCards(siyuanAPI, document.docID);
    });

    test("keeps review rating controls inside the dialog at narrow widths", async ({
        createTestDocument,
        fullEntryVisibility,
        page,
        siyuanAPI,
    }) => {
        const content = `Flashcard responsive actions ${Date.now()}`;
        const document = await createTestDocument("Flashcard Responsive Actions E2E", content);
        const paragraph = document.editor.locator(':scope > [data-type="NodeParagraph"]').first();
        const blockID = await paragraph.getAttribute("data-node-id");
        expect(blockID).toBeTruthy();
        await chooseQuickCardAction(page, paragraph, "quickMakeCard");
        await waitForCard(siyuanAPI, document.docID, blockID!);
        const review = await openDocumentReview(page, document.editor);
        await expect(review.locator('[data-flashcard-front]')).toContainText(content, {timeout: 15000});
        const showAnswer = review.locator('[data-flashcard-action="reveal"] [data-type="show"]');
        if (await showAnswer.isVisible()) {
            await showAnswer.click();
        }
        const ratings = review.locator('[data-flashcard-action="ratings"]');
        await expect(ratings).toBeVisible();

        const originalViewport = page.viewportSize();
        try {
            await page.setViewportSize({width: 520, height: 720});
            await waitForAnimationFrames(page);
            const layout = await ratings.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                const dialog = element.closest('[data-key="dialog-opencard"]')
                    ?.querySelector(".b3-dialog__container")?.getBoundingClientRect();
                const buttons = Array.from(element.querySelectorAll("button"))
                    .map((button) => button.getBoundingClientRect());
                const inside = (inner: DOMRect, outer: Pick<DOMRect, "bottom" | "left" | "right" | "top">) =>
                    inner.left >= outer.left - 1 && inner.right <= outer.right + 1 &&
                    inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
                return {
                    clientWidth: element.clientWidth,
                    scrollWidth: element.scrollWidth,
                    buttonsInside: buttons.every((button) => inside(button, bounds)),
                    dialogInsideViewport: dialog ? inside(dialog, {
                        bottom: window.innerHeight,
                        left: 0,
                        right: window.innerWidth,
                        top: 0,
                    }) : false,
                    ratingsInsideDialog: dialog ? inside(bounds, dialog) : false,
                    ratingsInsideViewport: inside(bounds, {
                        bottom: window.innerHeight,
                        left: 0,
                        right: window.innerWidth,
                        top: 0,
                    }),
                };
            });
            expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
            expect(layout.buttonsInside).toBe(true);
            expect(layout.dialogInsideViewport).toBe(true);
            expect(layout.ratingsInsideDialog).toBe(true);
            expect(layout.ratingsInsideViewport).toBe(true);
        } finally {
            if (originalViewport) {
                await page.setViewportSize(originalViewport);
                await waitForAnimationFrames(page);
            }
        }

        await closeReviewAndRemoveCard(page, review, paragraph);
        await waitForNoCards(siyuanAPI, document.docID);
    });
});
