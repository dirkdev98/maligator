import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../../../src/build-config.ts";
import { PROCESS_INSTALLER_SYMBOL } from "../../../../src/compiler/frontend/host-modules.ts";
import { buildNativeBinaryResult, HOST_MAIN } from "../../../../src/test-harness.ts";

const examples = path.join(import.meta.dirname, "../examples");
const outDir = mkdtempSync(path.join(tmpdir(), "maligator-lint-examples-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

// Hot examples exercise the measured sites roughly this many times. The thresholds
// distinguish repeated work from the few hits during startup.
const ROUNDS = 10_000;

interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
	/** What Node prints for the same file. */
	nodeStdout: string;
	/** Property loads whose site met a shape other than its cached one. */
	shapeMisses: number;
	/** Shapes created after startup: one per new key path. */
	shapeCreates: number;
	compiledEntries: number;
	arrayCallbackCalls: number;
	tableLookupMisses: number;
	/** Host installers the compiled image links. */
	installers: Array<string>;
}

function counter(stderr: string, line: string, name: string): number {
	const found = stderr.split("\n").find((entry) => entry.startsWith(line)) ?? "";
	return Number(found.match(new RegExp(`(?:^|\\s)${name}=(\\d+)`))?.[1] ?? 0);
}

function run(file: string): Run {
	const built = buildNativeBinaryResult({
		fixture: path.relative(process.cwd(), file),
		name: path.basename(file).replace(/\.[a-z]+$/u, ""),
		mainFile: HOST_MAIN,
		outDir,
		// The rules describe the default closed-world build, not the harness's eval-enabled one.
		config: resolveBuildConfig({}),
		environment: { ...process.env, MAL_PERF_STATS: "1" },
	});
	const result = spawnSync(built.binaryPath, [], {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf8",
	});
	const ic = (name: string) => counter(result.stderr, "[perf-ic-stats]", name);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		nodeStdout: execFileSync(process.execPath, [file], { encoding: "utf8" }),
		shapeMisses: [
			"load_slot_key_hits",
			"load_poly_hits",
			"load_mega_hits",
			"load_mega_misses",
		]
			.map(ic)
			.reduce((total, count) => total + count, 0),
		shapeCreates: counter(result.stderr, "[perf-shape-transition-stats]", "creates"),
		compiledEntries: counter(result.stderr, "[perf-call-cache-stats]", "compiled_enters"),
		arrayCallbackCalls: counter(
			result.stderr,
			"[perf-array-stats]",
			"iteration_exact_compiled_callback_calls",
		),
		tableLookupMisses: counter(
			result.stderr,
			"[perf-table-stats] role=object",
			"lookup_misses",
		),
		installers: built.programImage.runtime.hostInstalls.map(({ installer }) => installer),
	};
}

function behavesLikeNode(example: Run): void {
	expect(example.status, example.stderr).toBe(0);
	expect(example.stdout).toBe(example.nodeStdout);
}

/** Readers of the bad form miss their shape cache on a quarter of the rounds or more. */
function shapeMisses(bad: Run, good: Run): void {
	behavesLikeNode(bad);
	expect(bad.nodeStdout).toBe(good.nodeStdout);
	expect(bad.shapeMisses).toBeGreaterThanOrEqual(ROUNDS / 4);
	expect(good.shapeMisses).toBeLessThan(ROUNDS / 100);
}

/** The bad form creates shapes as its data grows, and the heap keeps them. */
function shapeGrowth(bad: Run, good: Run): void {
	behavesLikeNode(bad);
	expect(bad.shapeCreates).toBeGreaterThanOrEqual(ROUNDS / 4);
	expect(good.shapeCreates).toBeLessThan(ROUNDS / 100);
}

function perRoundCost(
	field: "compiledEntries" | "arrayCallbackCalls" | "tableLookupMisses",
): (bad: Run, good: Run) => void {
	return (bad, good) => {
		behavesLikeNode(bad);
		expect(bad.nodeStdout).toBe(good.nodeStdout);
		expect(bad[field], field).toBeGreaterThanOrEqual(ROUNDS / 4);
		expect(good[field], field).toBeLessThan(ROUNDS / 100);
	};
}

/** The bad form links the complete process installer, which neither form needs. */
function extraInstallers(bad: Run, good: Run): void {
	behavesLikeNode(bad);
	expect(bad.installers).toContain(PROCESS_INSTALLER_SYMBOL);
	expect(good.installers).not.toContain(PROCESS_INSTALLER_SYMBOL);
	expect(bad.installers.length).toBeGreaterThan(good.installers.length);
}

/** The default build locks built-ins, so the bad form throws where Node does not. */
function rejectedAtRuntime(bad: Run): void {
	expect(bad.status).not.toBe(0);
	expect(bad.stderr).toContain("Cannot assign locked primordial property");
}

/** The bad form runs, but prints something other than Node does. */
function differsFromNode(bad: Run): void {
	expect(bad.status, bad.stderr).toBe(0);
	expect(bad.stdout).not.toBe(bad.nodeStdout);
}

/** What each rule's bad examples cost and its good examples avoid. */
const costs: Record<string, (bad: Run, good: Run) => void> = {
	"monomorphic-instances": shapeMisses,
	"monomorphic-objects": shapeMisses,
	"no-class-assign": perRoundCost("compiledEntries"),
	"no-delete-property": shapeMisses,
	"no-dynamic-global-access": extraInstallers,
	"no-func-assign": perRoundCost("arrayCallbackCalls"),
	"no-function-source": differsFromNode,
	"no-primordial-mutation": rejectedAtRuntime,
	"no-sparse-arrays": perRoundCost("tableLookupMisses"),
	"prefer-map": shapeGrowth,
	"strict-commonjs": extraInstallers,
};

const pairs = readdirSync(examples).flatMap((rule) =>
	readdirSync(path.join(examples, rule)).flatMap((file) => {
		const bad = /^(?<example>.+)\.bad(?<extension>\.[a-z]+)$/u.exec(file)?.groups;
		return bad === undefined
			? []
			: [{ rule, example: bad.example!, extension: bad.extension! }];
	}),
);

describe("documented examples compiled by Maligator", () => {
	it.each(pairs)(
		"$rule $example: the bad form pays the cost the good form avoids",
		({ rule, example, extension }) => {
			const cost = costs[rule];
			expect(cost, `no cost check for ${rule}`).toBeDefined();
			const directory = path.join(examples, rule);
			const good = run(path.join(directory, `${example}.good${extension}`));
			behavesLikeNode(good);
			cost!(run(path.join(directory, `${example}.bad${extension}`)), good);
		},
	);
});
