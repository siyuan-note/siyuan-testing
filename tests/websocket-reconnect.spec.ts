import {expect, test} from "./fixtures";
import {openWorkspace} from "./helpers/runtime";
import {getDocumentEditor} from "./helpers/testNotebook";

type E2EWindow = Window & {
    __e2eClosedWebSocket?: WebSocket;
    siyuan: Window["siyuan"] & {
        ws: {ws: WebSocket};
    };
};

test("reconnects the main WebSocket and continues receiving editor broadcasts", {tag: "@smoke"}, async ({
    context,
    createTestDocument,
    page,
    siyuanAPI,
}) => {
    const initial = `WebSocket initial ${Date.now()}`;
    const updated = `WebSocket reconnected ${Date.now()}`;
    const document = await createTestDocument("WebSocket Reconnect E2E", initial);
    const blockID = await document.editor.locator(':scope > [data-type="NodeParagraph"]').first()
        .getAttribute("data-node-id");
    expect(blockID).toBeTruthy();

    const peer = await context.newPage();
    try {
        await openWorkspace(peer, `/?id=${document.docID}`);
        const peerEditor = await getDocumentEditor(peer, document.docID);
        const peerEditable = peerEditor.locator(`[data-node-id="${blockID}"] [contenteditable="true"]`);
        await expect(peerEditable).toHaveText(initial);

        await page.evaluate(() => {
            const target = window as unknown as E2EWindow;
            target.__e2eClosedWebSocket = target.siyuan.ws.ws;
            target.siyuan.ws.ws.close();
        });
        await expect.poll(() => page.evaluate(() => {
            const target = window as unknown as E2EWindow;
            return {
                changed: target.siyuan.ws.ws !== target.__e2eClosedWebSocket,
                state: target.siyuan.ws.ws.readyState,
            };
        }), {timeout: 15000}).toEqual({changed: true, state: 1});

        await peerEditable.selectText();
        await peer.keyboard.type(updated, {delay: 5});
        await expect(peerEditable).toHaveText(updated);
        const primaryEditable = document.editor.locator(
            `[data-node-id="${blockID}"] [contenteditable="true"]`,
        );
        await expect(primaryEditable).toHaveText(updated, {timeout: 15000});
        await expect.poll(async () => JSON.stringify(await siyuanAPI.readDocument<unknown>(document.docID)), {
            timeout: 15000,
        }).toContain(updated);

        await page.reload();
        await expect((await getDocumentEditor(page, document.docID)).locator(
            `[data-node-id="${blockID}"] [contenteditable="true"]`,
        )).toHaveText(updated);
    } finally {
        await peer.close();
    }
});
