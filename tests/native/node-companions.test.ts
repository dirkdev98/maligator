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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-companions-"));
const reverseEnv = { MAL_NODE_INSTALL_REVERSE: "1" };

describe("Express Node initialization companions", () => {
	let companionBinaries: Array<string>;
	let constructBinaries: Array<string>;

	beforeAll(() => {
		companionBinaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/fixtures/express-5/companions.cjs",
				name: `node-companions-${compiled ? "compiled" : "interpreted"}`,
				mainFile: "tests/native/node_companions_main.c",
				outDir,
				nodeEnabled: true,
				webPlatformEnabled: false,
				compiled,
			}),
		);
		constructBinaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/fixtures/express-5/construct.cjs",
				name: `express-construct-${compiled ? "compiled" : "interpreted"}`,
				mainFile: "tests/native/node_companions_main.c",
				outDir,
				nodeEnabled: true,
				webPlatformEnabled: false,
				compiled,
			}),
		);
	}, 600_000);

	it("constructs pinned unmodified Express in compiled and interpreted builds", () => {
		for (const binary of constructBinaries) assertResultPass(runToStdout(binary));
	});

	it("preserves canonical identities under fragmented installation and GC stress", () => {
		for (const binary of companionBinaries) {
			assertResultPass(runToStdout(binary, { env: reverseEnv }));
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
			assertResultPass(runToStdout(binary, { env: { ...STRESS_ENV, ...reverseEnv } }));
		}
	});
});
