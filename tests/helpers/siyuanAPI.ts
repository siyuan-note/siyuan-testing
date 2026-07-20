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

    async post<T>(path: string, data: object): Promise<T> {
        const response = await this.request.post(this.resolve(path), {data});
        if (!response.ok()) {
            throw new Error(`${path} returned HTTP ${response.status()}: ${await response.text()}`);
        }
        const result = await response.json() as ISiyuanResponse<T>;
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

    async listDocuments(notebook: string) {
        const data = await this.post<{files: IDocumentEntry[]}>("/api/filetree/listDocsByPath", {
            notebook,
            path: "/",
            maxListCount: 0,
        });
        return data.files;
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
