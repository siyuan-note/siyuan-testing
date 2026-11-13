import {expect, test} from "@playwright/test";
import {extractKernelErrors} from "./helpers/kernelLog";

test.describe("kernel log audit", () => {
    test("consumes only explicitly expected errors for the same document and exact count", () => {
        const message = "document_title.go: set document title [doc-id] failed: invalid document title source";
        const expected = "E 2026/11/13 14:51:36 document_title.go:154: set document title [doc-id] failed: invalid document title source";
        const otherDocument = expected.replace("[doc-id]", "[other-id]");
        const otherError = expected.replace("invalid document title source", "unexpected storage failure");
        const otherSource = expected.replace("document_title.go", "other.go");
        expect(extractKernelErrors(expected)).toEqual([expected]);
        expect(extractKernelErrors(expected, [message])).toEqual([]);
        expect(extractKernelErrors([expected, otherDocument, otherError, otherSource, expected].join("\n"), [message]))
            .toEqual([otherDocument, otherError, otherSource, expected]);
        expect(extractKernelErrors([expected, expected].join("\n"), [message, message])).toEqual([]);
    });

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

    test("ignores missing trees only after the same document was removed", () => {
        const windowsRemoval = [
            "I 2026/07/27 08:34:10 file.go:1997: removed doc [box-id/doc-id.sy]",
            "W 2026/07/27 08:34:10 file.go:477: query root block ref count elapsed [2327ms]",
            "E 2026/07/27 08:34:11 tree.go:101: load tree failed: open F:\\Workspace\\data\\box-id\\doc-id.sy: " +
            "The system cannot find the file specified.",
        ];
        const linuxRemoval = [
            "I 2026/07/27 08:35:10 file.go:1997: removed doc [box-id/other-id.sy]",
            "E 2026/07/27 08:35:11 tree.go:101: load tree failed: open /workspace/data/box-id/other-id.sy: " +
            "no such file or directory",
        ];
        expect(extractKernelErrors([...windowsRemoval, ...linuxRemoval].join("\n"))).toEqual([]);

        const unrelatedRemoval = [
            "I 2026/07/27 08:36:10 file.go:1997: removed doc [box-id/removed-id.sy]",
            "E 2026/07/27 08:36:11 tree.go:101: load tree failed: open /workspace/data/box-id/missing-id.sy: " +
            "no such file or directory",
        ];
        expect(extractKernelErrors(unrelatedRemoval.join("\n"))).toEqual([unrelatedRemoval[1]]);
    });
});
