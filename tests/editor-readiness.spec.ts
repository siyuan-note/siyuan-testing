import {expect, test} from "./fixtures";
import {getDocumentEditor} from "./helpers/testNotebook";

test("waits for editor layout without waiting for unrelated page animations", async ({page, createTestDocument}) => {
    const {docID, editor} = await createTestDocument("Editor Readiness", "Layout readiness");
    const animations = await editor.evaluateHandle(element => {
        const width = element.getBoundingClientRect().width;
        return {
            decoration: document.body.animate([{opacity: 1}, {opacity: 0.99}], {duration: 60000}),
            layout: element.animate([{width: `${width - 100}px`}, {width: `${width}px`}], {duration: 800}),
        };
    });
    try {
        await getDocumentEditor(page, docID);
        expect(await animations.evaluate(value => value.layout.playState)).toBe("finished");
        expect(await animations.evaluate(value => value.decoration.playState)).toBe("running");
        await expect(editor).toContainText("Layout readiness");
    } finally {
        await animations.evaluate(value => {
            value.layout.cancel();
            value.decoration.cancel();
        });
        await animations.dispose();
    }
});
