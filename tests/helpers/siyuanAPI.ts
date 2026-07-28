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
    encrypted: boolean;
    unlocked: boolean;
}

export interface IEncryptedNotebookStatus {
    enabled: boolean;
    count: number;
    boxes: Array<{
        id: string;
        name: string;
        unlocked: boolean;
    }>;
    migrationPending: boolean;
    migrationBoxes: string[];
    hasHistoryDependency: boolean;
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

export interface ISearchTagsResult {
    tags: string[];
    k: string;
}

export interface IBookmark {
    name: string;
    blocks: ISearchBlock[];
    type: "bookmark";
    depth: number;
    count: number;
}

export interface IOutlineBlock {
    id: string;
    content: string;
    children?: IOutlineBlock[];
}

export interface IOutlinePath {
    id: string;
    name: string;
    blocks: IOutlineBlock[];
}

export interface IBacklinkPath {
    id: string;
    box: string;
    name: string;
    hPath: string;
    type: "backlink";
    count: number;
    children?: IBacklinkPath[];
}

export interface IBacklinkResult {
    backlinks: IBacklinkPath[];
    linkRefsCount: number;
    backmentions: IBacklinkPath[];
    mentionsCount: number;
    k: string;
    mk: string;
    box: string;
}

export interface IRiffCardProgress {
    due: string;
    reps: number;
    lapses: number;
    state: number;
    lastReview: string;
}

export interface IRiffCardBlock {
    id: string;
    rootID: string;
    content: string;
    ial: Record<string, string>;
    riffCardID: string;
    riffCard: IRiffCardProgress;
}

export interface IRiffCardsResult {
    blocks: IRiffCardBlock[];
    total: number;
    pageCount: number;
}

export interface IRiffDueCard {
    deckID: string;
    cardID: string;
    blockID: string;
    nextDues: Record<string, string>;
    lapses: number;
    lastReview: number;
    reps: number;
    state: number;
}

export interface IRiffDueCardsResult {
    cards: IRiffDueCard[];
    unreviewedCount: number;
    unreviewedNewCardCount: number;
    unreviewedOldCardCount: number;
}

export interface IAppearanceSettings {
    mode: number;
    modeOS: boolean;
    [key: string]: unknown;
}

export interface IFileTreeSettings {
    docCreateTemplatePath: string;
    [key: string]: unknown;
}

export interface IWorkspaceInfo {
    workspaceDir: string;
    siyuanVer: string;
}

export interface INotebookConf {
    sortMode: number;
    [key: string]: unknown;
}

export interface IBlockInfo {
    box: string;
    path: string;
}

export interface IDocumentContent {
    id: string;
    rootID: string;
    content: string;
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

    async postResult<T>(path: string, data: object, timeout?: number): Promise<ISiyuanResponse<T>> {
        const response = await this.request.post(this.resolve(path), {data, timeout});
        if (!response.ok()) {
            throw new Error(`${path} returned HTTP ${response.status()}: ${await response.text()}`);
        }
        return response.json() as Promise<ISiyuanResponse<T>>;
    }

    async post<T>(path: string, data: object, timeout?: number): Promise<T> {
        const result = await this.postResult<T>(path, data, timeout);
        if (result.code !== 0) {
            throw new Error(`${path} failed with code ${result.code}: ${result.msg}`);
        }
        return result.data;
    }

    async getWorkspaceInfo() {
        return this.post<IWorkspaceInfo>("/api/system/getWorkspaceInfo", {});
    }

    async getConf() {
        return this.post<{conf: {
            appearance: IAppearanceSettings;
            fileTree: IFileTreeSettings;
        }}>("/api/system/getConf", {});
    }

    async setAppearance(appearance: IAppearanceSettings) {
        return this.post<IAppearanceSettings>("/api/setting/setAppearance", appearance);
    }

    async setFileTree(fileTree: IFileTreeSettings) {
        return this.post<IFileTreeSettings>("/api/setting/setFiletree", fileTree);
    }

