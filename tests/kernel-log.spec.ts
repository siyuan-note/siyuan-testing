import {expect, test} from "@playwright/test";
import {extractKernelErrors} from "./helpers/kernelLog";

test.describe("kernel log audit", () => {
    test("distinguishes retried repository changes from terminal and unrelated errors", () => {
        const retried = [
            "E 2026/07/22 20:20:10 repo.go:1209: file changed [data/sort.json], size [1 -> 2]",
            "I 2026/07/22 20:20:10 serve.go:483: serving [/],",
            "W 2026/07/22 20:20:10 repo.go:863: index failed, caused by: file changed, retrying [0]",
        ];
        expect(extractKernelErrors(retried.join("\n"))).toEqual([]);

        const terminal = "W 2026/07/22 20:20:11 repo.go:866: index failed after 7 retries, caused by: file changed";
        const unrelated = "E 2026/07/22 20:20:12 database.go:42: query failed";
        const panic = "PANIC RECOVERED: unexpected failure";
        expect(extractKernelErrors([...retried, terminal, unrelated, panic].join("\n")))
            .toEqual([terminal, unrelated, panic]);
    });
});
