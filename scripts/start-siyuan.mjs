import {access, mkdir} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const normalizeWorkspace = value => path.resolve(value).replace(/[\\/]+$/, "").toLocaleLowerCase();
const workspace = path.resolve(path.join(homedir(), "SiYuan-Testing"));
const configuredWorkspace = process.env.SIYUAN_EXPECT_WORKSPACE?.trim();
if (configuredWorkspace && normalizeWorkspace(configuredWorkspace) !== normalizeWorkspace(workspace)) {
    throw new Error(
        `Managed local tests only use ${workspace}; remove SIYUAN_EXPECT_WORKSPACE instead of creating another workspace.`,
    );
}
const appDir = path.resolve(
    process.env.SIYUAN_APP_DIR?.trim() || path.join(projectRoot, "..", "siyuan", "app"),
);
const baseURL = new URL(process.env.SIYUAN_BASE_URL || "http://127.0.0.1:6807");
const loopbackHosts = ["127.0.0.1", "localhost", "::1"];
const runTestsIndex = process.argv.indexOf("--run-tests");
let playwrightArgs;
if (runTestsIndex !== -1) {
    playwrightArgs = process.argv.slice(runTestsIndex + 1);
    if (playwrightArgs[0] === "--") {
        playwrightArgs.shift();
    }
}

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

const runningWorkspace = await readRunningWorkspace();
if (runningWorkspace) {
    if (normalizeWorkspace(runningWorkspace) !== normalizeWorkspace(workspace)) {
        throw new Error(
            `SiYuan at ${baseURL.origin} uses ${runningWorkspace}, expected ${workspace}. ` +
            "Stop that instance or choose another SIYUAN_BASE_URL.",
        );
    }
    if (playwrightArgs) {
        throw new Error(
            `Managed tests require an unused target, but SiYuan is already running at ${baseURL.origin}. ` +
            "Stop it before running the test command.",
        );
    }
}

await access(path.join(appDir, "package.json"));
const appRequire = createRequire(path.join(appDir, "package.json"));
const webpackPath = appRequire.resolve("webpack/bin/webpack.js");
let kernelPath;
if (!runningWorkspace) {
    kernelPath = path.join(appDir, "kernel", "SiYuan-Kernel");
    await access(kernelPath);
    console.log(`[siyuan-testing] Kernel ${kernelPath}`);
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

const children = new Set([compiler]);
let kernel;
let interrupted = false;
const isRunning = child => child.exitCode === null && child.signalCode === null;
const waitForChild = child => {
    if (!isRunning(child)) {
        return Promise.resolve({code: child.exitCode, signal: child.signalCode});
    }
    return new Promise(resolve => {
        child.once("error", error => resolve({error}));
        child.once("exit", (code, signal) => resolve({code, signal}));
    });
};
const wait = timeout => new Promise(resolve => setTimeout(resolve, timeout));
const requestKernelExit = async () => {
    if (!kernel || !isRunning(kernel)) {
        return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        await fetch(new URL("/api/system/exit", baseURL), {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                force: true,
                setCurrentWorkspace: false,
                execInstallPkg: 1,
            }),
            signal: controller.signal,
        });
    } catch {
        // 当内核无法接收关闭请求时，下面的进程终止逻辑会兜底。
    } finally {
        clearTimeout(timeout);
    }
};
let stopping;
const stopChildren = () => {
    if (!stopping) {
        stopping = (async () => {
            const runningChildren = [...children].filter(isRunning);
            for (const child of runningChildren) {
                if (child !== kernel) {
                    child.kill();
                }
            }
            await requestKernelExit();
            await Promise.race([
                Promise.all(runningChildren.map(waitForChild)),
                wait(30000),
            ]);
            const remainingChildren = [...children].filter(isRunning);
            for (const child of remainingChildren) {
                child.kill("SIGKILL");
            }
            if (remainingChildren.length > 0) {
                await Promise.race([
                    Promise.all(remainingChildren.map(waitForChild)),
                    wait(2000),
                ]);
            }
        })();
    }
    return stopping;
};
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
        interrupted = true;
        void stopChildren();
    });
}

