import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-typescript-erasable-"));
const expected = "TYPESCRIPT_ERASABLE_ISSUE_5_PASS";

describe("compact TypeScript application erasure", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/typescript-erasable-issue-5.ts",
				name: `typescript-erasable-${compiled ? "compiled" : "interpreted"}`,
				outDir,
				compiled,
				evalEnabled: false,
				intlEnabled: false,
				regexpEnabled: false,
				webPlatformEnabled: false,
			}),
		);
	}, 300_000);

	it("preserves runtime semantics in compiled and interpreted builds", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary).trim()).toBe(expected);
		}
	});
});
