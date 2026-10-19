import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compile = source => ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const settings = {};
new Function("require", "exports", compile(readFileSync(
    new URL("../tests/helpers/pdfSettings.ts", import.meta.url), "utf8")))(require, settings);

const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.slice("--baseline=".length);
const source = baseline === undefined ? readFileSync(new URL("../tests/pdf-annotations.spec.ts", import.meta.url), "utf8") :
    execFileSync("git", ["show", `${baseline}:tests/pdf-annotations.spec.ts`], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
    });
const originalTheme = {light: "light", dark: "dark", annoColor: "var(--b3-pdf-background2)"};
const clone = value => structuredClone(value);
let checks = 0;
const check = async (name, run) => {
    await run();
    checks++;
    console.log(`PASS ${name}`);
};

// Execute the actual Playwright fixture with a deterministic API/page double.
// This checks teardown and assertion precedence without a kernel or browser.
const fixture = ({storage = {}, appearance = {pdfTheme: clone(originalTheme), mode: 0}} = {}) => {
    const state = {storage: clone(storage), appearance: clone(appearance), calls: [], removedFiles: [],
        fail: () => undefined, ignoreWrite: () => false};
    const api = {
        post: async (path, body) => {
            // Match HTTP JSON serialization, including dropping undefined vals.
            const data = JSON.parse(JSON.stringify(body));
            state.calls.push({path, data});
            const failure = state.fail(path);
            if (failure) throw failure;
            if (path === "/api/storage/getLocalStorage") return clone(state.storage);
            if (path === "/api/system/getConf") return {conf: {appearance: clone(state.appearance)}};
            if (path === "/api/search/getAssetContentByPath") return {assetContent: "Indexed PDF"};
            if (state.ignoreWrite(path)) return;
            if (path === "/api/setting/setAppearance") {
                Object.assign(state.appearance, clone(data));
                return clone(state.appearance);
            }
            if (path === "/api/storage/setLocalStorageVal") {
                assert.ok(data.val !== undefined && data.val !== null, "local storage value must not be empty");
                state.storage[data.key] = clone(data.val);
                return;
            }
            if (path === "/api/storage/removeLocalStorageVal") {
                delete state.storage[data.key];
                return;
            }
            throw new Error(`Unexpected API request: ${path}`);
        },
        uploadAsset: async (_, filename) => ({errFiles: [], succMap: {[filename]: "assets/fixture.pdf"}}),
        updateBlock: async () => {},
        flushTransactions: async () => {},
        removeWorkspaceFile: async path => {state.removedFiles.push(path);},
    };
    const locator = {locator: () => locator, first: () => locator, last: () => locator, filter: () => locator,
        getAttribute: async () => "fixture-node", count: async () => 0};
    const page = {on: () => {}, locator: () => locator, reload: async () => {},
        // Modern frontend storage omits the deprecated PDF preference key.
        evaluate: async () => undefined};
    const expect = value => ({toEqual: expected => assert.deepEqual(value, expected),
        toMatch: expected => assert.match(value, expected)});
    expect.poll = callback => ({toBeTruthy: async () => assert.ok(await callback())});
    let definition;
    const base = {extend: fixtures => {definition = fixtures.pdf; return () => {};}};
    const imports = path => {
        if (path === "./fixtures") return {test: base, expect};
        if (path === "./helpers/pdfFixture") return {createPdfFixture: () => Buffer.from("PDF double")};
        if (path === "./helpers/pdfSettings") return settings;
        if (path === "./helpers/testNotebook") return {getDocumentEditor: async () => locator};
        throw new Error(`Unexpected import: ${path}`);
    };
    new Function("require", "exports", compile(source))(imports, {});
    const testInfo = {status: "passed", annotations: []};
    const run = async (use = async () => {}) => definition({
        page, context: {grantPermissions: async () => {}}, baseURL: "http://127.0.0.1:6806",
        createTestDocument: async () => ({docID: "fixture-doc", editor: locator}), siyuanAPI: api,
    }, use, testInfo);
    return {state, api, testInfo, run};
};

await check("absent legacy key is removed and migrated PDF preferences are restored", async () => {
    const f = fixture({storage: {unrelated: {keep: true}}});
    await f.run(async () => {
        f.state.storage["local-pdftheme"] = {annoColor: "red"};
        f.state.appearance.pdfTheme = {light: "dark", dark: "light", annoColor: "red"};
        f.state.appearance.mode = 1;
    });
    assert.deepEqual(f.state.storage, {unrelated: {keep: true}});
    assert.deepEqual(f.state.appearance, {pdfTheme: originalTheme, mode: 1});
    assert.ok(f.state.calls.some(call => call.path === "/api/storage/removeLocalStorageVal"));
    assert.ok(!f.state.calls.some(call => call.path === "/api/storage/setLocalStorageVal"));
    assert.equal(f.state.removedFiles.length, 2);
});
if (baseline !== undefined) throw new Error("The baseline unexpectedly passed the PDF fixture regression");

await check("persisted legacy values are preserved even when absent from frontend storage", async () => {
    for (const value of [{light: "dark", nested: {color: "green"}}, false, 0, ""]) {
        const f = fixture({storage: {"local-pdftheme": value}});
        await f.run(async () => {delete f.state.storage["local-pdftheme"];});
        assert.deepEqual(f.state.storage["local-pdftheme"], value);
        assert.ok(f.state.calls.some(call => call.path === "/api/storage/setLocalStorageVal"));
        assert.ok(!f.state.calls.some(call => call.path === "/api/storage/removeLocalStorageVal"));
    }
});

