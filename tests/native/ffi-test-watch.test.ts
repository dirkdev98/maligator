import { spawn } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");
const fixture = path.join(repository, "tests/fixtures/ffi-test-watch");

function watch(
	project: string,
	environment: NodeJS.ProcessEnv = {},
	options: Array<string> = [],
) {
	const child = spawn(
		process.execPath,
		[
			path.join(repository, "src/index.ts"),
			"test",
			"--watch",
			"--status",
			...options,
			"tests",
		],
		{
			cwd: project,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...environment, MAL_GC_VERIFY: "1", MAL_GC_AT_EXIT: "1" },
		},
	);
	let output = "";
	const listeners = new Set<() => void>();
	const append = (chunk: Buffer) => {
		output += chunk.toString();
		for (const listener of listeners) listener();
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	let stopped = false;
	const closed = new Promise<number | null>((resolve) => {
		child.once("close", (code) => {
			stopped = true;
			for (const listener of listeners) listener();
			resolve(code);
		});
	});
	return {
		get output() {
			return output;
		},
		async until(predicate: (text: string) => boolean, timeout = 120_000): Promise<void> {
			if (predicate(output)) return;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					listeners.delete(check);
					reject(new Error(`native test watch did not reach its next state:\n${output}`));
				}, timeout);
				const check = () => {
					if (!predicate(output) && !stopped) return;
					clearTimeout(timer);
					listeners.delete(check);
					if (predicate(output)) resolve();
					else reject(new Error(`native test watch exited early:\n${output}`));
				};
				listeners.add(check);
				check();
			});
		},
		async stop(signal: NodeJS.Signals = "SIGTERM") {
			if (!stopped) {
				if (process.platform !== "win32" && child.pid !== undefined)
					process.kill(-child.pid, signal);
				else child.kill(signal);
			}
			const deadline = setTimeout(() => child.kill("SIGKILL"), 40_000);
			try {
				return await closed;
			} finally {
				clearTimeout(deadline);
			}
		},
	};
}

function passes(output: string): number {
	return [...output.matchAll(/Test watch generation \d+: passed\n/g)].length;
}

