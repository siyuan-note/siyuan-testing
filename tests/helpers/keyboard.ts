export const PRIMARY_MODIFIER = "ControlOrMeta" as const;
export const UNDO_SHORTCUT = "ControlOrMeta+Z";
export const REDO_SHORTCUT = process.platform === "darwin" ? "Meta+Shift+Z" : "Control+Y";
