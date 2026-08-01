import {expect, Locator} from "@playwright/test";
import {SiyuanAPI} from "./siyuanAPI";

interface ISyNode {
    Type: string;
    ID?: string;
    Properties?: Record<string, string>;
    Children?: ISyNode[];
    ListData?: {
        Typ?: number;
        BulletChar?: number;
        Delimiter?: number;
        Marker?: string;
        Checked?: boolean;
    };
    TaskListItemChecked?: boolean;
}

interface IDOMListNode {
    id: string;
    childIDs: string[];
}

export const assertValidListDOM = async (editor: Locator) => {
    const errors = await editor.evaluate((element) => {
        const result: string[] = [];
        const ids = new Set<string>();
        element.querySelectorAll<HTMLElement>("[data-node-id]").forEach(item => {
            const id = item.dataset.nodeId;
            if (!id) {
                result.push(`${item.getAttribute("data-type")} is missing a block ID`);
                return;
            }
            if (ids.has(id)) {
                result.push(`duplicate block ID ${id}`);
            }
            ids.add(id);
        });
        element.querySelectorAll<HTMLElement>('[data-type="NodeList"]').forEach(list => {
            if (list.querySelectorAll(":scope > .protyle-attr").length !== 1) {
                result.push(`NodeList ${list.dataset.nodeId} does not have exactly one attribute element`);
            }
            Array.from(list.children).filter(child => child.hasAttribute("data-node-id")).forEach(child => {
                if (child.getAttribute("data-type") !== "NodeListItem") {
                    result.push(`NodeList ${list.dataset.nodeId} directly contains ${child.getAttribute("data-type")}`);
                }
                if (child.getAttribute("data-subtype") !== list.getAttribute("data-subtype")) {
                    result.push(`list subtype mismatch at ${child.getAttribute("data-node-id")}`);
                }
            });
        });
        element.querySelectorAll<HTMLElement>('[data-type="NodeListItem"]').forEach(item => {
            if (item.parentElement?.getAttribute("data-type") !== "NodeList") {
                result.push(`NodeListItem ${item.dataset.nodeId} is not wrapped by NodeList`);
            }
            if (item.querySelectorAll(":scope > .protyle-action").length !== 1) {
                result.push(`NodeListItem ${item.dataset.nodeId} does not have exactly one action element`);
            }
            if (item.querySelectorAll(":scope > .protyle-attr").length !== 1) {
                result.push(`NodeListItem ${item.dataset.nodeId} does not have exactly one attribute element`);
            }
            Array.from(item.children).filter(child => child.hasAttribute("data-node-id")).forEach(child => {
                if (child.getAttribute("data-type") === "NodeListItem") {
                    result.push(`NodeListItem ${item.dataset.nodeId} directly contains NodeListItem`);
                }
                if (child.getAttribute("data-type") !== "NodeThematicBreak" &&
                    child.querySelectorAll(":scope > .protyle-attr").length !== 1) {
                    result.push(`${child.getAttribute("data-type")} ${child.getAttribute("data-node-id")} ` +
                        "does not have exactly one attribute element");
                }
            });
        });
        Array.from(element.children).filter(child => child.hasAttribute("data-node-id")).forEach(child => {
            if (child.getAttribute("data-type") === "NodeListItem") {
                result.push(`document directly contains NodeListItem ${child.getAttribute("data-node-id")}`);
            }
        });
        return result;
    });
    expect(errors).toEqual([]);
};

