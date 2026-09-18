import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-inherited-method-cache-"));

describe("inherited built-in method and native call caches", () => {
	let compiled: string;
	let interpreted: string;
	let monkeyPatch: string;
	let watchedMonkeyPatch: string;
	let watchedMonkeyPatchInterpreted: string;
	let accessor: string;
	let ordinaryCompiled: string;
	let ordinaryInterpreted: string;
	let primitiveCompiled: string;
	let primitiveInterpreted: string;
	let slotCompiled: string;
	let slotInterpreted: string;
	let localValidityCompiled: string;
	let localValidityInterpreted: string;
	let userlandCompiled: string;
	let userlandInterpreted: string;
	let polymorphicCompiled: string;
	let polymorphicInterpreted: string;
	let mixedStaticCompiled: string;
	let mixedStaticInterpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/inherited-method-cache.js",
			name: "inherited-method-cache",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/inherited-method-cache.js",
			name: "inherited-method-cache-ni",
			compiled: false,
			outDir,
		});
		monkeyPatch = buildNativeBinary({
			fixture: "tests/local/inherited-method-cache-monkey-patch.js",
			name: "inherited-method-cache-monkey-patch",
			compiled: true,
			outDir,
		});
		watchedMonkeyPatch = buildNativeBinary({
			fixture: "tests/local/watched-intrinsic-cache-monkey-patch.js",
			name: "watched-intrinsic-cache-monkey-patch",
			compiled: true,
			outDir,
		});
		watchedMonkeyPatchInterpreted = buildNativeBinary({
			fixture: "tests/local/watched-intrinsic-cache-monkey-patch.js",
			name: "watched-intrinsic-cache-monkey-patch-ni",
			compiled: false,
			outDir,
		});
		accessor = buildNativeBinary({
			fixture: "tests/local/inherited-method-cache-accessor.js",
			name: "inherited-method-cache-accessor",
			compiled: true,
			outDir,
		});
		ordinaryCompiled = buildNativeBinary({
			fixture: "tests/local/inherited-ordinary-cache.js",
			name: "inherited-ordinary-cache",
			compiled: true,
			outDir,
		});
		ordinaryInterpreted = buildNativeBinary({
			fixture: "tests/local/inherited-ordinary-cache.js",
			name: "inherited-ordinary-cache-ni",
			compiled: false,
			outDir,
		});
		primitiveCompiled = buildNativeBinary({
			fixture: "tests/local/primitive-load-cache.js",
			name: "primitive-load-cache",
			compiled: true,
			outDir,
		});
		primitiveInterpreted = buildNativeBinary({
			fixture: "tests/local/primitive-load-cache.js",
			name: "primitive-load-cache-ni",
			compiled: false,
			outDir,
		});
		slotCompiled = buildNativeBinary({
			fixture: "tests/local/inherited-property-slot-cache.js",
			name: "inherited-property-slot-cache",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		slotInterpreted = buildNativeBinary({
			fixture: "tests/local/inherited-property-slot-cache.js",
			name: "inherited-property-slot-cache-ni",
			compiled: false,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		localValidityCompiled = buildNativeBinary({
			fixture: "tests/local/inherited-chain-local-validity.js",
			name: "inherited-chain-local-validity",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		localValidityInterpreted = buildNativeBinary({
			fixture: "tests/local/inherited-chain-local-validity.js",
			name: "inherited-chain-local-validity-ni",
			compiled: false,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		userlandCompiled = buildNativeBinary({
			fixture: "tests/local/inherited-userland-cache.js",
			name: "inherited-userland-cache",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		userlandInterpreted = buildNativeBinary({
			fixture: "tests/local/inherited-userland-cache.js",
			name: "inherited-userland-cache-ni",
			compiled: false,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		polymorphicCompiled = buildNativeBinary({
			fixture: "tests/local/inherited-polymorphic-cache.js",
			name: "inherited-polymorphic-cache",
			compiled: true,
			outDir,
		});
		polymorphicInterpreted = buildNativeBinary({
			fixture: "tests/local/inherited-polymorphic-cache.js",
			name: "inherited-polymorphic-cache-ni",
			compiled: false,
			outDir,
		});
		mixedStaticCompiled = buildNativeBinary({
			fixture: "tests/local/inherited-static-load-mixed.js",
			name: "inherited-static-load-mixed",
			compiled: true,
			outDir,
		});
		mixedStaticInterpreted = buildNativeBinary({
			fixture: "tests/local/inherited-static-load-mixed.js",
			name: "inherited-static-load-mixed-ni",
			compiled: false,
			outDir,
		});
	}, 1_200_000);

	it("handles repeated loads/calls, shadows, prototypes, realms, and completions", () => {
		assertExactLines(runToStdout(compiled, { env: { MAL_HOST_GC: "1" } }), [
			"inherited-method-cache PASS",
		]);
	});

	it("uses the same miss/fill path in the interpreter", () => {
		assertExactLines(runToStdout(interpreted, { env: { MAL_HOST_GC: "1" } }), [
			"inherited-method-cache PASS",
		]);
	});

	it("preserves native callback roots under GC stress", () => {
		assertExactLines(
			runToStdout(compiled, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 180_000,
			}),
			["inherited-method-cache PASS"],
		);
	}, 180_000);

	it("invalidates on Date.prototype assignment", () => {
		assertExactLines(runToStdout(monkeyPatch), [
			"inherited-method-cache-monkey-patch PASS",
		]);
	});

	it.each([
		["compiled", () => watchedMonkeyPatch],
		["interpreted", () => watchedMonkeyPatchInterpreted],
	])("invalidates watched intrinsic own values in %s mode", (_name, binary) => {
		assertExactLines(runToStdout(binary()), [
			"watched-intrinsic-cache-monkey-patch PASS",
		]);
	});

	it("preserves guarded Math fallback under interpreted GC stress", () => {
		assertExactLines(runToStdout(watchedMonkeyPatchInterpreted, { env: STRESS_ENV }), [
			"watched-intrinsic-cache-monkey-patch PASS",
		]);
	});

	it("invalidates on Date.prototype accessor replacement", () => {
		assertExactLines(runToStdout(accessor), ["inherited-method-cache-accessor PASS"]);
	});

	it.each([
		["compiled", () => ordinaryCompiled],
		["interpreted", () => ordinaryInterpreted],
	])(
		"preserves ordinary user prototype mutation semantics in %s mode",
		(_name, binary) => {
			assertExactLines(runToStdout(binary(), { env: { MAL_HOST_GC: "1" } }), [
				"inherited-ordinary-cache PASS",
			]);
		},
	);

	it.each([
		["compiled", () => localValidityCompiled],
		["interpreted", () => localValidityInterpreted],
	])("keeps unrelated prototype mutations chain-local in %s mode", (_name, binary) => {
		const result = spawnSync(binary(), [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, ["inherited-chain-local-validity PASS"]);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-ic-stats]"));
		expect(line).toBeDefined();
		const field = (name: string): number =>
			Number(line?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? -1);
		expect(field("inherited_fills")).toBe(1);
		expect(field("load_inherited_hits")).toBe(14);
		expect(field("prototype_epoch_invalidations")).toBeGreaterThan(0);
	});

	it.each([
		["compiled", () => userlandCompiled],
		["interpreted", () => userlandInterpreted],
	])(
		"selectively caches mutable userland prototype chains in %s mode",
		(_name, binary) => {
			const result = spawnSync(binary(), [], {
				env: { ...process.env, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
				encoding: "utf-8",
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			assertExactLines(result.stdout, ["inherited-userland-cache PASS"]);
			const stats = result.stderr
				.split("\n")
				.find((line) => line.startsWith("[perf-ic-stats]"));
			expect(stats).toBeDefined();
			const field = (name: string): number => {
				const match = stats?.match(new RegExp(`${name}=([0-9]+)`));
				return match ? Number(match[1]) : 0;
			};
			expect(field("load_inherited_hits")).toBeGreaterThan(4000);
			expect(field("inherited_fills")).toBeGreaterThan(5);
			const dependencies = result.stderr
				.split("\n")
				.find((line) => line.startsWith("[perf-prototype-dependency-stats]"));
			expect(dependencies).toBeDefined();
			const dependencyField = (name: string): number => {
				const match = dependencies?.match(new RegExp(`${name}=([0-9]+)`));
				return match ? Number(match[1]) : 0;
			};
			expect(dependencyField("register_calls")).toBeGreaterThan(0);
			expect(dependencyField("register_nodes")).toBeGreaterThan(0);
		},
	);

	it("keeps selective userland guards sound under GC stress", () => {
		assertExactLines(
			runToStdout(userlandCompiled, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
			["inherited-userland-cache PASS"],
		);
	});

	it.each([
		["compiled", () => polymorphicCompiled],
		["interpreted", () => polymorphicInterpreted],
	])(
		"preserves alternating inherited methods and mutation semantics in %s mode",
		(_name, binary) => {
			assertExactLines(runToStdout(binary(), { env: { MAL_HOST_GC: "1" } }), [
				"inherited-polymorphic-cache PASS",
			]);
		},
	);

	it("keeps alternating inherited methods sound under GC stress", () => {
		assertExactLines(
			runToStdout(polymorphicCompiled, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
			["inherited-polymorphic-cache PASS"],
		);
	});

	it.each([
		["compiled", () => mixedStaticCompiled],
		["interpreted", () => mixedStaticInterpreted],
	])(
		"keeps ordinary inherited hits isolated from dictionary, primitive, and proxy receivers in %s mode",
		(_name, binary) => {
			assertExactLines(runToStdout(binary()), ["inherited-static-load-mixed PASS"]);
		},
	);

	it("keeps mixed static inherited loads sound under GC stress", () => {
		assertExactLines(
			runToStdout(mixedStaticCompiled, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
			["inherited-static-load-mixed PASS"],
		);
	});

	it.each([
		["compiled", () => ordinaryCompiled],
		["interpreted", () => ordinaryInterpreted],
	])(
		"keeps inherited holder slots and entries sound under GC stress in %s mode",
		(_name, binary) => {
			assertExactLines(
				runToStdout(binary(), {
					env: { MAL_HOST_GC: "1", ...STRESS_ENV },
					// MAL_GC_VERIFY scans the heap at every stress collection, so this broad
					// cross-realm fixture needs extra headroom on a shared runner core.
					timeoutMs: 360_000,
				}),
				["inherited-ordinary-cache PASS"],
			);
		},
		scaledNativeRunTimeoutMs(360_000),
	);

	it.each([
		["compiled", () => primitiveCompiled],
		["interpreted", () => primitiveInterpreted],
	])("caches primitive methods and exotic lengths in %s mode", (_name, binary) => {
		assertExactLines(runToStdout(binary()), ["primitive-load-cache PASS"]);
	});

	it.each([
		["compiled", () => slotCompiled],
		["interpreted", () => slotInterpreted],
	])("reports exact inherited slot fills and hits in %s mode", (_name, binary) => {
		const result = spawnSync(binary(), [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, ["inherited-property-slot-cache PASS"]);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-ic-stats]"));
		expect(line).toBeDefined();
		const field = (name: string): number =>
			Number(line?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? -1);
		// The two loops inline loadProbe independently, producing two cache sites.
		expect(field("inherited_fills")).toBe(2);
		expect(field("load_inherited_hits")).toBe(13);
	});

	it.each([
		["compiled", () => primitiveCompiled],
		["interpreted", () => primitiveInterpreted],
	])("keeps special load caches sound under GC stress in %s mode", (_name, binary) => {
		assertExactLines(
			runToStdout(binary(), {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
			["primitive-load-cache PASS"],
		);
	});
});
