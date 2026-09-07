export {};

declare global {
    interface Window {
        siyuan: {
            config: {
                keymap: {
                    general: Record<string, {default: string; custom: string}>;
                    editor: Record<string, Record<string, {default: string; custom: string}>>;
                    plugin: Record<string, unknown>;
                };
                appearance: {
                    mode: number;
                    modeOS: boolean;
                    entryVisibility: {
                        active: string;
                    };
                };
                editor: {
                    fontSize: number;
                    fontFamily: string;
                    fontWeight: number;
                    fontFamilyDisplay: string;
                    fontFamilies: Array<{
                        family: string;
                        weight: number;
                        displayName: string;
                    }>;
                };
                fileTree: Record<string, unknown> & {
                    docCreateTemplatePath: string;
                };
                bazaar: {
                    petalDisabled: boolean;
                };
                uiLayout: {
                    hideDock: boolean;
                };
            };
            languages: Record<string, string> & {
                dragTipListItemAfter: string;
                dragTipListItemBefore: string;
                dragTipListItemChild: string;
                dragTipMoveTargetBack: string;
                dragTipMoveTargetFront: string;
                move: string;
            };
            storage: Record<string, unknown>;
            touchDragActive: boolean;
        };
    }
}
