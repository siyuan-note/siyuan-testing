import {expect, test} from "./fixtures";

const REQUIRED_ID_ENDPOINTS = [
    "/api/filetree/getDoc",
    "/api/filetree/getPathByID",
    "/api/filetree/removeDocByID",
    "/api/block/getBlockInfo",
];

test.describe("API robustness", () => {
    test.describe.configure({mode: "parallel"});

    for (const endpoint of REQUIRED_ID_ENDPOINTS) {
        test(`${endpoint} rejects missing, mistyped, and invalid IDs`, async ({siyuanAPI}) => {
            const missing = await siyuanAPI.postResult<unknown>(endpoint, {});
            expect(missing).toMatchObject({
                code: -1,
                msg: "Field [id] is required",
            });

            const mistyped = await siyuanAPI.postResult<unknown>(endpoint, {id: 42});
            expect(mistyped).toMatchObject({
                code: -1,
                msg: "Field [id] should be of type [String]",
            });

            const invalid = await siyuanAPI.postResult<unknown>(endpoint, {id: "invalid-id"});
            expect(invalid).toMatchObject({
                code: -1,
                msg: "invalid ID argument",
            });

            await expect(siyuanAPI.getWorkspaceInfo()).resolves.toMatchObject({
                workspaceDir: expect.any(String),
            });
        });
    }

    test("document APIs return business errors for a nonexistent document", async ({siyuanAPI}) => {
        const id = "29991231235959-zzzzzzz";
        const cases = [
            {endpoint: "/api/filetree/getDoc", code: 1},
            {endpoint: "/api/filetree/getPathByID", code: -1},
            {endpoint: "/api/filetree/removeDocByID", code: -1},
        ];
        for (const item of cases) {
            const result = await siyuanAPI.postResult<unknown>(item.endpoint, {id});
            expect(result).toMatchObject({code: item.code, msg: "tree not found"});
        }

        await expect(siyuanAPI.getWorkspaceInfo()).resolves.toMatchObject({
            workspaceDir: expect.any(String),
        });
    });
});
