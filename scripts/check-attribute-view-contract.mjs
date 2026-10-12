import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {EventEmitter} from "node:events";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = fileURLToPath(new URL("..", import.meta.url));
const compile = source => ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const contract = {};
new Function("exports", compile(readFileSync(new URL("../tests/helpers/attributeViewContract.ts", import.meta.url), "utf8")))(contract);
const {resolveAttributeView, storedAttributeViewIdentity, renderedAttributeViewIdentity,
    readAttributeViewSnapshot, matchesAttributeViewTransaction, matchesAttributeViewRender} = contract;

const fields = [{id: "primary", name: "Primary Key", type: "block"}, {id: "select", name: "Select", type: "select"}];
const stored = {id: "database", keyValues: fields.map(key => ({key})), views: [{id: "first", type: "table"}]};
const identity = {id: "database", viewID: "first", viewType: "table", fields};
const document = selector => ({ID: "doc", Type: "NodeDocument", Children: [{
    ID: "carrier", Type: "NodeAttributeView", AttributeViewID: "database", AttributeViewType: "table",
    Properties: {id: "carrier", ...(selector === undefined ? {} : {"custom-sy-av-view": selector})},
}]});
const flattenNodes = node => [node, ...(node.Children || []).flatMap(flattenNodes)];
let checks = 0;
const check = async (name, action) => {await action(); console.log(`PASS ${name}`); checks++;};

// Run the actual helper body with a bounded assertion driver. No kernel, browser,
// fixture setup/cleanup, or workspace writes are involved in these regressions.
const expectation = actual => ({
    toBe: expected => assert.equal(actual, expected),
    toEqual: expected => assert.deepEqual(actual, expected),
    toBeGreaterThan: expected => assert.ok(actual > expected),
    toPass: async () => {
        let error;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {await actual(); return;} catch (caught) {error = caught;}
        }
        throw error;
    },
});
expectation.poll = callback => ({
    toEqual: async expected => {
        await expectation(async () => assert.deepEqual(await callback(), expected)).toPass();
    },
    toBe: async expected => {
        await expectation(async () => assert.equal(await callback(), expected)).toPass();
    },
});
const loadPersistenceHelper = source => {
    const start = source.indexOf("const expectPersistedAttributeView =");
    const end = source.indexOf("\nconst expectRenderedAttributeView", start);
    assert.ok(start >= 0 && end > start, "Persistence helper must exist");
    return new Function("expect", "readValidDocument", "flattenNodes", "getCurrentViewID",
        "readAttributeViewSnapshot", "storedAttributeViewIdentity",
        compile(source.slice(start, end)) + "\nreturn expectPersistedAttributeView;")(
        expectation, api => api.readDocument(), flattenNodes,
        async api => flattenNodes(await api.readDocument()).find(node => node.ID === "carrier")?.Properties?.["custom-sy-av-view"],
        readAttributeViewSnapshot, storedAttributeViewIdentity,
    );
};
const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.slice("--baseline=".length);
const legacy = baseline !== undefined;
const source = legacy ? execFileSync("git", ["show", `${baseline}:tests/editor-attribute-view.spec.ts`], {cwd: root, encoding: "utf8"}) :
    readFileSync(new URL("../tests/editor-attribute-view.spec.ts", import.meta.url), "utf8");
const persist = loadPersistenceHelper(source);
const api = (doc = document(), av = stored) => ({readDocument: async () => doc, readWorkspaceFile: async () => av});

