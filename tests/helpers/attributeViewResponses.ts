import {APIRequestContext, expect, Page, Request, Response, TestInfo} from "@playwright/test";
import {ICreatedTestDocument} from "./testNotebook";
import {
    IAttributeViewRender,
    IAttributeViewTarget,
    matchesAttributeViewRender,
    matchesAttributeViewTransaction,
} from "./attributeViewContract";

const diagnostics = new WeakMap<Page, unknown[]>();

export const getAttributeViewResponseDiagnostics = (page: Page) => diagnostics.get(page) || [];

export const attachAttributeViewFailure = async (
    page: Page, request: APIRequestContext, baseURL: string, documents: ICreatedTestDocument[], testInfo: TestInfo,
) => {
    const artifacts: Array<{name: string; body: Buffer; contentType: string}> = [];
    const errors: string[] = [];
    const deadline = Date.now() + 6000;
    const post = async (path: string, data: object) => {
        if (Date.now() >= deadline) {
            throw new Error("Attribute view diagnostic time budget exhausted");
        }
        const response = await request.post(new URL(path, baseURL).toString(), {
            data, timeout: Math.min(1500, deadline - Date.now()),
        });
        if (!response.ok()) {
            throw new Error(`${path}: HTTP ${response.status()}`);
        }
        return response;
    };
    for (const document of documents) {
        try {
            const location = await (await post("/api/block/getBlockInfo", {id: document.id})).json();
            if (location.code !== 0 || location.data?.box !== document.notebookID) {
                throw new Error(`Cannot locate isolated document ${document.id}: code=${location.code}`);
            }
            const raw = await (await post("/api/file/getFile", {
                path: `/data/${document.notebookID}${location.data.path}`,
            })).text();
            artifacts.push({name: `${document.id}.sy`, body: Buffer.from(raw), contentType: "application/json"});
            interface INode {AttributeViewID?: string; Children?: INode[]; ID?: string; Type?: string}
            const nodes = (node: INode): INode[] => [node, ...(node.Children || []).flatMap(nodes)];
            for (const node of nodes(JSON.parse(raw)).filter(node => node.Type === "NodeAttributeView")) {
                const avID = node.AttributeViewID;
                if (!avID || !/^\d{14}-[a-z0-9]{7}$/.test(avID)) {
                    errors.push(`Invalid AV ID in ${document.id}: ${JSON.stringify(avID)}`);
                    continue;
                }
                try {
                    const av = await (await post("/api/file/getFile", {path: `/data/storage/av/${avID}.json`})).text();
                    artifacts.push({name: `${avID}.av.json`, body: Buffer.from(av), contentType: "application/json"});
                    if (!page.isClosed() && node.ID && Date.now() < deadline) {
                        const dom = await page.locator(`[data-type="NodeAttributeView"][data-node-id="${node.ID}"]`)
                            .evaluateAll(elements => elements.map(element => ({
                                blockID: element.getAttribute("data-node-id"),
                                avID: element.getAttribute("data-av-id"),
                                selector: element.getAttribute("custom-sy-av-view"),
                                fields: Array.from(element.querySelectorAll(".av__cell--header"))
                                    .map(field => field.getAttribute("data-col-id")),
                            })));
                        artifacts.push({name: `${node.ID}.dom.json`, body: Buffer.from(JSON.stringify(dom, null, 2)),
                            contentType: "application/json"});
                    }
                } catch (error) {
                    errors.push(`${avID}: ${String(error)}`);
                }
            }
        } catch (error) {
            errors.push(`${document.id}: ${String(error)}`);
        }
    }
    artifacts.push({name: "attribute-view-responses.json", contentType: "application/json",
        body: Buffer.from(JSON.stringify({responses: getAttributeViewResponseDiagnostics(page), errors}, null, 2))});
    for (const {name, ...attachment} of artifacts) {
        try {
            await testInfo.attach(name, attachment);
        } catch (error) {
            // Diagnostics must not replace the original test failure.
            console.warn(`Unable to attach ${name}: ${String(error)}`);
        }
    }
};

