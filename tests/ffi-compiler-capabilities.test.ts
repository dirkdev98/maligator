import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractCModel } from "../src/ffi/c-extract.ts";

it.each([0, 1])(
	"extracts record ABI when frontend help cannot advertise skip-body support (%s)",
	(helpStatus) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-ffi-compiler-capability-"));
		try {
			const compiler = process.env.CC ?? "clang";
			const found = spawnSync(
				"/bin/sh",
				["-c", 'command -v "$1"', "resolve-compiler", compiler],
				{ encoding: "utf8" },
			);
			expect(found.status, found.stderr).toBe(0);
			const executable = found.stdout.trim();
			const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
			expect(version.status, version.stderr).toBe(0);
			const wrapper = join(directory, "compiler");
			writeFileSync(
				wrapper,
				`#!/bin/sh
for arg do
    if [ "$arg" = '-help' ]; then exit ${helpStatus}; fi
done
for arg do
    if [ "$arg" = '-skip-function-bodies' ]; then echo 'unsupported frontend flag' >&2; exit 1; fi
done
exec '${executable.replaceAll("'", "'\\''")}' "$@"
`,
			);
			chmodSync(wrapper, 0o755);
			writeFileSync(
				join(directory, "capability.h"),
				"typedef struct CapabilityRecord { int first; int second; } CapabilityRecord;\n",
			);
			const model = extractCModel({
				compiler: { path: wrapper, version: version.stdout.split("\n")[0]! },
				environment: process.env,
				headers: ["capability.h"],
				compileArguments: ["-I", directory],
			});
			expect(model.records.get("CapabilityRecord")?.layout).toEqual({
				sizeBits: 64,
				alignmentBits: 32,
				fieldOffsetsBits: [0, 32],
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
