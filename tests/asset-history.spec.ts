import {expect, test} from "./fixtures";

test("creates and rolls back an asset history snapshot", async ({
    createTestDocument,
    siyuanAPI,
}) => {
    await expect(siyuanAPI.createAssetHistory("../conf/conf.json"))
        .rejects.toThrow("asset path must be under assets");
    const document = await createTestDocument("Asset History E2E", "Asset history seed");
    const filename = `asset-history-${Date.now()}.txt`;
    const original = `Original asset history content ${Date.now()}`;
    const changed = `Changed asset history content ${Date.now()}`;
    const upload = await siyuanAPI.uploadAsset(
        document.docID,
        filename,
        "text/plain",
        Buffer.from(original),
    );
    const assetPath = upload.succMap[filename];
    expect(assetPath).toMatch(/^assets\/.+\.txt$/);
    const assetFilename = assetPath.split("/").at(-1)!;
    const workspacePath = `/data/${assetPath}`;
    expect(await siyuanAPI.readWorkspaceText(workspacePath)).toBe(original);

    await siyuanAPI.createAssetHistory(assetPath);
    let snapshotPath = "";
    await expect.poll(async () => {
        const history = await siyuanAPI.searchHistory(assetFilename, "", "update", 2);
        for (const created of history.histories) {
            const items = await siyuanAPI.getHistoryItems(assetFilename, created, "update", 2);
            const snapshot = items.find(item =>
                item.title === assetFilename && item.path.endsWith(`/assets/${assetFilename}`));
            if (snapshot) {
                snapshotPath = snapshot.path;
                return snapshot;
            }
        }
        return undefined;
    }, {timeout: 30000}).toMatchObject({op: "update", title: assetFilename});
    expect(await siyuanAPI.readWorkspaceText(snapshotPath)).toBe(original);

    await siyuanAPI.writeWorkspaceFile(workspacePath, assetFilename, "text/plain", Buffer.from(changed));
    expect(await siyuanAPI.readWorkspaceText(workspacePath)).toBe(changed);
    await siyuanAPI.rollbackAssetHistory(snapshotPath);
    await expect.poll(() => siyuanAPI.readWorkspaceText(workspacePath)).toBe(original);

    await siyuanAPI.removeWorkspaceFile(workspacePath);
});
