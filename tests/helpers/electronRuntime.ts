import {ElectronApplication, Page, _electron, expect, request} from "@playwright/test";
import {mkdir, writeFile} from "node:fs/promises";
import {createWriteStream} from "node:fs";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {createRequire} from "node:module";
import path from "node:path";
import {DEFAULT_TEST_WORKSPACE, openWorkspace, validateTestTarget} from "./runtime";
import {SiyuanAPI} from "./siyuanAPI";

export interface IElectronRuntime {
    app: ElectronApplication;
    page: Page;
    close: () => Promise<void>;
}

export const launchElectronRuntime = async (): Promise<IElectronRuntime> => {
    const appDir = path.resolve(process.env.SIYUAN_ELECTRON_APP_DIR!);
    const baseURL = process.env.SIYUAN_BASE_URL || "http://127.0.0.1:6806";
    const target = new URL(baseURL);
    if (target.origin !== "http://127.0.0.1:6806") {
        throw new Error("The development Electron launcher uses 127.0.0.1:6806; select that isolated target explicitly");
    }
    await new Promise<void>((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(6806, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
    });
    const profile = path.join(tmpdir(), "siyuan-electron-acceptance-20837");
    const home = path.join(profile, "home");
    const appData = path.join(profile, "appData");
    await mkdir(path.join(home, ".config", "siyuan"), {recursive: true});
    await mkdir(appData, {recursive: true});
    await writeFile(path.join(home, ".config", "siyuan", "workspace.json"),
        JSON.stringify([DEFAULT_TEST_WORKSPACE]), "utf8");
    const bootstrap = path.join(profile, "main.cjs");
    const appRequire = createRequire(path.join(appDir, "package.json"));
    await writeFile(bootstrap, `const {app} = require("electron");
app.setPath("home", ${JSON.stringify(home)});
app.setPath("appData", ${JSON.stringify(appData)});
app.setAppPath(${JSON.stringify(path.join(appDir, "electron"))});
require(${JSON.stringify(path.join(appDir, "electron", "main.js"))});
`, "utf8");
    const env: Record<string, string> = {};
    Object.entries(process.env).forEach(([key, value]) => {
        if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
    });
    env.NODE_ENV = "development";
    const log = createWriteStream(path.join(profile, "kernel.log"), {flags: "a"});
    const kernelName = process.platform === "win32" ? "SiYuan-Kernel.exe" : "SiYuan-Kernel";
    const kernel = spawn(path.join(appDir, "kernel", kernelName), [
        `--home-dir=${home}`, `--workspace=${DEFAULT_TEST_WORKSPACE}`, "serve", `--wd=${appDir}`, "--port=6806", "--mode=dev",
    ], {cwd: appDir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    kernel.stdout.pipe(log, {end: false});
    kernel.stderr.pipe(log, {end: false});
    let kernelError: Error | undefined;
    kernel.on("error", error => { kernelError = error; });
    const apiContext = await request.newContext({baseURL});
    const stopKernel = async () => {
        if (kernel.exitCode === null && kernel.signalCode === null) {
            await apiContext.post("/api/system/exit", {data: {force: false, setCurrentWorkspace: false}, timeout: 10000})
                .catch(() => undefined);
            await expect.poll(() => kernel.exitCode !== null || kernel.signalCode !== null, {timeout: 15000})
                .toBe(true).catch(() => kernel.kill());
        }
        await apiContext.dispose();
        log.end();
    };
    try {
        await expect.poll(async () => {
            if (kernelError) throw kernelError;
            if (kernel.exitCode !== null) throw new Error(`Test kernel exited with ${kernel.exitCode}`);
            return apiContext.post("/api/system/getWorkspaceInfo", {data: {}, timeout: 1000})
                .then(response => response.ok()).catch(() => false);
        }, {timeout: 60000, message: "waiting for the managed test kernel"}).toBe(true);
        await validateTestTarget(new SiyuanAPI(apiContext, baseURL), baseURL);
    } catch (error) {
        await stopKernel();
        throw error;
    }
    const app = await _electron.launch({
        executablePath: appRequire("electron"),
        args: [bootstrap, `--workspace=${DEFAULT_TEST_WORKSPACE}`, `--port=${new URL(baseURL).port}`, "--lang=en_US"],
        cwd: appDir,
        env,
        timeout: 60000,
    }).catch(async error => {
        await stopKernel();
        throw error;
    });
    try {
        await expect.poll(() => app.windows().some(page => page.url().includes("/stage/build/app/")),
            {timeout: 60000, message: "waiting for the actual Electron app frontend"}).toBe(true);
        const page = app.windows().find(page => page.url().includes("/stage/build/app/"))!;
        process.env.SIYUAN_ELECTRON_ORIGIN = new URL(page.url()).origin;
        const api = new SiyuanAPI(app.context().request, baseURL);
        await validateTestTarget(api, baseURL);
        return {app, page, close: async () => {
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
                // 文档清理会跳到空白页；恢复应用页后，正常退出才能收到保存握手回应。
                if (!page.isClosed() && page.url() === "about:blank") await openWorkspace(page);
                await Promise.race([app.close(), new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(() => reject(new Error("Managed Electron close timed out")), 30000);
                })]);
            } catch (error) {
                console.warn(`[siyuan-testing] Electron cleanup fallback: ${String(error)}`);
                clearTimeout(deadline);
                await Promise.race([app.evaluate(({app}) => app.exit(0)), new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(() => reject(new Error("Managed Electron exit timed out")), 5000);
                })]).catch(() => app.process().kill());
            } finally {
                clearTimeout(deadline);
                await stopKernel();
            }
        }};
    } catch (error) {
        await app.close();
        await stopKernel();
        throw error;
    }
};
