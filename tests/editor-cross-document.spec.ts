import {ElementHandle, JSHandle, Locator, Page} from "@playwright/test";
import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";
import {openWorkspace} from "./helpers/runtime";

interface ISyNode {
    ID?: string;
    Data?: string;
    Properties?: Record<string, string>;
    Children?: ISyNode[];
}

const flattenNodes = (node: ISyNode): ISyNode[] => [
    node,
    ...(node.Children || []).flatMap(flattenNodes),
];

const startBlockDrag = async (page: Page, source: Locator) => {
    const id = await source.getAttribute("data-node-id");
    await page.mouse.move(0, 0);
    await source.hover();
    const handle = page.locator(`.protyle-gutters button[data-node-id="${id}"] > span[draggable="true"]`);
    await expect(handle).toBeVisible();
    const endTarget = await handle.locator("xpath=../..").elementHandle() as ElementHandle<HTMLElement>;
    expect(endTarget).not.toBeNull();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer()) as JSHandle<DataTransfer>;
    await handle.dispatchEvent("dragstart", {dataTransfer});
    await expect.poll(() => dataTransfer.evaluate(transfer => Array.from(transfer.types).join(",")))
        .toContain("nodeparagraph");
    return {dataTransfer, endTarget};
};

const finishBlockMoveAfter = async (session: Awaited<ReturnType<typeof startBlockDrag>>, target: Locator) => {
    await target.evaluate(element => element.classList.add("dragover__bottom"));
    await target.dispatchEvent("drop", {dataTransfer: session.dataTransfer});
    await session.endTarget.dispatchEvent("dragend", {dataTransfer: session.dataTransfer});
    await session.dataTransfer.dispose();
};

const revealDocument = async (page: Page, notebookID: string, docID: string) => {
    const documentItem = page.locator(`li.b3-list-item[data-type="navigation-file"][data-node-id="${docID}"]`);
    if (!await documentItem.isVisible()) {
        const notebookRoot = page.locator(
            `ul.b3-list[data-url="${notebookID}"] > li[data-type="navigation-root"]`,
        );
        await expect(notebookRoot).toBeVisible();
        if (!await notebookRoot.locator(":scope > .b3-list-item__toggle .b3-list-item__arrow--open").isVisible()) {
            await notebookRoot.locator(":scope > .b3-list-item__toggle").click({force: true});
        }
    }
    await expect(documentItem).toBeVisible({timeout: 10000});
    return documentItem;
};

