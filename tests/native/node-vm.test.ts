import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-vm-"));

describe("node:v8 and node:vm", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/node-vm.mts",
			name: "node-vm",
			outDir,
			nodeEnabled: true,
			evalEnabled: true,
			realmsEnabled: true,
		});
	});

	it("runs code in fresh contexts and exposes explicit GC", () => {
		assertResultPass(runToStdout(bin));
	});

	it("keeps context results alive under GC stress", () => {
		assertResultPass(runToStdout(bin, { env: STRESS_ENV }));
	});
});