    async listNotebooks() {
        const data = await this.post<{notebooks: INotebook[]}>("/api/notebook/lsNotebooks", {});
        return data.notebooks;
    }

    async createNotebook(name: string) {
        const data = await this.post<{notebook: INotebook}>("/api/notebook/createNotebook", {name});
        return data.notebook;
    }

    async createEncryptedNotebook(name: string, password: string) {
        const data = await this.post<{notebook: INotebook}>("/api/notebook/createEncryptedNotebook", {
            name,
            password,
        });
        return data.notebook;
    }

    async getEncryptedNotebookStatus() {
        return this.post<IEncryptedNotebookStatus>("/api/notebook/getEncryptedNotebookStatus", {});
    }

    async checkBlocksExist(ids: string[]) {
        return this.post<Record<string, boolean>>("/api/block/checkBlocksExist", {ids});
    }

    async lockNotebook(notebook: string) {
        await this.post<null>("/api/notebook/lockNotebook", {notebook});
    }

    async unlockAndOpenNotebook(notebook: string, password: string) {
        await this.post<null>("/api/notebook/unlockAndOpenNotebook", {notebook, password});
    }

    async openNotebook(notebook: string) {
        await this.post<null>("/api/notebook/openNotebook", {notebook}, 30000);
    }

    async closeNotebook(notebook: string) {
        await this.post<null>("/api/notebook/closeNotebook", {notebook});
    }

    async renameNotebook(notebook: string, name: string) {
        await this.post<null>("/api/notebook/renameNotebook", {notebook, name});
    }

    async getNotebookConf(notebook: string) {
        return this.post<{box: string; name: string; conf: INotebookConf}>("/api/notebook/getNotebookConf", {
            notebook,
        });
    }

    async setNotebookConf(notebook: string, conf: INotebookConf) {
        await this.post<null>("/api/notebook/setNotebookConf", {notebook, conf});
    }

    async removeNotebook(notebook: string) {
        await this.post<null>("/api/notebook/removeNotebook", {notebook});
    }

    async listDocuments(notebook: string, path = "/") {
        const data = await this.post<{files: IDocumentEntry[]}>("/api/filetree/listDocsByPath", {
            notebook,
            path,
            maxListCount: 0,
        }, 30000);
        return data.files;
    }

