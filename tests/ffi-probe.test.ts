import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FfiCheckReport } from "../src/ffi/check.ts";
import type { FfiProbeReport } from "../src/ffi/probe.ts";

const cliEntry = path.resolve(import.meta.dirname, "../src/index.ts");
const temporary: Array<string> = [];

function project(probe: string): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-probe-"));
	temporary.push(directory);
	writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
	mkdirSync(path.join(directory, "include"));
	writeFileSync(
		path.join(directory, "include/probe.h"),
		"int probe_add(int a, int b);\nint probe_overflow(int value);\nint probe_pause(void);\n",
	);
	writeFileSync(
		path.join(directory, "probe.c"),
		`#include "probe.h"
#include <stdio.h>
#include <time.h>
int probe_add(int a, int b) { return a + b; }
int probe_overflow(int value) { return value + 1; }
int probe_pause(void) {
  fputs("native wait entered\\n", stderr);
  fflush(stderr);
  struct timespec delay = { 10, 0 };
  nanosleep(&delay, 0);
  return 0;
}
`,
	);
	writeFileSync(
		path.join(directory, "probe.ffi.ts"),
		'export default { headers: ["probe.h"], find: [{ includeDirs: ["include"], sources: ["probe.c"] }] };\n',
	);
	writeFileSync(
		path.join(directory, "maligator.build.ts"),
		'export default { engine: { eval: false, realms: false }, surface: { node: true }, ffi: { probe: { contract: "probe.ffi.ts" } } };\n',
	);
	writeFileSync(
		path.join(directory, "probe.test.ts"),
		`import { test, expect } from "maligator:test";\nimport { probe_add, probe_overflow, probe_pause } from "maligator:ffi/probe";\n${probe}\n`,
	);
	return directory;
}

function cli(directory: string, args: ReadonlyArray<string>) {
	return spawnSync(process.execPath, [cliEntry, "ffi", "check", ...args], {
		cwd: directory,
		encoding: "utf8",
		timeout: 240_000,
		maxBuffer: 8 * 1024 * 1024,
	});
}

function probe(
	directory: string,
	status = 0,
	extra: ReadonlyArray<string> = [],
): FfiCheckReport {
	const result = cli(directory, [
		"--update",
		"--probe",
		"probe.test.ts",
		"--json",
		...extra,
	]);
	if (result.status !== status)
		throw new Error(
			`expected exit ${status}, got ${result.status}\n${result.stderr}\n${result.stdout}`,
		);
	return JSON.parse(result.stdout) as FfiCheckReport;
}

function accept(directory: string): string {
	const result = cli(directory, ["--update"]);
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return readFileSync(path.join(directory, "maligator-ffi.lock.json"), "utf8");
}

