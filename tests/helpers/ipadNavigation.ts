import {expect, TestInfo} from "@playwright/test";
import {IpadSimulator, IPoint} from "./ipadSimulator";

export class IpadNavigation {
    constructor(private readonly ipad: IpadSimulator, private readonly testInfo: TestInfo) {}

    async expectDocument(id: string) {
        await expect.poll(() => this.ipad.evaluate<string>(`Array.from(document.querySelectorAll(
            '.protyle-title[data-node-id]')).find(e => e.getBoundingClientRect().height > 0 &&
            e.closest('.protyle').dataset.loading === 'finished')?.dataset.nodeId`, true),
        {timeout: 15000, message: `visible document must be ${id}`}).toBe(id);
        await expect.poll(() => this.ipad.evaluate<boolean>(
            `!!document.activeElement?.closest('[contenteditable="true"]')`, true),
        {message: "reading navigation must not focus the editor"}).toBe(false);
    }

    async point(selector: string): Promise<IPoint> {
        return this.ipad.evaluate(`(() => {
            const element = document.querySelector(${JSON.stringify(selector)});
            if (!element) throw Error('Navigation target is missing');
            element.scrollIntoView({block:'nearest', inline:'nearest'});
            const rect = element.getBoundingClientRect();
            const point = {x:(rect.left+rect.right)/2, y:(rect.top+rect.bottom)/2};
            if (!rect.width || !rect.height || !element.contains(document.elementFromPoint(point.x, point.y))) {
                throw Error('Navigation target is not visible or is covered');
            }
            return point;
        })()`);
    }

    async pinCurrentTab() {
        // 固定预览页签仅用于准备数据，实际导航全部使用系统触摸。
        await this.ipad.evaluate(`(() => {
            const tab = document.querySelector('.layout-tab-bar .item--focus');
            if (tab.classList.contains('item--unupdate')) {
                tab.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
            }
            return true;
        })()`);
    }

    async history(control: "barBack" | "barForward", id: string) {
        await this.ipad.tap(await this.ipad.controlPoint(control), this.testInfo);
        await this.expectDocument(id);
    }

    async linkPoint(id: string): Promise<IPoint> {
        // 链接可能换行，逐个检查文字矩形，避免点击整段边界框中的空白。
        return this.ipad.evaluate(`(() => {
            const title = Array.from(document.querySelectorAll('.protyle-title[data-node-id]'))
                .find(e => e.getBoundingClientRect().height > 0);
            const editor = title.closest('.protyle');
            const content = editor.querySelector('.protyle-content').getBoundingClientRect();
            for (const link of editor.querySelectorAll('[data-href="siyuan://blocks/${id}"]')) {
                for (const rect of link.getClientRects()) {
                    const point = {x:(rect.left+rect.right)/2, y:(rect.top+rect.bottom)/2};
                    if (rect.top > content.top+30 && rect.bottom < content.bottom-30 &&
                        link.contains(document.elementFromPoint(point.x, point.y))) return point;
                }
            }
            throw Error('No visible internal link');
        })()`, true);
    }

    async swipe() {
        const {content} = await this.ipad.snapshot(true);
        const x = content.left + (content.right-content.left)*0.8;
        await this.ipad.drag({x, y:content.top+(content.bottom-content.top)*0.8},
            {x, y:content.top+(content.bottom-content.top)*0.25}, this.testInfo);
    }

    async readingPosition() {
        const state = await this.ipad.snapshot(true);
        const anchor = state.blocks.find(block => block.rect.bottom > state.content.top &&
            block.rect.top < state.content.bottom);
        expect(anchor, "a visible paragraph must anchor the reading position").toBeTruthy();
        return {scrollTop: state.scrollTop, id: anchor!.id, top: anchor!.rect.top};
    }

    async expectReadingPosition(before: {scrollTop: number; id: string; top: number}) {
        await expect.poll(async () => {
            const after = await this.readingPosition();
            return after.id === before.id && Math.abs(after.scrollTop-before.scrollTop) < 2 &&
                Math.abs(after.top-before.top) < 2;
        }, {timeout: 15000, message: "restore the same visible paragraph and viewport offset"}).toBe(true);
    }

