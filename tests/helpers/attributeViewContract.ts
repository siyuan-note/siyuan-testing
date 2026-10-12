// Keep this contract independent of Playwright so the synchronization and identity
// checks can be regression-tested without a browser or a running workspace.
export interface IStoredAttributeView {
    id: string;
    keyValues: Array<{key: {id: string; name: string; type: string}}>;
    views: Array<{id: string; type: string}>;
}

export interface IAttributeViewIdentity {
    id: string;
    viewID: string;
    viewType: string;
    fields: Array<{id: string; name: string; type: string}>;
}

export interface IAttributeViewRender {
    id: string;
    viewID: string;
    viewType: string;
    view: {id: string; columns?: Array<{id: string; name: string; type: string}>};
    views: Array<{id: string; type: string}>;
}

export const resolveAttributeView = <T extends {id: string; type: string}>(
    views: T[], selector: string | undefined, expectedViewID?: string,
): T => {
    // A selected view must persist exactly, even when it is the first view.
    if (expectedViewID !== undefined && selector !== expectedViewID) {
        throw new Error(`Expected persisted view ${expectedViewID}, got ${JSON.stringify(selector)}`);
    }
    // Only the unselected, single-view initial state may omit the selector.
    // Never turn an unknown nonempty ID or a lost multi-view selection into a pass.
    const view = selector ? views.find(item => item.id === selector) :
        expectedViewID === undefined && views.length === 1 ? views[0] : undefined;
    if (!view?.id) {
        throw new Error(`Invalid view selector ${JSON.stringify(selector)}; views=${JSON.stringify(views.map(
            ({id, type}) => ({id, type})))}`);
    }
    return view;
};

export const storedAttributeViewIdentity = (
    stored: IStoredAttributeView, selector: string | undefined, expectedViewID?: string,
): IAttributeViewIdentity => {
    const view = resolveAttributeView(stored.views, selector, expectedViewID);
    return {
        id: stored.id,
        viewID: view.id,
        viewType: view.type,
        fields: stored.keyValues.map(({key: {id, name, type}}) => ({id, name, type})),
    };
};

export const renderedAttributeViewIdentity = (rendered: IAttributeViewRender): IAttributeViewIdentity => {
    if (rendered.view?.id !== rendered.viewID || !rendered.view.columns) {
        throw new Error(`Invalid table render identity: ${JSON.stringify(rendered)}`);
    }
    return {
        id: rendered.id,
        viewID: rendered.viewID,
        viewType: rendered.viewType,
        fields: rendered.view.columns.map(({id, name, type}) => ({id, name, type})),
    };
};

// Both inputs must be refreshed on every poll; retaining the first AV definition
// while only rereading .sy compares unrelated save generations.
export const readAttributeViewSnapshot = async <D, A>(
    readDocument: () => Promise<D>, readAttributeView: () => Promise<A>,
) => {
    const [document, stored] = await Promise.all([readDocument(), readAttributeView()]);
    return {document, stored};
};

export interface IAttributeViewTarget {
    avID: string;
    blockID: string;
}

const asObject = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

export const matchesAttributeViewTransaction = (
    payload: unknown, target: IAttributeViewTarget, action: "update" | "setAttrViewBlockView", viewID?: string,
) => {
    const transactions = asObject(payload).transactions;
    return Array.isArray(transactions) && transactions.some(transaction => {
        const operations = asObject(transaction).doOperations;
        return Array.isArray(operations) && operations.some(value => {
            const operation = asObject(value);
            if (operation.action !== action) {
                return false;
            }
            if (action === "setAttrViewBlockView") {
                return operation.blockID === target.blockID && operation.avID === target.avID && operation.id === viewID;
            }
            return operation.id === target.blockID && typeof operation.data === "string" &&
                operation.data.includes(`data-node-id="${target.blockID}"`) &&
                operation.data.includes(`data-av-id="${target.avID}"`) &&
                operation.data.includes('data-type="NodeAttributeView"');
        });
    });
};

export const matchesAttributeViewRender = (payload: unknown, target: IAttributeViewTarget) => {
    const request = asObject(payload);
    return request.id === target.avID && request.blockID === target.blockID;
};