await check("initial missing selector preserves first render identity (also after reload)", async () => {
    await persist(api(), "doc", "carrier", "database", identity);
    await persist(api(), "doc", "carrier", "database", identity);
});
if (legacy) {
    throw new Error("The legacy helper unexpectedly accepted the regression fixture");
}
await check("empty and valid explicit initial selectors resolve to the same view", async () => {
    for (const selector of ["", "first"]) {
        await persist(api(document(selector)), "doc", "carrier", "database", identity);
    }
});
await check("nonempty unknown selector never falls back", async () => {
    await assert.rejects(persist(api(document("lost")), "doc", "carrier", "database", identity), /Invalid view selector/);
});
await check("a missing multi-view selector cannot masquerade as the default", () => {
    assert.throws(() => resolveAttributeView([...stored.views, {id: "second", type: "gallery"}], undefined), /Invalid view selector/);
});
await check("explicit non-first and switch-back-to-first selections persist exactly", () => {
    const views = [...stored.views, {id: "second", type: "gallery"}];
    for (const expected of ["first", "second"]) {
        for (const missing of [undefined, "", "lost"]) {
            assert.throws(() => resolveAttributeView(views, missing, expected), /Expected persisted view/);
        }
        assert.equal(resolveAttributeView(views, expected, expected).id, expected);
    }
    assert.throws(() => resolveAttributeView(views, "first", "second"), /Expected persisted view/);
});
await check("each persistence attempt rereads both .sy and AV after an intermediate save", async () => {
    let documents = 0;
    let definitions = 0;
    const delayed = {
        readDocument: async () => {documents++; return document("first");},
        readWorkspaceFile: async () => {
            definitions++;
            return definitions === 1 ? {...stored, views: [{id: "older", type: "table"}]} : stored;
        },
    };
    await persist(delayed, "doc", "carrier", "database", identity);
    assert.equal(documents, 2);
    assert.equal(definitions, 2);
});
await check("recreated view or field IDs cannot replace the first render expectation", async () => {
    const replacedView = {...stored, views: [{id: "recreated", type: "table"}]};
    await assert.rejects(persist(api(document(), replacedView), "doc", "carrier", "database", identity));
    const replacedField = {...stored, keyValues: [{key: {...fields[0], id: "recreated-primary"}}, stored.keyValues[1]]};
    await assert.rejects(persist(api(document(), replacedField), "doc", "carrier", "database", identity));
});
await check("render view identity and every column identity must agree with disk", () => {
    const render = {id: "database", viewID: "first", viewType: "table", views: stored.views,
        view: {id: "first", columns: fields}};
    assert.deepEqual(renderedAttributeViewIdentity(render), storedAttributeViewIdentity(stored, undefined));
    assert.throws(() => renderedAttributeViewIdentity({...render, view: {...render.view, id: "lost"}}), /Invalid table render identity/);
    assert.notDeepEqual(renderedAttributeViewIdentity({...render, view: {...render.view,
        columns: [{...fields[0], id: "lost"}, fields[1]]}}), identity);
});
await check("new block transaction matching excludes wrong block, AV, and action", () => {
    const target = {blockID: "carrier", avID: "database"};
    const operation = {action: "update", id: "carrier",
        data: '<div data-node-id="carrier" data-av-id="database" data-type="NodeAttributeView"></div>'};
    const payload = operation => ({transactions: [{doOperations: [operation]}]});
    assert.equal(matchesAttributeViewTransaction(payload(operation), target, "update"), true);
    for (const changed of [{id: "other"}, {action: "insert"}, {data: operation.data.replace("database", "other")}]) {
        assert.equal(matchesAttributeViewTransaction(payload({...operation, ...changed}), target, "update"), false);
    }
    const selection = {action: "setAttrViewBlockView", ...target, id: "second"};
    assert.equal(matchesAttributeViewTransaction(payload(selection), target, "setAttrViewBlockView", "second"), true);
    for (const changed of [{id: "first"}, {blockID: "other"}, {avID: "other"}, {action: "update"}]) {
        assert.equal(matchesAttributeViewTransaction(payload({...selection, ...changed}), target, "setAttrViewBlockView", "second"), false);
    }
    assert.equal(matchesAttributeViewRender({id: "database", blockID: "carrier"}, target), true);
    assert.equal(matchesAttributeViewRender({id: "database", blockID: "other"}, target), false);
    assert.equal(matchesAttributeViewRender({id: "other", blockID: "carrier"}, target), false);
});
const responseHelpers = {};
new Function("exports", "require", compile(readFileSync(
    new URL("../tests/helpers/attributeViewResponses.ts", import.meta.url), "utf8")))(responseHelpers, name => {
    if (name === "@playwright/test") return {expect: expectation};
    if (name === "./attributeViewContract") return contract;
    throw new Error(`Unexpected response helper import: ${name}`);
});
const {observeAttributeViewResponses, getAttributeViewResponseDiagnostics} = responseHelpers;
const exchange = (path, payload, result = {code: 0, data: {viewID: "first"}}, status = 200) => {
    const request = {url: () => `http://example.test${path}`, postDataJSON: () => payload};
    const response = {request: () => request, url: request.url, status: () => status,
        ok: () => status >= 200 && status < 300,
        text: async () => typeof result === "string" ? result : JSON.stringify(result)};
    return {request, response};
};
const emit = (page, item) => {page.emit("request", item.request); page.emit("response", item.response);};
const target = {blockID: "carrier", avID: "database"};
const renderRequest = {id: "database", blockID: "carrier"};
await check("switch synchronization excludes old in-flight and pre-transaction renders", async () => {
    const page = new EventEmitter();
    const old = exchange("/api/av/renderAttributeView", renderRequest);
    page.emit("request", old.request);
    const observer = observeAttributeViewResponses(page);
    page.emit("response", old.response);
    emit(page, exchange("/api/av/renderAttributeView", renderRequest));
    emit(page, exchange("/api/transactions", {transactions: [{doOperations: [
        {action: "setAttrViewBlockView", ...target, id: "second"},
    ]}]}));
    emit(page, exchange("/api/av/renderAttributeView", renderRequest, {code: 0, data: {viewID: "second"}}));
    await observer.transaction(target, "setAttrViewBlockView", "second");
    assert.equal((await observer.render(target, "second")).viewID, "second");
    await observer.stop();
    assert.equal(getAttributeViewResponseDiagnostics(page).filter(item => item.kind === "render").length, 2);
    assert.equal(page.listenerCount("request"), 0);
    assert.equal(page.listenerCount("response"), 0);
});
await check("HTTP and business failures fail, while non-JSON target evidence is retained", async () => {
    for (const [body, status] of [[{code: -1, msg: "failure"}, 200], [{code: 0}, 500], ["<invalid-json>", 502]]) {
        const page = new EventEmitter();
        const observer = observeAttributeViewResponses(page);
        emit(page, exchange("/api/av/renderAttributeView", renderRequest, body, status));
        await assert.rejects(observer.render(target));
        await observer.stop();
        const [diagnostic] = getAttributeViewResponseDiagnostics(page);
        assert.equal(diagnostic.status, status);
        assert.equal(diagnostic.response, typeof body === "string" ? body : JSON.stringify(body));
    }
});
await check("all observed target render identities are retained without unrelated bodies", async () => {
    const page = new EventEmitter();
    const observer = observeAttributeViewResponses(page);
    emit(page, exchange("/api/av/renderAttributeView", {id: "private", blockID: "unrelated"}, "do not collect"));
    for (const viewID of ["first", "recreated"]) {
        emit(page, exchange("/api/av/renderAttributeView", renderRequest, {code: 0, data: {viewID}}));
    }
    assert.equal((await observer.render(target)).viewID, "first");
    await observer.stop();
    const diagnostics = getAttributeViewResponseDiagnostics(page);
    assert.deepEqual(diagnostics.map(item => JSON.parse(item.response).data.viewID), ["first", "recreated"]);
    assert.ok(!JSON.stringify(diagnostics).includes("do not collect"));
});
await check("malformed request payloads are ignored and diagnostic stop preserves the primary error", async () => {
    for (const payload of [null, undefined, "invalid", 42, {transactions: 1},
        {transactions: [null, {doOperations: "invalid"}, {doOperations: [null]}]}]) {
        assert.equal(matchesAttributeViewTransaction(payload, target, "update"), false);
        assert.equal(matchesAttributeViewRender(payload, target), false);
    }
    const page = new EventEmitter();
    const observer = observeAttributeViewResponses(page);
    emit(page, exchange("/api/av/renderAttributeView", renderRequest));
    const unreadable = exchange("/api/av/renderAttributeView", renderRequest);
    emit(page, unreadable);
    const malformed = exchange("/api/av/renderAttributeView", renderRequest);
    emit(page, malformed);
    await observer.render(target);
    unreadable.request.postDataJSON = () => {throw new Error("malformed payload");};
    malformed.response.url = () => {throw new Error("disposed response");};
    const primary = new Error("original assertion failure");
    await assert.rejects((async () => {
        try {throw primary;} finally {await observer.stop();}
    })(), error => error === primary);
    assert.ok(getAttributeViewResponseDiagnostics(page).some(item => item.error?.includes("disposed response")));
});
await check("failure artifact collection uses only fixture documents and tolerates missing files", async () => {
    const requested = [];
    const attachments = [];
    const request = {post: async (url, options) => {
        requested.push({url, data: options.data});
        assert.ok(options.timeout > 0 && options.timeout <= 1500);
        throw new Error("workspace unavailable");
    }};
    await responseHelpers.attachAttributeViewFailure(new EventEmitter(), request, "http://example.test", [
        {id: "isolated-doc", notebookID: "test-notebook"},
    ], {attach: async (name, data) => attachments.push({name, data})});
    assert.deepEqual(requested, [{url: "http://example.test/api/block/getBlockInfo", data: {id: "isolated-doc"}}]);
    assert.equal(attachments.length, 1);
    assert.match(attachments[0].data.body.toString(), /workspace unavailable/);
});
await check("response targets retain only IDs when the insertion result contains a Locator", async () => {
    const page = new EventEmitter();
    const observer = observeAttributeViewResponses(page);
    const locator = {};
    locator.frame = locator;
    emit(page, exchange("/api/av/renderAttributeView", renderRequest));
    await observer.render({...target, block: locator});
    await observer.stop();
    assert.deepEqual(getAttributeViewResponseDiagnostics(page)[0].target, target);
    assert.doesNotThrow(() => JSON.stringify(getAttributeViewResponseDiagnostics(page)));
});
console.log(`Attribute view contract: ${checks} checks passed`);
