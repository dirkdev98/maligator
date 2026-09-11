import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WASI } from "node:wasi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { assertWasmEngineConfig, buildWasmEngine } from "../src/wasm-build.ts";
import { WasmEngine } from "../src/wasm-embedding.ts";

const config = resolveBuildConfig({
	engine: {
		eval: false,
		realms: false,
		regexp: true,
		temporal: false,
		intl: { enabled: false },
	},
	surface: { node: false, webPlatform: false, maligator: false },
});
let module: WebAssembly.Module;
const directory = mkdtempSync(path.join(os.tmpdir(), "mal-wasm-test-"));

afterAll(() => rmSync(directory, { recursive: true, force: true }));

beforeAll(() => {
	const output = path.join(directory, "fixture.wasm");
	buildWasmEngine({
		root: process.cwd(),
		entry: "tests/fixtures/wasm/entry.mts",
		config,
		output,
	});
	module = new WebAssembly.Module(readFileSync(output));
}, 300_000);

function openEngine(stress = false): WasmEngine {
	const wasi = new WASI({
		version: "preview1",
		args: [],
		env: {
			TZ: "UTC",
			...(stress ? { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1", MAL_GC_STATS: "1" } : {}),
		},
		preopens: {},
		returnOnExit: true,
	});
	const instance = new WebAssembly.Instance(
		module,
		wasi.getImportObject() as WebAssembly.Imports,
	);
	wasi.initialize(instance);
	return new WasmEngine(instance);
}

describe("Wasm reactor embedding", () => {
	it("preserves Unicode and recovers after throws and diagnostic coercion failure", () => {
		const engine = openEngine();
		try {
			expect(engine.call("echo", "café 🐊\0")).toBe("echo:café 🐊\0");
			expect(() => engine.call("fail", "")).toThrow("fixture exception");
			expect(engine.call("echo", "recovered")).toBe("echo:recovered");
			expect(() => engine.call("badDiagnostic", "")).toThrow("Wasm call failed (2)");
			expect(engine.call("echo", "recovered again")).toBe("echo:recovered again");
			expect(() => engine.call("missing", "")).toThrow();
			expect(engine.call("echo", "still usable")).toBe("echo:still usable");
		} finally {
			engine.dispose();
		}
	});

	it("bounds allocations, input and output while preserving subsequent calls", () => {
		const engine = openEngine();
		try {
			expect(engine.api.malloc(512 * 1024 * 1024)).toBe(0);
			expect(() => engine.call("echo", "x".repeat(512 * 1024 + 1))).toThrow(
				/input limits/,
			);
			expect(() => engine.call("oversized", "")).toThrow(/output limit/);
			const large = "🐊".repeat(32 * 1024);
			expect(engine.call("echo", large)).toBe(`echo:${large}`);
			expect(engine.memoryBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
		} finally {
			engine.dispose();
		}
		expect(() => engine.call("echo", "disposed")).toThrow(/disposed/);
	});

	it("retains roots across verified stress collections and repeated calls", () => {
		const engine = openEngine(true);
		try {
			for (let index = 0; index < 20; index++) {
				const input = `${index}:🐊`;
				expect(JSON.parse(engine.call("retain", input))).toEqual(
					Array.from({ length: 80 }, (_, index) => ({ index, input })),
				);
			}
			expect(engine.collections).toBeGreaterThan(0);
		} finally {
			engine.dispose();
		}
	});

	it("rejects unsupported host capabilities before a build", () => {
		expect(() =>
			assertWasmEngineConfig(resolveBuildConfig({ surface: { node: true } })),
		).toThrow(/engine/);
	});
});
