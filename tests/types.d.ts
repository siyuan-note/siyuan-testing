export {};

declare global {
    interface Window {
        siyuan: {
            config: {
                appearance: {
                    mode: number;
                    modeOS: boolean;
                };
                uiLayout: {
                    hideDock: boolean;
                };
            };
            languages: Record<string, string> & {
                dragTipListItemAfter: string;
                dragTipListItemBefore: string;
                dragTipListItemChild: string;
                move: string;
            };
        };
    }
}