test("moves a block across documents and broadcasts undo and redo", async ({
    context,
    createTestDocument,
    page,
    siyuanAPI,
    trackTestDocument,
}) => {
    const destination = await createTestDocument("Cross Document Destination E2E", "Target anchor");
    const sourceTitle = `Cross Document Source E2E ${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const sourceID = await siyuanAPI.createDocument(
        destination.notebookID,
        sourceTitle,
        "Block moving across documents\n\nSource stays",
    );
    trackTestDocument({id: sourceID, notebookID: destination.notebookID, title: sourceTitle});

    const sourcePage = await context.newPage();
    const destinationPage = await context.newPage();
    let sourceTab: Locator | undefined;
    try {
        await Promise.all([
            openWorkspace(sourcePage, `/?id=${sourceID}`),
            openWorkspace(destinationPage, `/?id=${destination.docID}`),
        ]);
        let sourceObserver = await getDocumentEditor(sourcePage, sourceID);
        let destinationObserver = await getDocumentEditor(destinationPage, destination.docID);

        const destinationEditor = destination.editor;
        const destinationTab = page.locator('li[data-type="tab-header"] .item__text')
            .filter({hasText: destination.title}).locator("xpath=..");
        await expect(destinationTab).toBeVisible();
        const sourceItem = await revealDocument(page, destination.notebookID, sourceID);
        await sourceItem.click({force: true, modifiers: ["Alt", "Control"]});
        sourceTab = page.locator('li[data-type="tab-header"] .item__text')
            .filter({hasText: sourceTitle}).locator("xpath=..");
        await expect(sourceTab).toBeVisible();
        await sourceTab.click({force: true});
        const sourceEditor = await getDocumentEditor(page, sourceID);
        const sourceBlock = sourceEditor.locator(':scope > [data-type="NodeParagraph"]')
            .filter({hasText: "Block moving across documents"});
        const sourceStay = sourceEditor.locator(':scope > [data-type="NodeParagraph"]')
            .filter({hasText: "Source stays"});
        const destinationAnchor = destinationEditor.locator(':scope > [data-type="NodeParagraph"]')
            .filter({hasText: "Target anchor"});
        const movedBlockID = await sourceBlock.getAttribute("data-node-id");
        const sourceStayID = await sourceStay.getAttribute("data-node-id");
        const destinationAnchorID = await destinationAnchor.getAttribute("data-node-id");
        expect(movedBlockID).toBeTruthy();
        expect(sourceStayID).toBeTruthy();
        expect(destinationAnchorID).toBeTruthy();

        const persistedState = async () => {
            const [sourceDocument, destinationDocument] = await Promise.all([
                siyuanAPI.readDocument<ISyNode>(sourceID),
                siyuanAPI.readDocument<ISyNode>(destination.docID),
            ]);
            const sourceNodes = flattenNodes(sourceDocument);
            const destinationNodes = flattenNodes(destinationDocument);
            const allIDs = [...sourceNodes, ...destinationNodes].flatMap(node => node.ID ? [node.ID] : []);
            return {
                destinationMovedCount: destinationNodes.filter(node => node.ID === movedBlockID).length,
                destinationTopLevel: (destinationDocument.Children || []).flatMap(node => node.ID ? [node.ID] : []),
                duplicateIDs: allIDs.length - new Set(allIDs).size,
                mismatchedPropertyIDs: [...sourceNodes, ...destinationNodes]
                    .filter(node => node.ID && node.Properties?.id && node.ID !== node.Properties.id).length,
                sourceMovedCount: sourceNodes.filter(node => node.ID === movedBlockID).length,
                sourceTopLevel: (sourceDocument.Children || []).flatMap(node => node.ID ? [node.ID] : []),
            };
        };

        const dragSession = await startBlockDrag(page, sourceBlock);
        await destinationTab.click({force: true});
        await expect(destinationEditor).toBeVisible();
        await finishBlockMoveAfter(dragSession, destinationAnchor);
        await expect(sourceBlock).toHaveCount(0);
        await expect(destinationEditor.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(1);
        await expect(sourceObserver.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(0);
        await expect(destinationObserver.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(1);
        await expect.poll(persistedState).toEqual({
            destinationMovedCount: 1,
            destinationTopLevel: [destinationAnchorID, movedBlockID],
            duplicateIDs: 0,
            mismatchedPropertyIDs: 0,
            sourceMovedCount: 0,
            sourceTopLevel: [sourceStayID],
        });

        await destinationAnchor.locator('[contenteditable="true"]').press("Control+Z");
        const confirmButton = page.locator("#confirmDialogConfirmBtn");
        await expect(confirmButton).toBeVisible();
        const confirmDialog = confirmButton.locator("xpath=ancestor::*[@data-key='dialog-confirm'][1]");
        await expect(confirmDialog.locator(".ft__breakword")).toContainText(sourceTitle);
        await expect(confirmDialog.locator(".ft__breakword")).toContainText(destination.title);
        await confirmButton.click();

        await expect(sourceEditor.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(1);
        await expect(destinationEditor.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(0);
        await expect(sourceObserver.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(1);
        await expect(destinationObserver.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(0);
        await expect.poll(persistedState).toEqual({
            destinationMovedCount: 0,
            destinationTopLevel: [destinationAnchorID],
            duplicateIDs: 0,
            mismatchedPropertyIDs: 0,
            sourceMovedCount: 1,
            sourceTopLevel: [movedBlockID, sourceStayID],
        });

        await destinationAnchor.locator('[contenteditable="true"]').press("Control+Y");
        await expect(sourceEditor.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(0);
        await expect(destinationEditor.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(1);
        await expect(sourceObserver.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(0);
        await expect(destinationObserver.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(1);
        await expect.poll(persistedState).toEqual({
            destinationMovedCount: 1,
            destinationTopLevel: [destinationAnchorID, movedBlockID],
            duplicateIDs: 0,
            mismatchedPropertyIDs: 0,
            sourceMovedCount: 0,
            sourceTopLevel: [sourceStayID],
        });

        await Promise.all([sourcePage.reload(), destinationPage.reload()]);
        sourceObserver = await getDocumentEditor(sourcePage, sourceID);
        destinationObserver = await getDocumentEditor(destinationPage, destination.docID);
        await expect(sourceObserver.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(0);
        await expect(destinationObserver.locator(`[data-node-id="${movedBlockID}"]`)).toHaveCount(1);
    } finally {
        await Promise.all([sourcePage.close(), destinationPage.close()]);
        if (sourceTab && await sourceTab.count() > 0) {
            await sourceTab.locator(".item__close").click({force: true});
        }
    }
});
