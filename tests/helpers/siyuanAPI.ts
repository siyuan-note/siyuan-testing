import {APIRequestContext} from "@playwright/test";

export interface ISiyuanResponse<T> {
    code: number;
    msg: string;
    data: T;
}

export interface INotebook {
    id: string;
    name: string;
    closed: boolean;
}

export interface IDocumentEntry {
    id: string;
    name: string;
    path: string;
    subFileCount: number;
}

export interface IDocumentLocation {
    notebook: string;
    path: string;
}

export interface IDuplicatedDocument extends IDocumentLocation {
    id: string;
    hPath: string;
}

export interface IDocumentHistorySearch {
    histories: string[];
    pageCount: number;
    totalCount: number;
}

export interface IDocumentHistoryItem {
    title: string;
    path: string;
    op: string;
    notebook: string;
}

export interface ISearchBlock {
    id: string;
    rootID: string;
    content: string;
    type: string;
}

export interface ISearchResult {
    blocks: ISearchBlock[];
    matchedBlockCount: number;
    matchedRootCount: number;
    pageCount: number;
    docMode: boolean;
}

export interface IAppearanceSettings {
    mode: number;
    modeOS: boolean;
    [key: string]: unknown;
}

export interface IWorkspaceInfo {
    workspaceDir: string;
    siyuanVer: string;
}

export interface IBlockInfo {
    box: string;
    path: string;
}

export class SiyuanAPI {
    private readonly request: APIRequestContext;
    private readonly baseURL: string;

    constructor(request: APIRequestContext, baseURL: string) {
        this.request = request;
        this.baseURL = baseURL;
    }

    private resolve(path: string) {
        return new URL(path, this.baseURL).toString();
    }

    private async postResult<T>(path: string, data: object): Promise<ISiyuanResponse<T>> {
        const response = await this.request.post(this.resolve(path), {data});
        if (!response.ok()) {
            throw new Error(`${path} returned HTTP ${response.status()}: ${await response.text()}`);
        }
        return response.json() as Promise<ISiyuanResponse<T>>;
    }

    async post<T>(path: string, data: object): Promise<T> {
        const result = await this.postResult<T>(path, data);
        if (result.code !== 0) {
            throw new Error(`${path} failed with code ${result.code}: ${result.msg}`);
        }
        return result.data;
    }

    async getWorkspaceInfo() {
        return this.post<IWorkspaceInfo>("/api/system/getWorkspaceInfo", {});
    }

    async getConf() {
        return this.post<{conf: {appearance: IAppearanceSettings}}>("/api/system/getConf", {});
    }

    async setAppearance(appearance: IAppearanceSettings) {
        return this.post<IAppearanceSettings>("/api/setting/setAppearance", appearance);
    }

    async listNotebooks() {
        const data = await this.post<{notebooks: INotebook[]}>("/api/notebook/lsNotebooks", {});
        return data.notebooks;
    }

    async createNotebook(name: string) {
        const data = await this.post<{notebook: INotebook}>("/api/notebook/createNotebook", {name});
        return data.notebook;
    }

    async openNotebook(notebook: string) {
        await this.post<null>("/api/notebook/openNotebook", {notebook});
    }

    async removeNotebook(notebook: string) {
        await this.post<null>("/api/notebook/removeNotebook", {notebook});
    }

    async listDocuments(notebook: string, path = "/") {
        const data = await this.post<{files: IDocumentEntry[]}>("/api/filetree/listDocsByPath", {
            notebook,
            path,
            maxListCount: 0,
        });
        return data.files;
    }

    async listAllDocuments(notebook: string) {
        const directories = ["/"];
        const notebookDocument = await this.findDocumentPath(notebook);
        if (notebookDocument?.notebook === notebook) {
            directories.push(notebookDocument.path);
        }
        const visitedDirectories = new Set<string>();
        const documents = new Map<string, IDocumentEntry>();
        while (directories.length > 0) {
            const directory = directories.shift()!;
            if (visitedDirectories.has(directory)) {
                continue;
            }
            visitedDirectories.add(directory);
            for (const document of await this.listDocuments(notebook, directory)) {
                documents.set(document.id, document);
                if (document.subFileCount > 0) {
                    directories.push(document.path);
                }
            }
        }
        return [...documents.values()];
    }

    async createDocument(notebook: string, title: string, markdown = "") {
        return this.post<string>("/api/filetree/createDocWithMd", {
            notebook,
            path: `/${title}`,
            markdown,
        });
    }

    async removeDocument(id: string) {
        await this.post<null>("/api/filetree/removeDocByID", {id});
    }

    async renameDocument(id: string, title: string) {
        await this.post<null>("/api/filetree/renameDocByID", {id, title});
    }

    async moveDocuments(fromIDs: string[], toID: string) {
        await this.post<null>("/api/filetree/moveDocsByID", {fromIDs, toID});
    }

    async duplicateDocument(id: string) {
        return this.post<IDuplicatedDocument>("/api/filetree/duplicateDoc", {id});
    }

    async getDocumentPath(id: string) {
        return this.post<IDocumentLocation>("/api/filetree/getPathByID", {id});
    }

    async findDocumentPath(id: string) {
        const path = "/api/filetree/getPathByID";
        const deadline = Date.now() + 5000;
        while (true) {
            const result = await this.postResult<IDocumentLocation>(path, {id});
            if (result.code === 0) {
                return result.data;
            }
            if (result.code === -1 && ["block not found", "tree not found"].includes(result.msg)) {
                return undefined;
            }
            if (result.msg !== "indexing" || Date.now() >= deadline) {
                throw new Error(`${path} failed with code ${result.code}: ${result.msg}`);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    async searchDocumentHistory(id: string, notebook: string, op: "all" | "delete" = "all") {
        return this.post<IDocumentHistorySearch>("/api/history/searchHistory", {
            query: id,
            notebook,
            op,
            page: 1,
            type: 3,
        });
    }

    async getDocumentHistoryItems(id: string, created: string, op: "all" | "delete" = "all") {
        const data = await this.post<{items: IDocumentHistoryItem[]}>("/api/history/getHistoryItems", {
            query: id,
            created,
            op,
            type: 3,
        });
        return data.items;
    }

    async rollbackDocumentHistory(historyPath: string) {
        await this.post<null>("/api/history/rollbackDocHistory", {historyPath});
    }

    async searchBlocks(query: string) {
        return this.post<ISearchResult>("/api/search/fullTextSearchBlock", {
            query,
            method: 0,
            paths: [],
            groupBy: 0,
            orderBy: 0,
            page: 1,
            pageSize: 32,
        });
    }

    async updateBlock(id: string, markdown: string) {
        await this.post<unknown>("/api/block/updateBlock", {
            id,
            dataType: "markdown",
            data: markdown,
        });
    }

    async getBlockInfo(id: string) {
        return this.post<IBlockInfo>("/api/block/getBlockInfo", {id});
    }

    async readWorkspaceFile<T>(path: string): Promise<T> {
        const response = await this.request.post(this.resolve("/api/file/getFile"), {data: {path}});
        if (!response.ok()) {
            throw new Error(`/api/file/getFile returned HTTP ${response.status()}: ${await response.text()}`);
        }
        return response.json() as Promise<T>;
    }

    async readDocument<T>(id: string): Promise<T> {
        const info = await this.getBlockInfo(id);
        return this.readWorkspaceFile<T>(`/data/${info.box}${info.path}`);
    }
}