afterEach(() => {
	for (const directory of temporary.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("FFI sanitizer probes", () => {
	it("accepts only after passing instrumented tests and retains their output as valid JSON", () => {
		const directory = project(
			'test("adds values", () => { console.log("probe note"); expect(probe_add(2, 3)).toBe(5); });',
		);
		const report = probe(directory);
		expect(report.ok).toBe(true);
		expect(report.probe).toMatchObject({
			ok: true,
			sanitizer: process.platform === "darwin" ? "ubsan" : "asan",
			summary: { passed: 1 },
		});
		expect(report.probe?.stdout).toContain("probe note");
		const retained = JSON.parse(
			readFileSync(report.probe!.report, "utf8"),
		) as FfiProbeReport;
		expect(retained).toEqual(report.probe);
		expect(
			report.probe?.inputs.some(
				(input) => input.path === path.join(directory, "probe.c"),
			),
		).toBe(true);
		expect(cli(directory, []).status).toBe(0);
	}, 300_000);

	it("preserves the accepted snapshot when a probe assertion fails", () => {
		const directory = project(
			'test("rejects the wrong result", () => { expect(probe_add(2, 3)).toBe(99); });',
		);
		const before = accept(directory);
		const report = probe(directory, 1);
		expect(report.probe).toMatchObject({ ok: false, summary: { failed: 1 } });
		expect(readFileSync(path.join(directory, "maligator-ffi.lock.json"), "utf8")).toBe(
			before,
		);
	});

	it("rejects undefined behavior inside a configured C source", () => {
		const directory = project(
			'test("overflows in C", () => { probe_overflow(2147483647); });',
		);
		const before = accept(directory);
		const report = probe(directory, 1);
		expect(report.probe?.ok).toBe(false);
		expect(report.probe?.stderr).toMatch(/runtime error.*signed integer overflow/);
		expect(readFileSync(path.join(directory, "maligator-ffi.lock.json"), "utf8")).toBe(
			before,
		);
	});

	it("requires a passed test rather than accepting a skipped-only probe", () => {
		const directory = project(
			'test.skip("later", () => { expect(probe_add(2, 3)).toBe(5); });',
		);
		const before = accept(directory);
		const report = probe(directory, 1);
		expect(report.probe).toMatchObject({ ok: false, summary: { passed: 0, skipped: 1 } });
		expect(report.probe?.error).toContain("at least one test");
		expect(readFileSync(path.join(directory, "maligator-ffi.lock.json"), "utf8")).toBe(
			before,
		);
	});

	it("rejects acceptance when a header changes during the probe", () => {
		const directory = project(
			'import { appendFileSync } from "node:fs";\ntest("changes a header", () => { expect(probe_add(2, 3)).toBe(5); appendFileSync("include/probe.h", "\\n// Changed during the probe.\\n"); });',
		);
		const before = accept(directory);
		const report = probe(directory, 1);
		expect(report.probe?.changedInputs).toContain(
			path.join(directory, "include/probe.h"),
		);
		expect(readFileSync(path.join(directory, "maligator-ffi.lock.json"), "utf8")).toBe(
			before,
		);
	});

	it("checks imported test sources against the revision that was compiled", () => {
		const directory = project(
			'import { change } from "./helper.ts";\ntest("changes its helper", () => { expect(probe_add(2, 3)).toBe(5); change(); });',
		);
		writeFileSync(
			path.join(directory, "helper.ts"),
			'import { appendFileSync } from "node:fs";\nexport function change() { appendFileSync(import.meta.filename, "\\n"); }\n',
		);
		const before = accept(directory);
		const report = probe(directory, 1);
		expect(report.probe?.changedInputs).toContain(path.join(directory, "helper.ts"));
		expect(readFileSync(path.join(directory, "maligator-ffi.lock.json"), "utf8")).toBe(
			before,
		);
	});

	it("preserves a lockfile edited while the probe runs", () => {
		const directory = project(
			'import { writeFileSync } from "node:fs";\ntest("edits the snapshot", () => { writeFileSync("maligator-ffi.lock.json", "owner edit\\n"); expect(probe_add(2, 3)).toBe(5); });',
		);
		accept(directory);
		const report = probe(directory, 1);
		expect(report.probe?.changedInputs).toContain(
			path.join(directory, "maligator-ffi.lock.json"),
		);
		expect(readFileSync(path.join(directory, "maligator-ffi.lock.json"), "utf8")).toBe(
			"owner edit\n",
		);
	});

	it("terminates a blocking C call at the process deadline", () => {
		const directory = project('test("blocks in C", () => { probe_pause(); });');
		const before = accept(directory);
		const report = probe(directory, 1, ["--probe-timeout", "2000"]);
		expect(report.probe?.execution).toMatchObject({ timedOut: true, signal: "SIGKILL" });
		expect(report.probe?.stderr).toContain("native wait entered");
		expect(readFileSync(path.join(directory, "maligator-ffi.lock.json"), "utf8")).toBe(
			before,
		);
	});

	it("rejects a cross-target probe before running or accepting anything", () => {
		const directory = project(
			'test("adds", () => { expect(probe_add(2, 3)).toBe(5); });',
		);
		const result = cli(directory, [
			"--probe",
			"probe.test.ts",
			"--target",
			"fictional-target",
		]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("omit --target");
	});
});
