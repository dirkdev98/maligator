import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { emitProgramImage } from "../../src/compiler/target/emit-program-image.ts";
import {
	assertPassLine,
	buildNativeBinary,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-object-slot-coallocation-"));
const hostGc = { MAL_HOST_GC: "1" };

describe("shaped object slot coallocation", () => {
	let compiled: string;
	let instrumented: string;
	let interpreted: string;
	let source: string;

	beforeAll(() => {
		const result = buildNativeBinaryResult({
			fixture: "tests/local/object_slot_coallocation.js",
			name: "object-slot-coallocation",
			compiled: true,
			outDir,
		});
		compiled = result.binaryPath;
		source = emitProgramImage(result.programImage, { compiled: true });
		instrumented = buildNativeBinary({
			fixture: "tests/local/object_slot_coallocation.js",
			name: "object-slot-coallocation-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/object_slot_coallocation.js",
			name: "object-slot-coallocation-ni",
			compiled: false,
			outDir,
		});
	});

	it("publishes admitted constructor shapes once and stores their slots directly", () => {
		expect(source).toContain("mal_vm_constructor_try_begin_initialization(");
		expect(source).toContain("mal_vm_constructor_initialization_store(");
	});

	it("reuses public field definition transitions on reserved receivers", () => {
		const result = spawnSync(instrumented, [], {
			env: {
				...process.env,
				...hostGc,
				MAL_PERF_STATS: "1",
				MAL_PERF_CONTROL: "1",
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		assertPassLine(result.stdout, "object-slot-coallocation");
		const hits = Number(result.stderr.match(/define_transition_hits=(\d+)/)?.[1] ?? 0);
		expect(hits).toBeGreaterThanOrEqual(63 * 8);
	});

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	])("preserves growth and dictionary transitions in %s mode", (_name, binary) => {
		assertPassLine(runToStdout(binary(), { env: hostGc }), "object-slot-coallocation");
		assertPassLine(
			runToStdout(binary(), {
				env: { ...hostGc, ...STRESS_ENV, MAL_GC_AT_EXIT: "1" },
				timeoutMs: 60000,
			}),
			"object-slot-coallocation",
		);
	});

	it("reports coallocations and both migration paths", () => {
		const result = spawnSync(interpreted, [], {
			env: {
				...process.env,
				...hostGc,
				MAL_GC_STATS: "1",
				MAL_GC_AT_EXIT: "1",
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		assertPassLine(result.stdout, "object-slot-coallocation");
		const field = (name: string): number =>
			Number(result.stderr.match(new RegExp(`${name}=([0-9]+)`))?.[1] ?? 0);
		expect(field("object_slot_coallocations")).toBeGreaterThanOrEqual(2010);
		expect(field("object_slot_grow_migrations")).toBeGreaterThanOrEqual(1);
		expect(field("object_slot_dictionary_migrations")).toBeGreaterThanOrEqual(5);
	});
});