    async prepareFileTree(notebook: string) {
        const original = await this.ipad.evaluate<{hidden: boolean; dock: string | null;
            visible: boolean; scroll: number}>(`(() => {
            const dock = document.querySelector('.dock__item[data-type="file"]');
            const visible = !!document.querySelector('.sy__file .block__logo')?.getBoundingClientRect().height;
            const state = {hidden:window.siyuan.config.uiLayout.hideDock, visible,
                dock:dock.parentElement.querySelector('.dock__item--activefocus')?.dataset.type || null,
                scroll:document.querySelector('.file-tree__items')?.scrollTop || 0};
            if (state.hidden) document.getElementById('barDock').click();
            if (!visible) dock.click();
            return state;
        })()`);
        const notebookSelector = `.sy__file li[data-tree-key="notebook:${notebook}"]`;
        let initiallyExpanded: boolean | undefined;
        const ensureNotebookRow = async () => {
            let offset = 0;
            // 虚拟树只挂载窗口内的行，逐页滚动等待目标行出现，不能把未挂载当作折叠。
            await expect.poll(async () => {
                const result = await this.ipad.evaluate<{ready: boolean; nextOffset: number}>(`(() => {
                    const list = document.querySelector('.sy__file .file-tree__items');
                    if (!list || !list.getBoundingClientRect().height) return {ready:false, nextOffset:0};
                    const row = document.querySelector(${JSON.stringify(notebookSelector)});
                    if (row) {
                        row.scrollIntoView({block:'nearest', inline:'nearest'});
                        const rect = row.getBoundingClientRect();
                        const viewport = list.getBoundingClientRect();
                        return {ready:rect.height > 0 && rect.width > 0 && rect.bottom > viewport.top &&
                            rect.top < viewport.bottom, nextOffset:list.scrollTop};
                    }
                    const max = Math.max(0, list.scrollHeight-list.clientHeight);
                    const next = Math.min(${offset}, max);
                    list.scrollTop = next;
                    return {ready:false, nextOffset:next >= max ? 0 :
                        Math.min(max, next+Math.max(1, list.clientHeight*0.75))};
                })()`);
                offset = result.nextOffset;
                return result.ready;
            }, {timeout: 15000, message: "wait for the notebook row to enter the virtual tree viewport"}).toBe(true);
        };
        const restore = async () => {
            try {
                if (initiallyExpanded !== undefined) {
                    await ensureNotebookRow();
                    await this.ipad.evaluate(`(() => {
                        const root = document.querySelector(${JSON.stringify(notebookSelector)});
                        if ((root.getAttribute('aria-expanded') === 'true') !== ${initiallyExpanded}) {
                            root.querySelector('.b3-list-item__toggle').click();
                        }
                        return true;
                    })()`);
                    await expect.poll(() => this.ipad.evaluate<boolean>(
                        `document.querySelector(${JSON.stringify(notebookSelector)})?.getAttribute('aria-expanded') === 'true'`,
                        true)).toBe(initiallyExpanded);
                }
            } finally {
                await this.ipad.evaluate(`(() => {
                    const state = ${JSON.stringify(original)};
                    const list = document.querySelector('.sy__file .file-tree__items');
                    if (list) list.scrollTop = state.scroll;
                    if (!state.visible) {
                        document.querySelector('.dock__item[data-type="' + (state.dock || 'file') + '"]').click();
                    }
                    if (window.siyuan.config.uiLayout.hideDock !== state.hidden) document.getElementById('barDock').click();
                    return true;
                })()`);
            }
        };
        try {
            await expect.poll(() => this.ipad.evaluate<boolean>(
                `!!document.querySelector('.sy__file .block__logo')?.getBoundingClientRect().height`, true)).toBe(true);
            await ensureNotebookRow();
            initiallyExpanded = await this.ipad.evaluate<boolean>(
                `document.querySelector(${JSON.stringify(notebookSelector)}).getAttribute('aria-expanded') === 'true'`, true);
            await this.ipad.evaluate(`(() => {
                const root = document.querySelector(${JSON.stringify(notebookSelector)});
                if (root.getAttribute('aria-expanded') !== 'true') root.querySelector('.b3-list-item__toggle').click();
                return true;
            })()`);
            await expect.poll(() => this.ipad.evaluate<boolean>(
                `document.querySelector(${JSON.stringify(notebookSelector)})?.getAttribute('aria-expanded') === 'true'`,
                true)).toBe(true);
            return restore;
        } catch (error) {
            await restore();
            throw error;
        }
    }

    async openFromTree(id: string) {
        const selector = `.sy__file li[data-node-id="${id}"] .b3-list-item__text`;
        // The notebook can be visible while its target document is outside the virtual viewport.
        await this.ipad.evaluate(`(() => {
            document.querySelector('.sy__file .file-tree__items').scrollTop = 0;
            return true;
        })()`);
        let previousVisible = "";
        await expect.poll(async () => {
            const state = await this.ipad.evaluate<{visible: boolean; position: string}>(`(() => {
                const list = document.querySelector('.sy__file .file-tree__items');
                if (!list) throw Error('File tree scroller is missing');
                const target = document.querySelector(${JSON.stringify(selector)});
                const rect = target?.getBoundingClientRect();
                const viewport = list.getBoundingClientRect();
                if (rect?.height && rect.top >= viewport.top && rect.bottom <= viewport.bottom) {
                    return {visible:true, position:JSON.stringify([rect.top, rect.bottom, list.scrollTop])};
                }
                const delta = rect ? (rect.top + rect.bottom - viewport.top - viewport.bottom) / 2 :
                    Math.max(1, Math.floor(list.clientHeight / 2));
                list.scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, list.scrollTop + delta));
                return {visible:false, position:''};
            })()`);
            const stable = state.visible && state.position === previousVisible;
            previousVisible = state.visible ? state.position : "";
            return stable;
        }, {timeout: 30000, intervals: [100], message: "native file tree target must be rendered and stably visible"})
            .toBe(true);
        await this.ipad.tap(await this.point(selector), this.testInfo);
        // iOS 首次触摸可能只显示悬停状态，第二次触摸才生成点击。
        const active = await this.ipad.evaluate<string>(`Array.from(document.querySelectorAll(
            '.protyle-title[data-node-id]')).find(e => e.getBoundingClientRect().height > 0)?.dataset.nodeId`, true);
        if (active !== id) await this.ipad.tap(await this.point(selector), this.testInfo);
        await this.expectDocument(id);
        await this.pinCurrentTab();
    }
}
