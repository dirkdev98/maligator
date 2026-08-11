import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-diagnostics-"));

describe("node:diagnostics_channel", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/node-diagnostics-channel.cjs",
			name: "node-diagnostics-channel",
			outDir,
			nodeEnabled: true,
		});
	});

	it("runs tracing callbacks through the no-subscriber fast path", () => {
		assertResultPass(runToStdout(bin));
	});
});
