import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import type { FfiInspection } from "../../src/ffi/inspect.ts";

const repository = path.resolve(import.meta.dirname, "../..");

function cli(project: string, args: Array<string>) {
	const result = spawnSync(
		process.execPath,
		[path.join(repository, "src/index.ts"), ...args],
		{
			cwd: project,
			encoding: "utf8",
			timeout: 240_000,
		},
	);
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return result;
}

it.each(["compiled", "interpreted"])(
	"links only the C surface imported exports reach while preserving namespaces and reexports (%s)",
	(backend) => {
		const project = mkdtempSync(path.join(tmpdir(), "mal-ffi-selected-"));
		try {
			cpSync(path.join(repository, "tests/fixtures/ffi-selected-exports"), project, {
				recursive: true,
			});
			const inspection = JSON.parse(
				cli(project, ["ffi", "inspect", "thin", "--json"]).stdout,
			) as FfiInspection;
			expect(
				inspection.functions.find((entry) => entry.name === "thin_unavailable")?.status,
			).toBe("bound");
			for (let build = 0; build < 2; build++) {
				const built = cli(project, [
					"build",
					"--production",
					...(backend === "interpreted" ? ["--no-compiled"] : []),
				]);
				const executed = spawnSync(built.stdout.trim().split("\n").at(-1)!, [], {
					cwd: project,
					encoding: "utf8",
					timeout: 30_000,
					env: { ...process.env, MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" },
				});
				expect(executed.status, executed.stderr || executed.stdout).toBe(0);
				expect(executed.stdout.trim()).toBe("42 43 5");
			}
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	},
	300_000,
);

it("retains C exports used only by a compiled worker", () => {
	const project = mkdtempSync(path.join(tmpdir(), "mal-ffi-worker-exports-"));
	try {
		cpSync(path.join(repository, "tests/fixtures/ffi-selected-exports"), project, {
			recursive: true,
		});
		const built = cli(project, ["build", "worker-main.ts", "--production"]);
		const executed = spawnSync(built.stdout.trim().split("\n").at(-1)!, [], {
			cwd: project,
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" },
		});
		expect(executed.status, executed.stderr || executed.stdout).toBe(0);
		expect(executed.stdout.trim()).toBe("42");
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
}, 300_000);
