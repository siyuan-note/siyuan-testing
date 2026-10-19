import {deepStrictEqual} from "node:assert";

interface PdfSettingsAPI {
    post<T>(path: string, data: object): Promise<T>;
}

type SavedSetting = {exists: false} | {exists: true; value: unknown};

interface PdfSettingsSnapshot {
    legacy: SavedSetting;
    appearance: SavedSetting;
}

const snapshotSetting = (settings: Record<string, unknown>, key: string): SavedSetting =>
    Object.prototype.hasOwnProperty.call(settings, key)
        ? {exists: true, value: structuredClone(settings[key])} : {exists: false};

export const readPdfSettings = async (api: PdfSettingsAPI): Promise<PdfSettingsSnapshot> => {
    // The frontend no longer loads every legacy storage key. Read persisted state
    // so an existing key is preserved even after migrating to appearance.pdfTheme.
    const [storage, {conf}] = await Promise.all([
        api.post<Record<string, unknown>>("/api/storage/getLocalStorage", {}),
        api.post<{conf: {appearance: Record<string, unknown>}}>("/api/system/getConf", {}),
    ]);
    return {
        legacy: snapshotSetting(storage, "local-pdftheme"),
        appearance: snapshotSetting(conf.appearance, "pdfTheme"),
    };
};

export const restorePdfSettings = async (api: PdfSettingsAPI, original: PdfSettingsSnapshot) => {
    const failures: unknown[] = [];
    const restore = async (path: string, data: object) => {
        try {
            await api.post(path, data);
        } catch (error) {
            failures.push(error);
        }
    };
    if (original.appearance.exists) {
        // setAppearance merges this field without resetting unrelated preferences.
        await restore("/api/setting/setAppearance", {pdfTheme: original.appearance.value});
    }
    if (original.legacy.exists) {
        await restore("/api/storage/setLocalStorageVal", {key: "local-pdftheme", val: original.legacy.value});
    } else {
        await restore("/api/storage/removeLocalStorageVal", {key: "local-pdftheme"});
    }
    if (failures.length) {
        throw new AggregateError(failures, `Could not restore PDF settings: ${failures.map(String).join("; ")}`);
    }
    deepStrictEqual(await readPdfSettings(api), original, "PDF settings were not restored in persisted state");
};

export const withPdfSettingsRestored = async (
    api: PdfSettingsAPI,
    original: PdfSettingsSnapshot,
    testInfo: {status?: string; annotations: Array<{type: string; description?: string}>},
    run: () => Promise<void>,
) => {
    let primaryFailure = false;
    try {
        await run();
    } catch (error) {
        primaryFailure = true;
        throw error;
    } finally {
        try {
            await restorePdfSettings(api, original);
        } catch (error) {
            // Playwright records assertion failures on testInfo rather than
            // necessarily rejecting use(). Preserve both kinds of primary failure.
            if (!primaryFailure && testInfo.status === "passed") throw error;
            testInfo.annotations.push({type: "pdf-settings-cleanup-failed", description: String(error)});
        }
    }
};