describe("C libraries in persistent test watch", () => {
	it("keeps file isolates fresh in a shared native host", async () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-test-watch-isolates-"));
		cpSync(fixture, project, { recursive: true });
		writeFileSync(
			path.join(project, "tests/other.test.ts"),
			'import { watch_value } from "maligator:ffi/watch";\nimport { expect, test } from "maligator:test";\nlet calls = 0;\ntest("reads native state in a fresh file isolate", () => { expect(++calls).toBe(1); expect(watch_value()).toBe(1); });\n',
		);
		const session = watch(project, {}, ["--isolate", "--concurrency", "2"]);
		try {
			await session.until((output) => passes(output) >= 1);
			const testFile = path.join(project, "tests/native.test.ts");
			writeFileSync(
				testFile,
				readFileSync(testFile, "utf8").replace(
					"expect(watch_next()).toBe(1)",
					"expect(watch_next()).toBe(2)",
				),
			);
			await session.until((output) => passes(output) >= 2);
			expect(session.output).not.toContain("ffi watch host retired");
			expect(await session.stop(), session.output).toBe(0);
		} finally {
			await session.stop();
			rmSync(project, { recursive: true, force: true });
		}
	}, 300_000);
	it("rebuilds after an implementation-only header changes", async () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-test-watch-private-"));
		cpSync(fixture, project, { recursive: true });
		const source = path.join(project, "native/watch.c");
		writeFileSync(
			source,
			`#include "private.h"\n${readFileSync(source, "utf8").replace("return WATCH_VALUE;", "return WATCH_PRIVATE_VALUE;")}`,
		);
		const header = path.join(project, "native/private.h");
		writeFileSync(header, "#define WATCH_PRIVATE_VALUE 1\n");
		const session = watch(project);
		try {
			await session.until((output) => passes(output) >= 1);
			writeFileSync(header, "#define WATCH_PRIVATE_VALUE 2\n");
			await session.until((output) => output.includes("ffi watch host value 2"));
			const testFile = path.join(project, "tests/native.test.ts");
			writeFileSync(
				testFile,
				readFileSync(testFile, "utf8").replace(
					"expect(watch_value()).toBe(1)",
					"expect(watch_value()).toBe(2)",
				),
			);
			await session.until((output) => passes(output) >= 2);
			expect(await session.stop(), session.output).toBe(0);
		} finally {
			await session.stop();
			rmSync(project, { recursive: true, force: true });
		}
	}, 300_000);
	it("observes a new nested header in a pkg-config include path", async () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-test-watch-search-"));
		const external = mkdtempSync(
			path.join(os.tmpdir(), "mal-ffi-test-watch-search-library-"),
		);
		cpSync(fixture, project, { recursive: true });
		const early = path.join(external, "early");
		const late = path.join(external, "late");
		for (const directory of [early, late])
			mkdirSync(path.join(directory, "pkg"), { recursive: true });
		writeFileSync(path.join(late, "pkg/value.h"), "#define WATCH_VALUE 1\n");
		const header = path.join(project, "native/watch.h");
		writeFileSync(
			header,
			readFileSync(header, "utf8").replace(
				"#define WATCH_VALUE 1",
				"#include <pkg/value.h>",
			),
		);
		writeFileSync(
			path.join(project, "watch.ffi.ts"),
			`export default ${JSON.stringify({ headers: ["watch.h"], find: [{ pkgConfig: "watch-fixture", includeDirs: ["native"], sources: ["native/watch.c"] }] })};\n`,
		);
		writeFileSync(
			path.join(project, "maligator.build.ts"),
			`export default ${JSON.stringify({ surface: { node: true, webPlatform: true }, ffi: { watch: { contract: "watch.ffi.ts", link: "static" } } })};\n`,
		);
		const pkgConfig = path.join(external, "pkg-config");
		writeFileSync(
			pkgConfig,
			`#!/bin/sh\ncase "$1" in\n--modversion) printf '%s\\n' '1.0';;\n--cflags) printf '%s\\n' '-I${early} -I${late}';;\n*) printf '\\n';;\nesac\n`,
		);
		chmodSync(pkgConfig, 0o755);
		const session = watch(project, { PKG_CONFIG: pkgConfig });
		try {
			await session.until((output) => passes(output) >= 1);
			writeFileSync(path.join(early, "pkg/value.h"), "#define WATCH_VALUE 2\n");
			await session.until((output) => output.includes("ffi watch host value 2"));
			const testFile = path.join(project, "tests/native.test.ts");
			writeFileSync(
				testFile,
				readFileSync(testFile, "utf8").replace(
					"expect(watch_value()).toBe(1)",
					"expect(watch_value()).toBe(2)",
				),
			);
			await session.until((output) => passes(output) >= 2);
			expect(await session.stop(), session.output).toBe(0);
		} finally {
			await session.stop();
			rmSync(project, { recursive: true, force: true });
			rmSync(external, { recursive: true, force: true });
		}
	}, 300_000);
	it("reuses native state for JavaScript reruns and replaces it after native edits", async () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-test-watch-"));
		cpSync(fixture, project, { recursive: true });
		const session = watch(project);
		try {
			await session.until((output) => passes(output) >= 1);
			const testFile = path.join(project, "tests/native.test.ts");
			const initial = readFileSync(testFile, "utf8");
			writeFileSync(
				testFile,
				initial.replace("expect(watch_next()).toBe(1)", "expect(watch_next()).toBe(2)"),
			);
			await session.until((output) => passes(output) >= 2);
			expect(session.output).not.toContain("ffi watch host retired");
			const source = path.join(project, "native/watch.c");
			writeFileSync(
				source,
				readFileSync(source, "utf8").replace(
					"return WATCH_VALUE;",
					"return WATCH_VALUE + 10;",
				),
			);
			writeFileSync(
				testFile,
				initial.replace(
					"expect(watch_value()).toBe(1)",
					"expect(watch_value()).toBe(11)",
				),
			);
			await session.until((output) => passes(output) >= 3);
			expect(session.output).toContain("ffi watch host retired");
			expect(await session.stop("SIGINT"), session.output).toBe(0);
			expect([...session.output.matchAll(/ffi watch host retired/g)]).toHaveLength(2);
			const status = session.output
				.split("\n")
				.filter((line) => line.startsWith("Test session "))
				.at(-1)!;
			const snapshot = JSON.parse(status.slice("Test session ".length)) as {
				resources: { loadedImages: number; runningApplications: number };
			};
			expect(snapshot.resources).toMatchObject({
				loadedImages: 0,
				runningApplications: 0,
			});
		} finally {
			await session.stop();
			rmSync(project, { recursive: true, force: true });
		}
	}, 300_000);
	it("recovers a crashed native host on the next edit", async () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-test-watch-crash-"));
		cpSync(fixture, project, { recursive: true });
		const session = watch(project);
		try {
			await session.until((output) => passes(output) >= 1);
			const pid = Number(/ffi watch host pid (\d+)/.exec(session.output)?.[1]);
			expect(pid).toBeGreaterThan(0);
			process.kill(pid, "SIGKILL");
			const testFile = path.join(project, "tests/native.test.ts");
			writeFileSync(testFile, `${readFileSync(testFile, "utf8")}\nvoid 1;\n`);
			await session.until((output) => passes(output) >= 2);
			const next = [...session.output.matchAll(/ffi watch host pid (\d+)/g)].at(-1);
			expect(Number(next?.[1])).not.toBe(pid);
			expect(await session.stop(), session.output).toBe(0);
		} finally {
			await session.stop();
			rmSync(project, { recursive: true, force: true });
		}
	}, 300_000);
	it("recovers after an external header fails to compile", async () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-test-watch-external-"));
		const external = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-test-watch-library-"));
		cpSync(fixture, project, { recursive: true });
		cpSync(path.join(fixture, "native"), external, { recursive: true });
		const header = path.join(external, "watch.h");
		const valid = readFileSync(header, "utf8");
		writeFileSync(header, `${valid}\nthis is invalid C;\n`);
		writeFileSync(
			path.join(project, "maligator.build.ts"),
			`export default ${JSON.stringify({ surface: { node: true, webPlatform: true }, ffi: { watch: { contract: "watch.ffi.ts", find: { includeDirs: [external], sources: [path.join(external, "watch.c")] } } } })};\n`,
		);
		const session = watch(project);
		try {
			await session.until((output) => output.includes("library headers do not compile"));
			writeFileSync(header, valid);
			await session.until((output) => passes(output) >= 1);
			expect(await session.stop(), session.output).toBe(0);
		} finally {
			await session.stop();
			rmSync(project, { recursive: true, force: true });
			rmSync(external, { recursive: true, force: true });
		}
	}, 300_000);
});
