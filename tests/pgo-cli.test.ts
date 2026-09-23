import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.ts";
import { mergePgoCaptures } from "../src/pgo-artifact.ts";
import type { PreparedPgo } from "../src/pgo-artifact.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "pgo-cli-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function trainingBinary(): string {
	const binary = path.join(directory, "training");
	writeFileSync(
		binary,
		`#!${process.execPath}\n` +
			`const fs = require('node:fs');\n` +
			`if (process.env.MAL_INTERP === '1') process.exit(3);\n` +
			`if (process.argv[2] !== 'missing') {\n` +
			`  const functions = Number(process.env.MAL_PGO_FUNCTIONS);\n` +
			`  const calls = Number(process.env.MAL_PGO_CALL_SITES);\n` +
			`  const bytes = Buffer.alloc(64 + (functions + calls) * 8);\n` +
			`  bytes.write('MALPGO1\\0');\n` +
			`  bytes.writeUInt32LE(1, 8);\n` +
			`  bytes.writeUInt32LE(1, 12);\n` +
			`  bytes.writeUInt32LE(functions, 16);\n` +
			`  bytes.writeUInt32LE(calls, 20);\n` +
			`  Buffer.from(process.env.MAL_PGO_IDENTITY, 'hex').copy(bytes, 32);\n` +
			`  bytes.writeBigUInt64LE(BigInt(process.argv[2] === 'fail' ? 1 : process.argv[2]), 64);\n` +
			`  fs.writeFileSync(process.env.MAL_PGO_CAPTURE, bytes);\n` +
			`}\n` +
			`if (process.argv[2] === 'fail') process.exit(7);\n`,
	);
	chmodSync(binary, 0o755);
	const prepared: PreparedPgo = {
		schema: 1,
		semantics: 1,
		producer: "synthetic-training",
		semanticKey: "a".repeat(64),
		image: hash("sha256", readFileSync(binary), "hex"),
		functions: [
			{
				name: "trained",
				generator: false,
				identity: {
					status: "known",
					origin: "b".repeat(64),
					revision: "c".repeat(64),
					portability: "portable",
				},
			},
		],
		calls: [],
	};
	writeFileSync(`${binary}.pgo.json`, JSON.stringify(prepared));
	return binary;
}

function runPrepared(binary: string, workload: string, argument: string) {
	return spawnSync(
		process.execPath,
		[
			path.resolve(import.meta.dirname, "../src/index.ts"),
			"pgo",
			"run",
			binary,
			"--pgo-workload",
			workload,
			"--",
			argument,
		],
		{
			cwd: directory,
			encoding: "utf8",
			env: {
				...process.env,
				MAL_INTERP: "0",
				MALIGATOR_CACHE_DIR: path.join(directory, "user-cache"),
			},
		},
	);
}
it("parses explicit training, profile use and merge inputs", () => {
	expect(
		parseCliArgs([
			"run",
			"app.mjs",
			"--pgo-train",
			"--pgo-workload",
			"representative",
			"--",
			"input.json",
		]),
	).toMatchObject({ kind: "run", pgoTrain: true, pgoWorkload: "representative" });
	expect(parseCliArgs(["build", "app.mjs", "--pgo-use", "profile.json"])).toMatchObject({
		kind: "build",
		pgoUse: "profile.json",
	});
	expect(
		parseCliArgs(["pgo", "merge", "run-a", "run-b", "--out", "profile.json"]),
	).toEqual({ kind: "pgo-merge", inputs: ["run-a", "run-b"], output: "profile.json" });
	expect(
		parseCliArgs([
			"pgo",
			"run",
			"training",
			"--pgo-workload",
			"parser",
			"--",
			"--module",
		]),
	).toEqual({
		kind: "pgo-run",
		binary: "training",
		workload: "parser",
		programArgs: ["--module"],
	});
});
it.each([
	["run", "--pgo-train", "--pgo-use", "profile.json"],
	["run", "--pgo-workload", "without-training"],
	["run", "--pgo-train", "--profile"],
	["pgo", "merge"],
	["pgo", "run", "training"],
	["pgo", "run", "--pgo-workload", "parser"],
])("rejects incompatible or implicit PGO input: %s", (...args) => {
	expect(() => parseCliArgs(args)).toThrow();
});

it("captures multiple workloads from one prepared binary and rejects failed or changed runs", () => {
	const binary = trainingBinary();
	const captures = [
		runPrepared(binary, "parser-small", "2"),
		runPrepared(binary, "parser-large", "5"),
	];
	const paths = captures.map((run) => {
		expect(run.status).toBe(0);
		const manifest = /PGO capture (.+manifest\.json)/u.exec(run.stderr)?.[1];
		expect(manifest).toBeDefined();
		return manifest!;
	});
	const merged = mergePgoCaptures(paths, path.join(directory, "merged.json"));
	expect(merged.profile.runs.map((run) => run.workload).sort()).toEqual([
		"parser-large",
		"parser-small",
	]);
	expect(merged.profile.functions[0]?.count).toBe("7");
	const failed = runPrepared(binary, "failed", "fail");
	expect(failed.status).not.toBe(0);
	const failedManifest = /PGO capture (.+manifest\.json)/u.exec(failed.stderr)?.[1];
	expect(failedManifest).toBeDefined();
	expect(
		(JSON.parse(readFileSync(failedManifest!, "utf8")) as { status: string }).status,
	).toBe("incomplete");
	expect(() => mergePgoCaptures([failedManifest!])).toThrow(/incomplete/u);
	const missing = runPrepared(binary, "missing", "missing");
	expect(missing.status).not.toBe(0);
	const missingManifest = /PGO capture (.+manifest\.json)/u.exec(missing.stderr)?.[1];
	expect(missingManifest).toBeDefined();
	expect(
		(JSON.parse(readFileSync(missingManifest!, "utf8")) as { status: string }).status,
	).toBe("incomplete");
	const before = readdirSync(path.join(directory, ".cache/pgo/runs")).length;
	writeFileSync(binary, `${readFileSync(binary, "utf8")}\n`);
	const changed = runPrepared(binary, "changed", "9");
	expect(changed.status).not.toBe(0);
	expect(changed.stderr).toContain("does not match its source map");
	expect(readdirSync(path.join(directory, ".cache/pgo/runs"))).toHaveLength(before);
});
