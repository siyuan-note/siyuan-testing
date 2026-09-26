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
            visible: boolean; expanded: boolean; scroll: number}>(`(() => {
            const dock = document.querySelector('.dock__item[data-type="file"]');
            const visible = !!document.querySelector('.sy__file .block__logo')?.getBoundingClientRect().height;
            const state = {hidden:window.siyuan.config.uiLayout.hideDock, visible,
                dock:dock.parentElement.querySelector('.dock__item--activefocus')?.dataset.type || null,
                expanded:!!document.querySelector('.sy__file ul[data-url="${notebook}"] .b3-list-item__arrow--open'),
                scroll:document.querySelector('.file-tree__items')?.scrollTop || 0};
            if (state.hidden) document.getElementById('barDock').click();
            if (!visible) dock.click();
            return state;
        })()`);
        const restore = async () => {
            await this.ipad.evaluate(`(() => {
                const state = ${JSON.stringify(original)};
                const root = document.querySelector('.sy__file ul[data-url="${notebook}"]');
                if (root && !!root.querySelector('.b3-list-item__arrow--open') !== state.expanded) {
                    root.querySelector('.b3-list-item__toggle').click();
                }
                document.querySelector('.file-tree__items').scrollTop = state.scroll;
                if (!state.visible) {
                    document.querySelector('.dock__item[data-type="' + (state.dock || 'file') + '"]').click();
                }
                if (window.siyuan.config.uiLayout.hideDock !== state.hidden) document.getElementById('barDock').click();
                return true;
            })()`);
        };
        try {
            await expect.poll(() => this.ipad.evaluate<boolean>(
                `!!document.querySelector('.sy__file .block__logo')?.getBoundingClientRect().height`, true)).toBe(true);
            await this.ipad.evaluate(`(() => {
                const root = document.querySelector('.sy__file ul[data-url="${notebook}"]');
                if (!root.querySelector('.b3-list-item__arrow--open')) root.querySelector('.b3-list-item__toggle').click();
                return true;
            })()`);
            return restore;
        } catch (error) {
            await restore();
            throw error;
        }
    }

    async openFromTree(id: string) {
        const selector = `.sy__file li[data-node-id="${id}"] .b3-list-item__text`;
        await expect.poll(() => this.ipad.evaluate<boolean>(
            `!!document.querySelector(${JSON.stringify(selector)})`, true)).toBe(true);
        await this.ipad.tap(await this.point(selector), this.testInfo);
        // iOS 首次触摸可能只显示悬停状态，第二次触摸才生成点击。
        const active = await this.ipad.evaluate<string>(`Array.from(document.querySelectorAll(
            '.protyle-title[data-node-id]')).find(e => e.getBoundingClientRect().height > 0)?.dataset.nodeId`, true);
        if (active !== id) await this.ipad.tap(await this.point(selector), this.testInfo);
        await this.expectDocument(id);
        await this.pinCurrentTab();
    }
}
