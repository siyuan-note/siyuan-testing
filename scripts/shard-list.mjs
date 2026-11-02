export const parseTestList = output => {
    const lines = output.split(/\r?\n/);
    const tests = lines.map(line => line.match(/^\s+\[[^\]]+\] › (.+)$/)?.[1]).filter(Boolean);
    const summary = lines.find(line => /^Total: \d+ tests? in \d+ files?$/.test(line));
    const count = summary && Number(summary.match(/^Total: (\d+)/)[1]);
    if (count === null || count === undefined || tests.length !== count) {
        throw new Error(`Incomplete Playwright test list: parsed ${tests.length}, reported ${count ?? "no total"}`);
    }
    return tests.filter(testID => !/^global\.(setup|teardown)\.ts:/.test(testID));
};
