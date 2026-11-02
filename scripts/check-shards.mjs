import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {closeSync, mkdtempSync, openSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseTestList} from "./shard-list.mjs";

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const playwrightCLI = require.resolve("@playwright/test/cli");
const shardConfig = process.env.SIYUAN_E2E_SHARDS ?? "main editor attribute-view";
const duplicateValues = values => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
const shardEntries = shardConfig.trim().split(/\s+/).map(config => {
    const [name, port, ...extra] = config.split(":");
    if (!name || extra.length ||
        (config.includes(":") && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))) {
        throw new Error(`Invalid shard configuration: ${config}`);
    }
    return {name, port};
});
const duplicateShards = duplicateValues(shardEntries.map(({name}) => name));
const configuredPorts = shardEntries.map(({port}) => port).filter(Boolean);
const duplicatePorts = duplicateValues(configuredPorts);
if (configuredPorts.length && configuredPorts.length !== shardEntries.length) {
    throw new Error("Shard ports must be specified for every shard or omitted for every shard");
}
if (duplicateShards.length || duplicatePorts.length) {
    throw new Error(`Duplicate shard configuration: ${[...duplicateShards, ...duplicatePorts].join(", ")}`);
}
const shards = shardEntries.map(({name}) => name);

const listTests = (shard) => {
    const args = [playwrightCLI, "test", "--list"];
    const env = {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
    };
    delete env.SIYUAN_E2E_SHARD;
    if (shard) {
        args.push("--config=config/playwright.focused.config.ts");
        env.SIYUAN_E2E_SHARD = shard;
    }
    const directory = mkdtempSync(join(tmpdir(), "siyuan-test-list-"));
    const outputPath = join(directory, "list.txt");
    try {
        const output = openSync(outputPath, "w");
        let result;
        try {
            result = spawnSync(process.execPath, args, {
                cwd: projectRoot,
                encoding: "utf8",
                env,
                stdio: ["ignore", output, "pipe"],
            });
        } finally {
            closeSync(output);
        }
        const listing = readFileSync(outputPath, "utf8");
        if (result.error || result.status !== 0) {
            process.stderr.write(listing);
            process.stderr.write(result.stderr || "");
            throw new Error(`Unable to list ${shard ?? "default"} tests`, {cause: result.error});
        }
        return parseTestList(listing);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
};

const difference = (left, right) => [...left].filter(testID => !right.has(testID));
const defaultTests = listTests();
const expectedTests = new Set(defaultTests.filter(testID => !/^encrypted-notebook\.spec\.ts:/.test(testID)));
const shardTests = new Map(shards.map(shard => [shard, listTests(shard)]));
const combinedTests = [...shardTests.values()].flat();
const combinedSet = new Set(combinedTests);
const duplicates = duplicateValues(combinedTests);
const missing = difference(expectedTests, combinedSet);
const unexpected = difference(combinedSet, expectedTests);

for (const [shard, tests] of shardTests) {
    console.log(`${shard}: ${tests.length} tests`);
}

if (duplicates.length || missing.length || unexpected.length) {
    if (duplicates.length) {
        console.error(`Duplicate tests:\n${duplicates.join("\n")}`);
    }
    if (missing.length) {
        console.error(`Missing tests:\n${missing.join("\n")}`);
    }
    if (unexpected.length) {
        console.error(`Unexpected tests:\n${unexpected.join("\n")}`);
    }
    process.exitCode = 1;
} else {
    console.log(`Shard coverage: ${combinedTests.length}/${expectedTests.size} tests`);
}
