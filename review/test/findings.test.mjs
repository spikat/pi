import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { parseFindings, isTestPath } = await createJiti(import.meta.url, { fsCache: false }).import("../findings.ts");
test("a terminal conclusion is not published as part of the last finding", () => {
	const findings = parseFindings("### [High] Bug\nFile: parser.go:2. Details.\n\n## Conclusion\nOverall good.");
	assert.deepEqual(findings, ["### [High] Bug\nFile: parser.go:2. Details."]);
});
test("test paths include root JS/TS, Python, Go and Rust tests", () => {
	for (const path of ["bounds.test.ts", "parser.spec.js", "test_bounds.py", "bounds_test.py", "parser_test.go", "tests.rs", "__tests__/bounds.ts", "tests/bounds.rs"]) assert.equal(isTestPath(path), true, path);
	assert.equal(isTestPath("src/parser.ts"), false);
});
