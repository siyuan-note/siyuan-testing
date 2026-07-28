import {access, mkdir} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const workspace = path.resolve(
    process.env.SIYUAN_EXPECT_WORKSPACE?.trim() || path.join(homedir(), "SiYuan-Testing"),
);
const appDir = path.resolve(
    process.env.SIYUAN_APP_DIR?.trim() || path.join(projectRoot, "..", "siyuan", "app"),
);
const baseURL = new URL(process.env.SIYUAN_BASE_URL || "http://127.0.0.1:6807");
const loopbackHosts = ["127.0.0.1", "localhost", "::1"];

if (baseURL.protocol !== "http:" || !loopbackHosts.includes(baseURL.hostname)) {
    throw new Error(`Local SiYuan launcher requires a loopback HTTP URL, received ${baseURL.origin}`);
}

const port = baseURL.port || "80";
await mkdir(workspace, {recursive: true});
console.log(`[siyuan-testing] Test workspace ${workspace}`);

if (process.argv.includes("--prepare-only")) {
    process.exit(0);
}

const readRunningWorkspace = async (timeoutMs = 2000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(new URL("/api/system/getWorkspaceInfo", baseURL), {
            method: "POST",
            signal: controller.signal,
        });
        if (response.ok) {
            const result = await response.json();
            return result?.data?.workspaceDir;
        }
    } catch {
        return undefined;
    } finally {
        clearTimeout(timeout);
    }
};

const normalizeWorkspace = value => path.resolve(value).replace(/[\\/]+$/, "").toLocaleLowerCase();
const runningWorkspace = await readRunningWorkspace();
if (runningWorkspace) {
    if (normalizeWorkspace(runningWorkspace) !== normalizeWorkspace(workspace)) {
        throw new Error(
            `SiYuan at ${baseURL.origin} uses ${runningWorkspace}, expected ${workspace}. ` +
            "Stop that instance or choose another SIYUAN_BASE_URL.",
        );
    }
}

await access(path.join(appDir, "package.json"));
const appRequire = createRequire(path.join(appDir, "package.json"));
const webpackPath = appRequire.resolve("webpack/bin/webpack.js");
let kernelPath;
if (!runningWorkspace) {
    const defaultKernelPaths = {
        darwin: path.join(process.arch === "arm64" ? "kernel-darwin-arm64" : "kernel-darwin", "SiYuan-Kernel"),
        linux: path.join("kernel-linux", "SiYuan-Kernel"),
        win32: path.join(process.arch === "arm64" ? "kernel-arm64" : "kernel", "SiYuan-Kernel.exe"),
    };
    const relativeKernelPath = defaultKernelPaths[process.platform];
    if (!relativeKernelPath && !process.env.SIYUAN_KERNEL_PATH?.trim()) {
        throw new Error(`Unsupported local kernel platform: ${process.platform}`);
    }
    kernelPath = path.resolve(
        process.env.SIYUAN_KERNEL_PATH?.trim() || path.join(appDir, relativeKernelPath),
    );
    await access(kernelPath);
}
const compiler = spawn(process.execPath, [
    webpackPath,
    "--mode",
    "development",
    "--config",
    "webpack.desktop.js",
], {
    cwd: appDir,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
});

const children = new Set([compiler]);
let interrupted = false;
const stopChildren = () => {
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill();
        }
    }
};
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
        interrupted = true;
        stopChildren();
    });
}

const stripANSI = value => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
let compilerOutput = "";
const compilation = new Promise((resolve, reject) => {
    const inspectOutput = (chunk, target) => {
        target.write(chunk);
        compilerOutput = `${compilerOutput}${stripANSI(chunk.toString())}`.slice(-20000);
        if (/compiled (successfully|with \d+ warnings?)/i.test(compilerOutput)) {
            resolve();
        } else if (/compiled with \d+ errors?/i.test(compilerOutput)) {
            reject(new Error("SiYuan desktop compilation failed"));
        }
    };
    compiler.stdout.on("data", chunk => inspectOutput(chunk, process.stdout));
    compiler.stderr.on("data", chunk => inspectOutput(chunk, process.stderr));
    compiler.once("error", error => reject(new Error(`Unable to compile SiYuan desktop: ${error.message}`)));
    compiler.once("exit", (code, signal) => {
        reject(new Error(`SiYuan desktop compiler exited before completion [code=${code}, signal=${signal}]`));
    });
});

try {
    await compilation;
} catch (error) {
    stopChildren();
    throw error;
}
console.log("[siyuan-testing] SiYuan desktop assets compiled; watching for changes");

if (!runningWorkspace) {
    const kernel = spawn(kernelPath, [
        `--workspace=${workspace}`,
        "serve",
        `--wd=${appDir}`,
        `--port=${port}`,
    ], {
        cwd: appDir,
        env: process.env,
        stdio: "inherit",
    });
    children.add(kernel);
    let kernelError;
    kernel.once("error", error => {
        kernelError = error;
    });

    const deadline = Date.now() + 60000;
    let kernelReady = false;
    while (Date.now() < deadline) {
        if (kernelError) {
            stopChildren();
            throw new Error(`Unable to start SiYuan kernel: ${kernelError.message}`);
        }
        if (kernel.exitCode !== null || kernel.signalCode !== null) {
            stopChildren();
            throw new Error(
                `SiYuan kernel exited before startup [code=${kernel.exitCode}, signal=${kernel.signalCode}]`,
            );
        }
        const startedWorkspace = await readRunningWorkspace(1000);
        if (startedWorkspace) {
            if (normalizeWorkspace(startedWorkspace) !== normalizeWorkspace(workspace)) {
                stopChildren();
                throw new Error(`SiYuan started with ${startedWorkspace}, expected ${workspace}.`);
            }
            kernelReady = true;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!kernelReady) {
        stopChildren();
        throw new Error(`Timed out waiting for SiYuan at ${baseURL.origin}`);
    }
}

console.log(`[siyuan-testing] SiYuan is ready at ${baseURL.origin}`);

const exit = await new Promise(resolve => {
    for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve({code: child.exitCode, signal: child.signalCode});
            return;
        }
        child.once("exit", (code, signal) => resolve({code, signal}));
    }
});
stopChildren();
if (!interrupted) {
    if (exit.signal) {
        console.error(`[siyuan-testing] Managed process exited from signal ${exit.signal}`);
        process.exitCode = 1;
    } else {
        process.exitCode = exit.code ?? 1;
    }
}
