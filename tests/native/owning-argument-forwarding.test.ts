import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { owningArgumentForwardingEvalConfig } from "../helpers/native-eval-config.ts";

it.each(["mutable", "locked"] as const)(
	"preserves %s owning argument forwarding",
	(primordials) => {
		const fixture = "tests/local/owning-argument-forwarding.cjs";
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, FORWARDING_POLICY: primordials },
		});
		const outDir = mkdtempSync(join(tmpdir(), "mal-owning-forwarding-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "owning-forwarding",
				outDir,
				nativeStackRoots: "precise",
				config: owningArgumentForwardingEvalConfig(primordials),
			});
			for (const binary of [pair.compiled, pair.interpreted])
				for (const env of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { ...env, MAL_HOST_GC: "1", FORWARDING_POLICY: primordials },
							timeoutMs: 60_000,
						}),
					).toBe(expected);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	},
	600_000,
);
