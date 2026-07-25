import {Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {openBlockMenu} from "./helpers/blockMenu";
import {getDocumentEditor} from "./helpers/testNotebook";
import {IRiffCardBlock, SiyuanAPI} from "./helpers/siyuanAPI";

const QUICK_DECK_ID = "20230218211946-2kw8jgx";

const requestTransaction = async (page: Page, action: () => Promise<void>) => {
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === "/api/transactions", {timeout: 15000});
    await action();
    expect((await response).ok()).toBe(true);
};

const chooseQuickCardAction = async (page: Page, block: Locator, action: "quickMakeCard" | "removeCard") => {
    const menu = await openBlockMenu(page, block);
    const menuItem = menu.locator(`[data-id="${action}"]`).first();
    await expect(menuItem).toBeVisible();
    await requestTransaction(page, () => menuItem.click());
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

const openDocumentReview = async (page: Page, editor: Locator) => {
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
    const response = page.waitForResponse(item =>
        new URL(item.url()).pathname === "/api/riff/getTreeRiffDueCards", {timeout: 15000});
    await reviewItem.click();
    expect((await response).ok()).toBe(true);
    const review = page.locator('[data-key="dialog-opencard"] .card__main');
    await expect(review).toBeVisible();
    return review;
};

test.describe("flashcards", () => {
    test("adds and removes a block flashcard with reload persistence", {tag: "@smoke"}, async ({
        createTestDocument,
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
        await expect(paragraph).toHaveAttribute("custom-riff-decks", QUICK_DECK_ID);

        await chooseQuickCardAction(page, paragraph, "removeCard");
        await waitForNoCards(siyuanAPI, document.docID);
        await page.reload();
        reloadedEditor = await getDocumentEditor(page, document.docID);
        await expect(reloadedEditor.locator(`[data-node-id="${blockID}"]`))
            .not.toHaveAttribute("custom-riff-decks", QUICK_DECK_ID);
    });

    test("reviews a document flashcard and persists its progress", async ({
        createTestDocument,
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
        const showAnswer = reviewDialog.locator('.card__action:not(.fn__none) button[data-type="-1"]');
        if (await showAnswer.isVisible()) {
            await showAnswer.click();
        }
        const ratingButton = reviewDialog.locator('.card__action:not(.fn__none) button[data-type="3"]');
        await expect(ratingButton).toBeVisible();
        const reviewResponse = page.waitForResponse(item =>
            new URL(item.url()).pathname === "/api/riff/reviewRiffCard", {timeout: 15000});
        await ratingButton.click();
        expect((await reviewResponse).ok()).toBe(true);
        await expect(reviewDialog.locator('[data-type="empty"]')).toBeVisible({timeout: 15000});

        await expect.poll(async () => {
            const result = await siyuanAPI.getTreeRiffCards(document.docID);
            const reviewed = result.blocks.find(item => item.id === blockID)?.riffCard;
            return reviewed ? {reps: reviewed.reps, state: reviewed.state} : undefined;
        }, {timeout: 30000}).toEqual({reps: 1, state: 1});

        await page.keyboard.press("Escape");
        await expect(reviewDialog).toBeHidden();
        await page.reload();
        const reloadedEditor = await getDocumentEditor(page, document.docID);
        paragraph = reloadedEditor.locator(`[data-node-id="${blockID}"]`);
        await expect(paragraph).toHaveAttribute("custom-riff-decks", QUICK_DECK_ID);
        const reviewedCard = (await siyuanAPI.getTreeRiffCards(document.docID)).blocks
            .find(item => item.id === blockID);
        expect(reviewedCard?.riffCard).toMatchObject({reps: 1, state: 1});

        await chooseQuickCardAction(page, paragraph, "removeCard");
        await waitForNoCards(siyuanAPI, document.docID);
    });
});
