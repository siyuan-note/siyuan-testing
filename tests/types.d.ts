export {};

declare global {
    interface Window {
        siyuan: {
            config: {
                appearance: {
                    mode: number;
                    modeOS: boolean;
                    entryVisibility: {
                        active: string;
                    };
                };
                fileTree: Record<string, unknown> & {
                    docCreateTemplatePath: string;
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
            storage: Record<string, unknown>;
        };
    }
}
