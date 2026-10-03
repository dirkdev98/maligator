import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

describe("closed MessagePorts", () => {
	for (const compiled of [true, false]) {
		it(`stay branded no-ops after peer or own close and live as long as their wrapper (${compiled ? "native" : "interpreted"})`, () => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-workers-closed-port-"));
			try {
				const binary = buildNativeBinary({
					fixture: "tests/local/workers-runtime/closed-port.mjs",
					name: `workers-closed-port-${compiled ? "native" : "interpreted"}`,
					outDir,
					compiled,
					mainFile: "runtime/workers_gc_test_main.c",
				});
				const invocation = resolveHarnessExecutionInvocation(binary);
				const result = spawnSync(invocation.executable, invocation.args, {
					encoding: "utf8",
					env: { ...process.env, MAL_HOST_GC: "1" },
					timeout: scaledNativeRunTimeoutMs(30_000),
				});
				if (result.error !== undefined) throw result.error;
				expect(result.status, result.stderr || result.stdout).toBe(0);
				// A brand failure in a promise job reports only on stderr, not in the exit status.
				expect(result.stderr).toBe("");
				expect(result.stdout.trimEnd().split("\n")).toEqual([
					'peer-closed: [["ok","ok","ok","ok","ok","ok","ok","ok","DataCloneError","DataCloneError","ok","ok"],1,false,0,true,true,1,0]',
					'own-closed: [1,"ok",["ok","ok","DataCloneError",false],["TypeError","TypeError","TypeError","TypeError"]]',
					'gc: [true,true,"ok",1,2]',
				]);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		});
	}
});