// Start before the UI action: a new block's generated IDs are not available until
// after the click, but its responses may already have arrived by then.
export const observeAttributeViewResponses = (page: Page) => {
    const requests: Request[] = [];
    const responses: Response[] = [];
    const targets = new Map<string, IAttributeViewTarget>();
    const recorded = new Map<Response, Promise<{code: number; msg?: string; data: IAttributeViewRender}>>();
    const requestListener = (request: Request) => {
        if (["/api/transactions", "/api/av/renderAttributeView"].includes(new URL(request.url()).pathname)) {
            requests.push(request);
        }
    };
    const responseListener = (response: Response) => {
        // Do not attribute a pre-click request's late response to this action.
        if (requests.includes(response.request())) {
            responses.push(response);
        }
    };
    page.on("request", requestListener);
    page.on("response", responseListener);
    const readPayload = (request: Request) => {
        try {
            return request.postDataJSON();
        } catch {
            return undefined;
        }
    };
    const record = (response: Response, target: IAttributeViewTarget,
                    kind: "render" | "update" | "setAttrViewBlockView", viewID?: string) => {
        if (!recorded.has(response)) {
            recorded.set(response, (async () => {
                const entry = {target, kind, viewID, status: response.status(),
                    request: kind === "render" ? readPayload(response.request()) : {action: kind, ...target, viewID},
                    response: undefined as unknown, error: undefined as string | undefined};
                const entries = diagnostics.get(page) || [];
                entries.push(entry);
                diagnostics.set(page, entries);
                try {
                    const raw = await response.text();
                    // Keep raw target render evidence even for non-JSON failures.
                    // Never record headers or unrelated batched transaction bodies.
                    if (kind === "render") {
                        entry.response = raw;
                    }
                    const result = JSON.parse(raw) as {code: number; msg?: string; data: IAttributeViewRender};
                    if (kind !== "render") {
                        entry.response = {code: result.code, msg: result.msg};
                    }
                    return result;
                } catch (error) {
                    entry.error = String(error);
                    throw error;
                }
            })());
        }
        return recorded.get(response)!;
    };
    const read = async (input: IAttributeViewTarget, kind: "render" | "update" | "setAttrViewBlockView",
                        viewID?: string) => {
        // Callers may pass the insertion result, which also contains a Locator.
        // Persist only the two verified IDs, never arbitrary/circular objects.
        const target = {avID: input.avID, blockID: input.blockID};
        targets.set(`${target.blockID}/${target.avID}`, target);
        let matched: Response | undefined;
        await expect.poll(() => {
            matched = responses.find(response => {
                const path = new URL(response.url()).pathname;
                const payload = readPayload(response.request());
                if (!payload) {
                    return false;
                }
                if (kind !== "render") {
                    return path === "/api/transactions" && matchesAttributeViewTransaction(payload, target, kind, viewID);
                }
                if (path !== "/api/av/renderAttributeView" || !matchesAttributeViewRender(payload, target)) {
                    return false;
                }
                // A switch render must have started after the exact target's
                // selection transaction. Initial creation can render before save.
                return viewID === undefined || requests.slice(0, requests.indexOf(response.request())).some(request =>
                    new URL(request.url()).pathname === "/api/transactions" &&
                    matchesAttributeViewTransaction(readPayload(request), target, "setAttrViewBlockView", viewID));
            });
            return Boolean(matched);
        }, {timeout: 30000, message: `Wait for ${kind} of ${JSON.stringify({...target, viewID})}`}).toBe(true);
        const response = matched!;
        const result = await record(response, target, kind, viewID);
        expect(response.ok(), `${kind} HTTP status for ${JSON.stringify(target)}`).toBe(true);
        expect(result.code, `${kind} business result for ${JSON.stringify(target)}: ${result.msg}`).toBe(0);
        return result.data;
    };
    return {
        render: (target: IAttributeViewTarget, afterSelectedViewID?: string) => read(target, "render", afterSelectedViewID),
        transaction: (target: IAttributeViewTarget, action: "update" | "setAttrViewBlockView", viewID?: string) =>
            read(target, action, viewID),
        stop: async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                page.off("request", requestListener);
                page.off("response", responseListener);
                // Preserve all observed target renders, not just the first awaited
                // response. Bounded diagnostic collection never replaces a failure.
                const pending: Promise<unknown>[] = [];
                for (const target of targets.values()) {
                    let count = 0;
                    for (const response of responses) {
                        try {
                            if (count < 20 && new URL(response.url()).pathname === "/api/av/renderAttributeView" &&
                                matchesAttributeViewRender(readPayload(response.request()), target)) {
                                count++;
                                pending.push(record(response, target, "render").catch(() => undefined));
                            }
                        } catch (error) {
                            const entries = diagnostics.get(page) || [];
                            entries.push({target, error: `Unable to collect response: ${String(error)}`});
                            diagnostics.set(page, entries);
                        }
                    }
                }
                await Promise.race([Promise.all(pending), new Promise(resolve => {timer = setTimeout(resolve, 1500);})]);
            } catch (error) {
                console.warn(`Unable to collect attribute view responses: ${String(error)}`);
            } finally {
                clearTimeout(timer);
            }
        },
    };
};