    async listAllDocuments(notebook: string) {
        const directories = ["/"];
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
        }, 30000);
    }

    async removeDocument(id: string) {
        await this.post<null>("/api/filetree/removeDocByID", {id});
    }

    async renameDocument(id: string, title: string) {
        await this.post<null>("/api/filetree/renameDocByID", {id, title});
    }

    async getBlockAttrs(id: string) {
        return this.post<Record<string, string>>("/api/attr/getBlockAttrs", {id});
    }

    async setBlockAttrs(id: string, attrs: Record<string, string | null>) {
        await this.post<null>("/api/attr/setBlockAttrs", {id, attrs});
    }

    async getBookmarks() {
        return this.post<IBookmark[]>("/api/bookmark/getBookmark", {}, 30000);
    }

    async getDocumentOutline(id: string) {
        return this.post<IOutlinePath[]>("/api/outline/getDocOutline", {id, preview: false});
    }

    async getBacklinks(id: string) {
        return this.post<IBacklinkResult>("/api/ref/getBacklink2", {
            id,
            k: "",
            mk: "",
            sort: "3",
            mSort: "3",
        }, 30000);
    }

    async refreshBacklinks(id: string) {
        await this.post<null>("/api/ref/refreshBacklink", {id});
    }

    async getTreeRiffCards(id: string) {
        return this.post<IRiffCardsResult>("/api/riff/getTreeRiffCards", {id, page: 1, pageSize: 20});
    }

    async getTreeRiffDueCards(rootID: string, reviewedCards: Array<{cardID: string}> = []) {
        return this.post<IRiffDueCardsResult>("/api/riff/getTreeRiffDueCards", {rootID, reviewedCards});
    }

    async reviewRiffCard(deckID: string, cardID: string, rating: 1 | 2 | 3 | 4,
                         reviewedCards: Array<{cardID: string}> = []) {
        await this.post<null>("/api/riff/reviewRiffCard", {deckID, cardID, rating, reviewedCards});
    }

    async flushTransactions() {
        await this.post<null>("/api/sqlite/flushTransaction", {}, 30000);
    }

    async querySQL(stmt: string) {
        return this.post<Array<Record<string, unknown>>>("/api/query/sql", {stmt}, 30000);
    }

    async createDailyNote(notebook: string) {
        return this.post<{id: string}>("/api/filetree/createDailyNote", {notebook}, 30000);
    }

    async moveDocuments(fromIDs: string[], toID: string) {
        await this.post<null>("/api/filetree/moveDocsByID", {fromIDs, toID});
    }

    async changeFileTreeSort(notebook: string, paths: string[]) {
        await this.post<null>("/api/filetree/changeSort", {notebook, paths});
    }

    async duplicateDocument(id: string) {
        return this.post<IDuplicatedDocument>("/api/filetree/duplicateDoc", {id});
    }

    async getDocumentPath(id: string) {
        return this.post<IDocumentLocation>("/api/filetree/getPathByID", {id});
    }

    async findDocumentPath(id: string) {
        const path = "/api/filetree/getPathByID";
        const deadline = Date.now() + 30000;
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

    async searchDocumentHistory(id: string, notebook: string, op: "all" | "delete" | "update" = "all") {
        return this.post<IDocumentHistorySearch>("/api/history/searchHistory", {
            query: id,
            notebook,
            op,
            page: 1,
            type: 3,
        }, 30000);
    }

    async getDocumentHistoryItems(id: string, created: string, op: "all" | "delete" | "update" = "all") {
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

    async createDocumentHistory(id: string) {
        await this.post<null>("/api/history/createDocHistory", {id});
    }

    async createAssetHistory(path: string) {
        await this.post<null>("/api/history/createAssetHistory", {path});
    }

    async getDocumentHistoryContent(historyPath: string) {
        return this.post<{
            content: string;
            id: string;
            isLargeDoc: boolean;
            rootID: string;
        }>("/api/history/getDocHistoryContent", {
            highlight: false,
            historyPath,
            k: "",
        });
    }

    async searchHistory(query: string, notebook: string, op: string, type: number) {
        return this.post<IDocumentHistorySearch>("/api/history/searchHistory", {
            notebook,
            op,
            page: 1,
            query,
            type,
        }, 30000);
    }

    async getHistoryItems(query: string, created: string, op: string, type: number) {
        const data = await this.post<{items: IDocumentHistoryItem[]}>("/api/history/getHistoryItems", {
            created,
            op,
            query,
            type,
        });
        return data.items;
    }

    async rollbackAttributeViewHistory(historyPath: string) {
        await this.post<null>("/api/history/rollbackAttributeViewHistory", {historyPath});
    }

    async rollbackAssetHistory(historyPath: string) {
        await this.post<null>("/api/history/rollbackAssetsHistory", {historyPath});
    }

    async searchBlocksResult(query: string, notebook?: string) {
        return this.postResult<ISearchResult>("/api/search/fullTextSearchBlock", {
            query,
            method: 0,
            paths: [],
            groupBy: 0,
            orderBy: 0,
            page: 1,
            pageSize: 32,
            ...(notebook ? {notebook} : {}),
        }, 30000);
    }

    async searchBlocks(query: string, notebook?: string) {
        const result = await this.searchBlocksResult(query, notebook);
        if (result.code !== 0) {
            throw new Error(`/api/search/fullTextSearchBlock failed with code ${result.code}: ${result.msg}`);
        }
        return result.data;
    }

    async searchTags(query: string) {
        return this.post<ISearchTagsResult>("/api/search/searchTag", {k: query});
    }

    async getDocumentContent(id: string, notebook?: string) {
        const path = "/api/filetree/getDoc";
        const deadline = Date.now() + 15000;
        while (true) {
            const result = await this.postResult<IDocumentContent>(path, {
                id,
                highlight: false,
                ...(notebook ? {notebook} : {}),
            });
            if (result.code === 0) {
                return result.data;
            }
            if (result.msg !== "indexing" || Date.now() >= deadline) {
                throw new Error(`${path} failed with code ${result.code}: ${result.msg}`);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    async updateBlock(id: string, markdown: string) {
        await this.post<unknown>("/api/block/updateBlock", {
            id,
            dataType: "markdown",
            data: markdown,
        });
    }

    async getBlockInfo(id: string, notebook?: string) {
        return this.post<IBlockInfo>("/api/block/getBlockInfo", {
            id,
            ...(notebook ? {notebook} : {}),
        });
    }

    async readWorkspaceFile<T>(path: string): Promise<T> {
        const response = await this.request.post(this.resolve("/api/file/getFile"), {data: {path}});
        if (!response.ok()) {
            throw new Error(`/api/file/getFile returned HTTP ${response.status()}: ${await response.text()}`);
        }
        return response.json() as Promise<T>;
    }

    async readWorkspaceText(path: string) {
        const response = await this.request.post(this.resolve("/api/file/getFile"), {data: {path}});
        if (!response.ok()) {
            throw new Error(`/api/file/getFile returned HTTP ${response.status()}: ${await response.text()}`);
        }
        return response.text();
    }

    async removeWorkspaceFile(path: string) {
        await this.post<null>("/api/file/removeFile", {path});
    }

    async writeWorkspaceFile(path: string, name: string, mimeType: string, buffer: Buffer) {
        const endpoint = "/api/file/putFile";
        const response = await this.request.post(this.resolve(endpoint), {
            multipart: {
                file: {buffer, mimeType, name},
                isDir: "false",
                path,
            },
        });
        if (!response.ok()) {
            throw new Error(`${endpoint} returned HTTP ${response.status()}: ${await response.text()}`);
        }
        const result = await response.json() as ISiyuanResponse<null>;
        if (result.code !== 0) {
            throw new Error(`${endpoint} failed with code ${result.code}: ${result.msg}`);
        }
    }

    async downloadFile(path: string) {
        const response = await this.request.get(this.resolve(path));
        if (!response.ok()) {
            throw new Error(`${path} returned HTTP ${response.status()}: ${await response.text()}`);
        }
        return Buffer.from(await response.body());
    }

    async uploadAsset(id: string, name: string, mimeType: string, buffer: Buffer) {
        const path = "/api/asset/upload";
        const response = await this.request.post(this.resolve(path), {
            multipart: {
                "file[]": {buffer, mimeType, name},
                id,
            },
        });
        if (!response.ok()) {
            throw new Error(`${path} returned HTTP ${response.status()}: ${await response.text()}`);
        }
        const result = await response.json() as ISiyuanResponse<{
            errFiles: string[];
            succMap: Record<string, string>;
        }>;
        if (result.code !== 0) {
            throw new Error(`${path} failed with code ${result.code}: ${result.msg}`);
        }
        return result.data;
    }

    async importArchive(path: "/api/import/importSY" | "/api/import/importZipMd", archive: Buffer,
                        name: string, notebook: string, toPath = "/") {
        const response = await this.request.post(this.resolve(path), {
            multipart: {
                file: {buffer: archive, mimeType: "application/zip", name},
                notebook,
                toPath,
            },
        });
        if (!response.ok()) {
            throw new Error(`${path} returned HTTP ${response.status()}: ${await response.text()}`);
        }
        const result = await response.json() as ISiyuanResponse<null>;
        if (result.code !== 0) {
            throw new Error(`${path} failed with code ${result.code}: ${result.msg}`);
        }
    }

    async readDocument<T>(id: string): Promise<T> {
        const info = await this.getBlockInfo(id);
        return this.readWorkspaceFile<T>(`/data/${info.box}${info.path}`);
    }
}