const formatExit = exit => {
    if (exit.error) {
        return exit.error.message;
    }
    if (exit.signal) {
        return `signal ${exit.signal}`;
    }
    return `code ${exit.code}`;
};

const setExitCode = exit => {
    if (interrupted) {
        process.exitCode = 130;
    } else if (exit.error || exit.signal) {
        process.exitCode = 1;
    } else {
        process.exitCode = exit.code ?? 1;
    }
};

const reportManagedExit = exit => {
    if (!interrupted && (exit.error || exit.signal || exit.code !== 0)) {
        console.error(`[siyuan-testing] Managed process exited with ${formatExit(exit)}`);
    }
};

const runPlaywright = () => {
    const testingRequire = createRequire(path.join(projectRoot, "package.json"));
    const playwrightPath = testingRequire.resolve("@playwright/test/cli");
    return spawn(process.execPath, [
        playwrightPath,
        "test",
        ...playwrightArgs,
    ], {
        cwd: projectRoot,
        env: process.env,
        stdio: "inherit",
    });
};

const waitForFirstExit = processes => Promise.race(processes.map(async child => ({
    child,
    exit: await waitForChild(child),
})));

const closeManagedProcesses = async () => {
    await stopChildren();
    console.log("[siyuan-testing] Test kernel and desktop compiler stopped");
};

const failWhenServiceStops = async (serviceProcesses, testRunner) => {
    const firstExit = await waitForFirstExit([...serviceProcesses, testRunner]);
    if (firstExit.child !== testRunner) {
        console.error(
            `[siyuan-testing] Managed process stopped before Playwright completed with ` +
            formatExit(firstExit.exit),
        );
        return {error: new Error("A managed SiYuan process stopped before Playwright completed")};
    }
    return firstExit.exit;
};

const runManagedTests = async serviceProcesses => {
    const testRunner = runPlaywright();
    children.add(testRunner);
    const exit = await failWhenServiceStops(serviceProcesses, testRunner);
    await closeManagedProcesses();
    setExitCode(exit);
};

const watchManagedProcesses = async () => {
    const firstExit = await waitForFirstExit([...children]);
    await stopChildren();
    reportManagedExit(firstExit.exit);
    setExitCode(firstExit.exit);
};

const stopAfterError = async error => {
    await stopChildren();
    throw error;
};

try {
    await compilation;
} catch (error) {
    await stopAfterError(error);
}
console.log("[siyuan-testing] SiYuan desktop assets compiled; watching for changes");

if (!runningWorkspace) {
    kernel = spawn(kernelPath, [
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
            await stopAfterError(new Error(`Unable to start SiYuan kernel: ${kernelError.message}`));
        }
        if (!isRunning(kernel)) {
            await stopAfterError(
                new Error(
                    `SiYuan kernel exited before startup [code=${kernel.exitCode}, signal=${kernel.signalCode}]`,
                ),
            );
        }
        const startedWorkspace = await readRunningWorkspace(1000);
        if (startedWorkspace) {
            if (normalizeWorkspace(startedWorkspace) !== normalizeWorkspace(workspace)) {
                await stopAfterError(
                    new Error(`SiYuan started with ${startedWorkspace}, expected ${workspace}.`),
                );
            }
            kernelReady = true;
            break;
        }
        await wait(250);
    }
    if (!kernelReady) {
        await stopAfterError(new Error(`Timed out waiting for SiYuan at ${baseURL.origin}`));
    }
}

console.log(`[siyuan-testing] SiYuan is ready at ${baseURL.origin}`);

if (playwrightArgs) {
    await runManagedTests([compiler, kernel].filter(Boolean));
} else {
    await watchManagedProcesses();
}
