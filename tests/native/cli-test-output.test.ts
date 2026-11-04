import { spawnSync } from "node:child_process";
import {
	closeSync,
	cpSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");

it.each([false, true])(
	"reports a large failed-test diagnostic with profiling %s",
	(profile) => {
		const project = mkdtempSync(path.join(os.tmpdir(), "mal-test-output-"));
		try {
			cpSync(path.join(repository, "tests/fixtures/ffi-test-watch"), project, {
				recursive: true,
			});
			writeFileSync(
				path.join(project, "maligator.build.ts"),
				`export default { engine: { eval: false, regexp: false, intl: { enabled: false } }, surface: { node: true, webPlatform: false }, ffi: { watch: { contract: "watch.ffi.ts" } } };\n`,
			);
			const messageLength = 17 * 1024 * 1024;
			writeFileSync(
				path.join(project, "tests/native.test.ts"),
				`import { watch_value } from "maligator:ffi/watch";
import { expect, test } from "maligator:test";
test("large diagnostic", () => {
	expect(watch_value()).toBe(1);
	throw new Error("DIAGNOSTIC_BEGIN" + "x".repeat(${messageLength}) + "DIAGNOSTIC_END");
});\n`,
			);
			const stdoutPath = path.join(project, "stdout.log");
			const stderrPath = path.join(project, "stderr.log");
			const stdout = openSync(stdoutPath, "w");
			const stderr = openSync(stderrPath, "w");
			let result;
			try {
				result = spawnSync(
					process.execPath,
					[
						path.join(repository, "src/index.ts"),
						"test",
						...(profile ? ["--profile"] : []),
						"tests",
					],
					{
						cwd: project,
						env: { ...process.env, MAL_GC_VERIFY: "1" },
						stdio: ["ignore", stdout, stderr],
						timeout: 240_000,
						killSignal: "SIGKILL",
					},
				);
			} finally {
				closeSync(stdout);
				closeSync(stderr);
			}
			expect(result.error, readFileSync(stderrPath, "utf8")).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.status).toBe(1);
			const output = readFileSync(stdoutPath, "utf8");
			const begin = output.indexOf("DIAGNOSTIC_BEGIN");
			expect(begin).toBeGreaterThanOrEqual(0);
			const start = begin + "DIAGNOSTIC_BEGIN".length;
			expect(output.indexOf("DIAGNOSTIC_END", start) - start).toBe(messageLength);
			expect(output).toContain("0 passed, 1 failed");
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	},
	300_000,
);