const validateSyListTree = (root: ISyNode) => {
    const errors: string[] = [];
    const ids = new Set<string>();
    const visit = (node: ISyNode, parent?: ISyNode) => {
        if (node.ID) {
            if (ids.has(node.ID)) {
                errors.push(`duplicate block ID ${node.ID}`);
            }
            ids.add(node.ID);
            if (node.Properties?.id !== node.ID) {
                errors.push(`${node.Type} ${node.ID} does not match Properties.id`);
            }
        }
        const children = node.Children || [];
        if (node.Type === "NodeDocument" && children.some(child => child.Type === "NodeListItem")) {
            errors.push("NodeDocument directly contains NodeListItem");
        }
        if (node.Type === "NodeList") {
            const type = node.ListData?.Typ || 0;
            if (![0, 1, 3].includes(type)) {
                errors.push(`NodeList ${node.ID} has invalid ListData.Typ ${type}`);
            }
            children.forEach(child => {
                if (child.Type !== "NodeListItem") {
                    errors.push(`NodeList ${node.ID} directly contains ${child.Type}`);
                }
            });
        }
        if (node.Type === "NodeListItem") {
            if (parent?.Type !== "NodeList") {
                errors.push(`NodeListItem ${node.ID} is not wrapped by NodeList`);
            }
            if (children.some(child => child.Type === "NodeListItem")) {
                errors.push(`NodeListItem ${node.ID} directly contains NodeListItem`);
            }
            const type = node.ListData?.Typ || parent?.ListData?.Typ || 0;
            if (![0, 1, 3].includes(type)) {
                errors.push(`NodeListItem ${node.ID} has invalid ListData.Typ ${type}`);
            }
            if (node.ListData?.Typ !== undefined && node.ListData.Typ !== (parent?.ListData?.Typ || 0)) {
                errors.push(`NodeListItem ${node.ID} does not match its parent list type`);
            }
            if (type === 3) {
                const marker = children[0];
                if (marker?.Type !== "NodeTaskListItemMarker" || marker.ID) {
                    errors.push(`task list item ${node.ID} has an invalid marker`);
                } else if (node.ListData?.Checked !== undefined &&
                    !!marker.TaskListItemChecked !== node.ListData.Checked) {
                    errors.push(`task list item ${node.ID} has inconsistent checked state`);
                }
            }
        }
        if (node.ListData?.BulletChar !== undefined && !Number.isInteger(node.ListData.BulletChar)) {
            errors.push(`${node.Type} ${node.ID} has a non-integer BulletChar`);
        }
        if (node.ListData?.Delimiter !== undefined && !Number.isInteger(node.ListData.Delimiter)) {
            errors.push(`${node.Type} ${node.ID} has a non-integer Delimiter`);
        }
        if (node.ListData?.Marker !== undefined) {
            const normalized = node.ListData.Marker.replace(/=+$/, "");
            const decoded = Buffer.from(node.ListData.Marker, "base64").toString("base64").replace(/=+$/, "");
            if (decoded !== normalized) {
                errors.push(`${node.Type} ${node.ID} has an invalid base64 marker`);
            }
        }
        children.forEach(child => visit(child, node));
    };
    visit(root);
    return errors;
};

export const assertValidSyListTree = async (api: SiyuanAPI, docID: string, editor?: Locator) => {
    const expectedNodes = editor ? await editor.evaluate((element, rootID) => {
        const nodes: IDOMListNode[] = [{
            id: rootID,
            childIDs: Array.from(element.children)
                .filter(child => child.hasAttribute("data-node-id"))
                .map(child => child.getAttribute("data-node-id") as string),
        }];
        element.querySelectorAll<HTMLElement>('[data-type="NodeList"], [data-type="NodeListItem"]').forEach(node => {
            nodes.push({
                id: node.dataset.nodeId as string,
                childIDs: Array.from(node.children)
                    .filter(child => child.hasAttribute("data-node-id"))
                    .map(child => child.getAttribute("data-node-id") as string),
            });
        });
        return nodes;
    }, docID) : [];

    await expect.poll(async () => {
        const root = await api.readDocument<ISyNode>(docID);
        const errors = validateSyListTree(root);
        const syNodes = new Map<string, ISyNode>();
        const collect = (node: ISyNode) => {
            if (node.ID) {
                syNodes.set(node.ID, node);
            }
            (node.Children || []).forEach(collect);
        };
        collect(root);
        expectedNodes.forEach(expected => {
            const actual = syNodes.get(expected.id);
            if (!actual) {
                errors.push(`persisted tree is missing ${expected.id}`);
                return;
            }
            const actualChildIDs = (actual.Children || []).filter(child => child.ID).map(child => child.ID);
            if (JSON.stringify(actualChildIDs) !== JSON.stringify(expected.childIDs)) {
                errors.push(`${expected.id} child order is ${actualChildIDs.join(",")}, expected ${expected.childIDs.join(",")}`);
            }
        });
        return errors;
    }, {timeout: 10000}).toEqual([]);
};
