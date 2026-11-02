import {strict as assert} from "node:assert";
import {test} from "node:test";
import {parseTestList} from "./shard-list.mjs";

test("validates the complete list before excluding setup and teardown", () => {
    const output = "Listing tests:\n" +
        "  [setup] › global.setup.ts:1:1 › setup\n" +
        "  [main] › feature.spec.ts:2:1 › behavior\n" +
        "  [cleanup] › global.teardown.ts:1:1 › cleanup\n" +
        "Total: 3 tests in 3 files\n";
    assert.deepEqual(parseTestList(output), ["feature.spec.ts:2:1 › behavior"]);
    assert.throws(() => parseTestList(output.replace("Total: 3", "Total: 4")), /Incomplete Playwright test list/);
    assert.throws(() => parseTestList(output.replace(/Total:.*\n/, "")), /Incomplete Playwright test list/);
});
