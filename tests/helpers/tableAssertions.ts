import {expect, Locator} from "@playwright/test";
import {SiyuanAPI} from "./siyuanAPI";

interface ISyTableNode {
    Type: string;
    ID?: string;
    Data?: string;
    TextMarkTextContent?: string;
    Properties?: Record<string, string>;
    TableAligns?: number[];
    Children?: ISyTableNode[];
}

const flatten = (node: ISyTableNode): ISyTableNode[] => [node, ...(node.Children || []).flatMap(flatten)];

const inlineText = (node: ISyTableNode): string => {
    if (node.Type === "NodeText" || node.Type === "NodeLinkText" || node.Type === "NodeBackslashContent") {
        return node.Data || "";
    }
    if (node.Type === "NodeTextMark") {
        return node.TextMarkTextContent || "";
    }
    return (node.Children || []).map(inlineText).join("");
};

export const readOrdinaryTable = async (api: SiyuanAPI, docID: string) => {
    const document = await api.readDocument<ISyTableNode>(docID);
    const nodes = flatten(document);
    const ids = nodes.flatMap(node => node.ID ? [node.ID] : []);
    expect(new Set(ids).size, "persisted block IDs remain unique").toBe(ids.length);
    expect(nodes.filter(node => node.ID && node.Properties?.id !== node.ID), "block identity matches Properties.id").toEqual([]);
    const tables = nodes.filter(node => node.Type === "NodeTable");
    expect(tables).toHaveLength(1);
    const table = tables[0];
    const columns = table.TableAligns?.length;
    const head = table.Children?.filter(node => node.Type === "NodeTableHead") || [];
    const body = table.Children?.filter(node => node.Type === "NodeTableRow") || [];
    expect(head).toHaveLength(1);
    expect(table.Children?.length).toBe(body.length + 1);
    const rows = [...head[0].Children || [], ...body];
    for (const row of rows) {
        expect(row.Type).toBe("NodeTableRow");
        expect(row.Children?.length).toBe(columns);
        for (const cell of row.Children || []) {
            expect(cell.Type).toBe("NodeTableCell");
            expect(flatten(cell).filter(node => node.ID || node.Properties?.id), "ordinary cells have no nested block IDs").toEqual([]);
        }
    }
    expect(JSON.stringify(table)).not.toMatch(/data-sy-table-virtual|data-sy-table-cell-inline|table__cell-editor/);
    return rows.map(row => (row.Children || []).map(cell => (cell.Children || []).map(inlineText).join("")));
};

export const assertValidTableDOM = async (table: Locator) => {
    const state = await table.evaluate(element => {
        const ids = Array.from(element.querySelectorAll("[data-node-id]"))
            .filter(node => !node.closest(".table__cell-editor"))
            .map(node => node.getAttribute("data-node-id"));
        const rows = Array.from(element.querySelectorAll("tr"));
        const cells = Array.from(element.querySelectorAll("td, th"));
        return {
            nestedTables: element.querySelectorAll("table table").length,
            duplicateIDs: ids.length - new Set(ids).size,
            invalidRows: rows.filter(row => !["THEAD", "TBODY", "TFOOT"].includes(row.parentElement?.tagName || "")).length,
            invalidCells: cells.filter(cell => cell.parentElement?.tagName !== "TR").length,
        };
    });
    expect(state).toEqual({nestedTables: 0, duplicateIDs: 0, invalidRows: 0, invalidCells: 0});
};
