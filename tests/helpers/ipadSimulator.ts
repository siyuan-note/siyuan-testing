import {spawn} from "node:child_process";
import {mkdtemp, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {expect, TestInfo} from "@playwright/test";

const scripts = path.resolve(__dirname, "../../scripts/ipad");

const run = (command: string, args: string[], input?: unknown, timeout = 30000): Promise<string> =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, {stdio: "pipe"});
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`${command} timed out after ${timeout}ms\n${stdout}\n${stderr}`));
        }, timeout);
        child.stdout.on("data", data => stdout += data);
        child.stderr.on("data", data => stderr += data);
        child.on("error", error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", code => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`${command} exited with ${code}\n${stdout}\n${stderr}`));
            }
        });
        child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });

export interface IPoint {
    x: number;
    y: number;
}

interface IRect {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

interface ISelectionSnapshot {
    blocks: Array<{id: string; rect: IRect}>;
    selected: string[];
    scrollTop: number;
    viewport: {width: number; height: number};
    editor: IRect;
    content: IRect;
    tracking: boolean;
    hiddenRange: boolean;
    events: Array<{type: string; trusted: boolean; x: number; y: number}>;
}

export class IpadSimulator {
    private url = "";
    private docID = "";
    private constructor(private readonly device: string, private readonly derivedData: string,
                        private readonly testRun: string) {}

    static async create() {
        if (process.platform !== "darwin") {
            throw new Error("iPad gesture tests require macOS, Xcode and a booted iPad simulator");
        }
        const listing = JSON.parse(await run("xcrun", ["simctl", "list", "devices", "booted", "--json"])) as {
            devices: Record<string, Array<{udid: string; name: string; isAvailable: boolean}>>;
        };
        const devices = Object.values(listing.devices).flat().filter(device =>
            device.isAvailable && device.name.startsWith("iPad") &&
            (!process.env.SIYUAN_IPAD_UDID || device.udid === process.env.SIYUAN_IPAD_UDID));
        if (devices.length !== 1) {
            throw new Error("Boot one iPad simulator, or select a booted iPad with SIYUAN_IPAD_UDID");
        }
        const device = devices[0].udid;
        const derivedData = await mkdtemp(path.join(tmpdir(), "siyuan-ipad-tests-"));
        try {
            await run("xcodebuild", ["build-for-testing", "-project", path.join(scripts, "Selection.xcodeproj"),
                "-scheme", "SelectionTests", "-destination", `id=${device}`, "-derivedDataPath", derivedData,
                "-quiet"], undefined, 120000);
            const products = path.join(derivedData, "Build/Products");
            const name = (await readdir(products)).find(name => name.endsWith(".xctestrun"));
            if (!name) {
                throw new Error("Xcode did not generate the UI test configuration");
            }
            return new IpadSimulator(device, derivedData, path.join(products, name));
        } catch (error) {
            await rm(derivedData, {recursive: true, force: true});
            throw error;
        }
    }

    async evaluate<T>(expression: string): Promise<T> {
        const result = await run("python3", [path.join(scripts, "web-inspector.py"), this.device], {
            url: this.url, expression,
        });
        return JSON.parse(result) as T;
    }

    async open(baseURL: string, docID: string) {
        this.docID = docID;
        this.url = new URL(`/stage/build/desktop/?id=${docID}`, baseURL).href;
        await run("xcrun", ["simctl", "openurl", this.device, this.url]);
        await expect.poll(async () => {
            try {
                return await this.evaluate<boolean>(`(() => {
                    document.querySelector('[data-key="dialog-changelog"] .b3-dialog__scrim')?.click();
                    const title = document.querySelector('.protyle-title[data-node-id="${docID}"]');
                    const protyle = title?.closest('.protyle');
                    return protyle?.getAttribute('data-loading') === 'finished' &&
                        !!protyle.querySelector('.protyle-wysiwyg [data-node-id]');
                })()`);
            } catch {
                return false;
            }
        }, {timeout: 60000, message: "waiting for the test document in iPad Safari"}).toBe(true);
        // 仅观察系统事件和最终 DOM，不注入应用实现或合成触摸事件。
        await this.evaluate(`(() => {
            window.__siyuanE2ETouchEvents = [];
            ['touchstart', 'touchend', 'touchcancel'].forEach(type => document.addEventListener(type, event => {
                const touch = event.changedTouches[0];
                window.__siyuanE2ETouchEvents.push({type, trusted: event.isTrusted,
                    x: touch.clientX, y: touch.clientY});
            }, true));
            return true;
        })()`);
    }

    async snapshot(): Promise<ISelectionSnapshot> {
        return this.evaluate(`(() => {
            const title = document.querySelector('.protyle-title[data-node-id="${this.docID}"]');
            const protyle = title.closest('.protyle');
            const editor = protyle.querySelector('.protyle-wysiwyg');
            const content = protyle.querySelector('.protyle-content');
            const rect = element => {
                const r = element.getBoundingClientRect();
                return {left:r.left, right:r.right, top:r.top, bottom:r.bottom};
            };
            return {
                blocks:Array.from(editor.querySelectorAll(':scope > [data-node-id]')).map(element =>
                    ({id:element.dataset.nodeId, rect:rect(element)})),
                selected:Array.from(editor.querySelectorAll('.protyle-wysiwyg--select')).map(e=>e.dataset.nodeId),
                scrollTop:content.scrollTop,
                viewport:{width:innerWidth, height:innerHeight},
                editor:rect(editor), content:rect(content),
                tracking:!!document.onmousemove || !!document.onmouseup,
                hiddenRange:editor.classList.contains('protyle-wysiwyg--hiderange'),
                events:window.__siyuanE2ETouchEvents,
            };
        })()`);
    }

    async drag(start: IPoint, end: IPoint, testInfo: TestInfo) {
        const configuredRun = path.join(path.dirname(this.testRun), "gesture.xctestrun");
        const resultBundle = testInfo.outputPath(`gesture-${Date.now()}.xcresult`);
        const before = await this.snapshot();
        await run("python3", [path.join(scripts, "configure-test-run.py"), this.testRun, configuredRun], {
            start, end, viewport: before.viewport,
        });
        try {
            await run("xcodebuild", ["test-without-building", "-xctestrun", configuredRun,
                "-destination", `id=${this.device}`, "-parallel-testing-enabled", "NO",
                "-resultBundlePath", resultBundle, "-quiet"], undefined, 60000);
        } finally {
            await testInfo.attach("native-gesture-result", {
                body: Buffer.from(resultBundle), contentType: "text/plain",
            });
        }
        const state = await this.snapshot();
        await writeFile(testInfo.outputPath("ipad-selection-state.json"), JSON.stringify(state, null, 2));
        await testInfo.attach("ipad-selection-state", {
            body: Buffer.from(JSON.stringify(state, null, 2)), contentType: "application/json",
        });
        const touch = state.events.find(event => event.type === "touchstart");
        expect(touch, "the gesture must reach the page as a trusted system touch").toBeTruthy();
        expect(touch?.trusted).toBe(true);
        expect(Math.abs(touch!.x - start.x), "native and DOM coordinates must agree").toBeLessThan(3);
        expect(Math.abs(touch!.y - start.y), `native and DOM coordinates must agree: ${JSON.stringify({touch, start})}`)
            .toBeLessThan(3);
        return state;
    }

    async leave() {
        if (this.url) {
            await this.evaluate("location.replace('about:blank'); true");
            this.url = "";
        }
    }

    async close() {
        await rm(this.derivedData, {recursive: true, force: true});
    }
}
