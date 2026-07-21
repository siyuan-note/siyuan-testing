import {mkdir, open, readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";

interface IKernelLogBaseline {
    enabled: boolean;
    logPath?: string;
    offset?: number;
    reason?: string;
}

export interface IKernelLogAudit {
    enabled: boolean;
    errors: string[];
    logPath?: string;
    reason?: string;
}

const BASELINE_PATH = path.resolve("test-results", ".kernel-log-baseline.json");

const writeBaseline = async (baseline: IKernelLogBaseline) => {
    await mkdir(path.dirname(BASELINE_PATH), {recursive: true});
    await writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2), "utf8");
};

export const startKernelLogAudit = async (workspaceDir: string, baseURL: string) => {
    const configuredPath = process.env.SIYUAN_LOG_PATH?.trim();
    const hostname = new URL(baseURL).hostname;
    const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(hostname);
    if (!isLoopback && !configuredPath) {
        await writeBaseline({
            enabled: false,
            reason: "remote target does not define SIYUAN_LOG_PATH",
        });
        return;
    }

    const logPath = configuredPath || path.join(workspaceDir, "temp", "siyuan.log");
    try {
        const info = await stat(logPath);
        await writeBaseline({enabled: true, logPath, offset: info.size});
    } catch (error) {
        await writeBaseline({
            enabled: false,
            logPath,
            reason: `kernel log is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
    }
};

export const finishKernelLogAudit = async (): Promise<IKernelLogAudit> => {
    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as IKernelLogBaseline;
    if (!baseline.enabled || !baseline.logPath || baseline.offset === undefined) {
        return {enabled: false, errors: [], logPath: baseline.logPath, reason: baseline.reason};
    }

    const handle = await open(baseline.logPath, "r");
    try {
        const info = await handle.stat();
        const offset = info.size >= baseline.offset ? baseline.offset : 0;
        const buffer = Buffer.alloc(info.size - offset);
        if (buffer.length > 0) {
            await handle.read(buffer, 0, buffer.length, offset);
        }
        const errors = buffer.toString("utf8").split(/\r?\n/).filter(line =>
            /^E \d{4}\/\d{2}\/\d{2} /.test(line) || line.includes("PANIC RECOVERED"),
        );
        return {enabled: true, errors, logPath: baseline.logPath};
    } finally {
        await handle.close();
    }
};