await check("pre-migration instances do not receive an invented appearance.pdfTheme", async () => {
    const f = fixture({storage: {"local-pdftheme": {annoColor: "blue"}}, appearance: {mode: 0}});
    await f.run(async () => {f.state.storage["local-pdftheme"] = {annoColor: "red"};});
    assert.deepEqual(f.state.storage["local-pdftheme"], {annoColor: "blue"});
    assert.deepEqual(f.state.appearance, {mode: 0});
    assert.ok(!f.state.calls.some(call => call.path === "/api/setting/setAppearance"));
});

await check("a recorded assertion failure stays primary and cleanup errors remain visible", async () => {
    const f = fixture();
    await f.run(async () => {
        f.testInfo.status = "failed";
        f.state.fail = path => path === "/api/setting/setAppearance" ? new Error("appearance restore failed") : undefined;
    });
    assert.equal(f.testInfo.status, "failed");
    assert.equal(f.testInfo.annotations.length, 1);
    assert.match(f.testInfo.annotations[0].description, /appearance restore failed/);
    assert.ok(f.state.calls.some(call => call.path === "/api/storage/removeLocalStorageVal"));
    assert.deepEqual(f.state.removedFiles, []);
});

await check("a thrown primary error is preserved when both restoration requests fail", async () => {
    const f = fixture();
    const primary = new Error("primary assertion or asset cleanup error");
    await assert.rejects(f.run(async () => {
        f.state.fail = path => /setAppearance|removeLocalStorageVal/.test(path) ? new Error(`restore failed: ${path}`) : undefined;
        throw primary;
    }), error => error === primary);
    assert.equal(f.testInfo.annotations.length, 1);
    assert.match(f.testInfo.annotations[0].description, /setAppearance.*removeLocalStorageVal/);
    assert.deepEqual(f.state.removedFiles, []);
});

await check("asset cleanup failures are not replaced by settings cleanup failures", async () => {
    const f = fixture();
    const primary = new Error("asset removal failed");
    f.api.removeWorkspaceFile = async () => {throw primary;};
    await assert.rejects(f.run(async () => {
        f.state.fail = path => path === "/api/setting/setAppearance" ? new Error("settings cleanup failed") : undefined;
    }), error => error === primary);
    assert.equal(f.testInfo.annotations.length, 1);
    assert.match(f.testInfo.annotations[0].description, /settings cleanup failed/);
});

await check("restoration failure fails a passing test and still attempts both settings", async () => {
    const f = fixture();
    await assert.rejects(f.run(async () => {
        f.state.fail = path => path === "/api/setting/setAppearance" ? new Error("appearance offline") : undefined;
    }), /appearance offline/);
    assert.ok(f.state.calls.some(call => call.path === "/api/storage/removeLocalStorageVal"));
    assert.deepEqual(f.testInfo.annotations, []);
});

await check("legacy restoration failure does not prevent actual PDF preferences restoring", async () => {
    const f = fixture({storage: {"local-pdftheme": {annoColor: "blue"}}});
    await assert.rejects(f.run(async () => {
        f.state.appearance.pdfTheme.annoColor = "red";
        f.state.fail = path => path === "/api/storage/setLocalStorageVal" ? new Error("legacy offline") : undefined;
    }), /legacy offline/);
    assert.deepEqual(f.state.appearance.pdfTheme, originalTheme);
});

await check("success responses must be backed by restored persisted state", async () => {
    const f = fixture();
    await assert.rejects(f.run(async () => {
        f.state.appearance.pdfTheme.annoColor = "red";
        f.state.ignoreWrite = path => path === "/api/setting/setAppearance";
    }), /PDF settings were not restored/);
});

await check("snapshot owns its nested preference values", async () => {
    const f = fixture({storage: {"local-pdftheme": {nested: {color: "green"}}}});
    const snapshot = await settings.readPdfSettings(f.api);
    f.state.storage["local-pdftheme"].nested.color = "red";
    f.state.appearance.pdfTheme.annoColor = "red";
    await settings.restorePdfSettings(f.api, snapshot);
    assert.equal(f.state.storage["local-pdftheme"].nested.color, "green");
    assert.deepEqual(f.state.appearance.pdfTheme, originalTheme);
});

await check("timed-out, interrupted and skipped tests preserve status and diagnostic data", async () => {
    for (const status of ["timedOut", "interrupted", "skipped"]) {
        const f = fixture();
        await f.run(async () => {
            f.testInfo.status = status;
            f.state.fail = path => path === "/api/setting/setAppearance" ? new Error("cleanup unavailable") : undefined;
        });
        assert.equal(f.testInfo.status, status);
        assert.equal(f.testInfo.annotations.length, 1);
        assert.deepEqual(f.state.removedFiles, []);
    }
});

await check("a failed readback is a cleanup failure for an otherwise passing test", async () => {
    const f = fixture();
    await assert.rejects(f.run(async () => {
        f.state.fail = path => path === "/api/system/getConf" ? new Error("readback unavailable") : undefined;
    }), /readback unavailable/);
});

console.log(`${checks} PDF fixture cleanup checks passed (no kernel or browser launched).`);
