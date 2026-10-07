import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	runToStdout,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

it("adopts transferred stores once and retains ownership through failed decoding", () => {
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-clone-take-"));
	try {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "clone-take",
			mainFile: "tests/local/shared-memory-atomics/clone-take.c",
			outDir,
		});
		expect(runToStdout(binary)).toBe("clone-take PASS\n");
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});

describe("shared memory backing and waiter table", () => {
	let outDir: string;
	let invocation: ReturnType<typeof resolveHarnessExecutionInvocation>;

	beforeAll(() => {
		outDir = mkdtempSync(path.join(os.tmpdir(), "mal-shared-memory-atomics-"));
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "shared-memory-atomics",
			mainFile: "tests/local/shared-memory-atomics/main.c",
			outDir,
		});
		invocation = resolveHarnessExecutionInvocation(binary);
	});
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	function runDriver(mode: string | undefined, maxBytes: string | undefined): string {
		const env = { ...process.env };
		delete env.MAL_SHARED_MEMORY_MAX_BYTES;
		if (maxBytes !== undefined) env.MAL_SHARED_MEMORY_MAX_BYTES = maxBytes;
		const args = mode === undefined ? invocation.args : [...invocation.args, mode];
		const result = spawnSync(invocation.executable, args, {
			encoding: "utf8",
			env,
			timeout: scaledNativeRunTimeoutMs(60_000),
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		return result.stdout;
	}

	it("wakes, times out, interrupts and releases across threads", () => {
		expect(runDriver(undefined, undefined)).toBe("shared-memory-atomics PASS\n");
	});

	it("caps live shared bytes at 1 GiB unless the environment overrides it", () => {
		const configured = (maxBytes: string | undefined) => runDriver("limit", maxBytes);
		expect(configured(undefined)).toBe("limit 1073741824\n");
		expect(configured("0")).toBe("limit 0\n");
		expect(configured("4096")).toBe("limit 4096\n");
		expect(configured("18446744073709551615")).toBe("limit 18446744073709551615\n");
		const malformed = ["", "-1", "+4096", " 4096", "4096b", "18446744073709551616"];
		for (const value of malformed) {
			expect(configured(value), JSON.stringify(value)).toBe("limit 1073741824\n");
		}
	});

	it("lets a limit set before the first allocation replace the environment", () => {
		expect(runDriver("override", "1")).toBe("override PASS\n");
	});
});

const CLONE_EXPECTED = [
	"dataview: [true,2,4,3,true]",
	'regexp: [true,"a+b","giu",0,true]',
	'error: [true,"boom",false,true,false,"why",true]',
	'error-name: [true,"Error","x"]',
	"error-no-message: false",
	'boxed: ["object",3,"ab",2,false,"object",true]',
	'boxed-symbol: "DataCloneError"',
	"holes: [3,false,3,7,true]",
	'key-order: ["1","b","a"]',
	'getter-delete: ["a"]',
	"create-data-property: [true,1]",
	"proto-key: [true,true]",
	'transfer-failure: ["DataCloneError",8]',
	"transfer: [0,8]",
	"transfer-unreachable: 0",
	"sab-alias: [true,42]",
	"sab-typed: [[7,7,7,7],0,false]",
	"sab-bytes: [[1,2,3,0],1,15,true]",
	"sab-dataview: [4660,52,18]",
	"sab-grow: [12,12,5,5]",
	'sab-shrink: "RangeError"',
	'wait-async-sync: ["not-equal","timed-out"]',
	"wait-async-pending: [true,true,1]",
	'notified: "ok"',
	'timed: "timed-out"',
].join("\n");

describe("structured clone and shared typed-array semantics", () => {
	for (const compiled of [true, false]) {
		it(`clones, shares and settles waitAsync (${compiled ? "native" : "interpreted"})`, () => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-shared-memory-clone-"));
			try {
				const binary = buildNativeBinary({
					fixture: "tests/local/shared-memory-atomics/clone.js",
					name: `shared-memory-clone-${compiled ? "native" : "interp"}`,
					mainFile: HOST_MAIN,
					outDir,
					compiled,
				});
				const invocation = resolveHarnessExecutionInvocation(binary);
				const result = spawnSync(invocation.executable, invocation.args, {
					encoding: "utf8",
					// A referenced finite waitAsync would hold the process for 60 s.
					timeout: scaledNativeRunTimeoutMs(20_000),
				});
				if (result.error !== undefined) throw result.error;
				expect(result.status, result.stderr || result.stdout).toBe(0);
				expect(result.stdout).toBe(`${CLONE_EXPECTED}\n`);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		});
	}
});

// HTML StructuredSerialize/Deserialize; Error stack/cause follow V8's accompanying data.
const CLONE_INTEGRITY_EXPECTED = [
	"resizable-copy: [true,16,4,2,3,2,2,7,6,true,4]",
	"resizable-transfer: [true,0,true,32,6,[1,2,3,4,0,0]]",
	"resizable-shrunk-view: [0,2,8]",
	"growable-views: [8,2,true,16]",
	'getter-detach-transfer: ["DataCloneError",false,4,true]',
	'getter-detach-copy: "DataCloneError"',
	"transfer-list-snapshot: [true,false,8]",
	'error-cause: [true,"inner",false,true,true]',
	'error-stack: ["string",true,false]',
	"error-cause-cycle: true",
	'error-getters: [true,false,"custom stack",false,{"name":1,"message":0,"stack":1,"cause":0}]',
	"regexp-reset: [0,false,5,true]",
	'boxed-edge: [true,"object",true,1,"é",false]',
	'array-props: [4,false,"b",false,true,false,["1","named"]]',
	'array-getter-grow: [2,["0","1"],3]',
].join("\n");

describe("structured clone data integrity", () => {
	for (const compiled of [true, false]) {
		it(`keeps resizable views, transfer atomicity and Error/RegExp/boxed/array semantics (${compiled ? "native" : "interpreted"})`, () => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-clone-integrity-"));
			try {
				const binary = buildNativeBinary({
					fixture: "tests/local/shared-memory-atomics/clone-integrity.js",
					name: `clone-integrity-${compiled ? "native" : "interp"}`,
					mainFile: HOST_MAIN,
					outDir,
					compiled,
				});
				const invocation = resolveHarnessExecutionInvocation(binary);
				const result = spawnSync(invocation.executable, invocation.args, {
					encoding: "utf8",
					timeout: scaledNativeRunTimeoutMs(20_000),
				});
				if (result.error !== undefined) throw result.error;
				expect(result.status, result.stderr || result.stdout).toBe(0);
				expect(result.stdout).toBe(`${CLONE_INTEGRITY_EXPECTED}\n`);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		});
	}
});

const BUFFER_CONSUMERS_EXPECTED = [
	'buffer-alias: [[1,2,3,4,5,6,0,0],16909060,1541,"010203040506"]',
	'buffer-copy: [[2,3,4,5],0,true,"010202030405"]',
	"buffer-write: [111,107]",
	'text-decoder: ["€ABC","€ABC"]',
	"encode-into: [2,3,[104,195,169,0]]",
	"crypto: [true,true]",
	"fs: [3,[0,2,3,4]]",
	'string-decoder: "€"',
	'stream-shared-view: ["TypeError","TypeError"]',
	"memory-usage: [true,true,1048576]",
].join("\n");

describe("host BufferSource consumers over shared memory", () => {
	let outDir: string | undefined;
	let binary: string;
	beforeAll(() => {
		outDir = mkdtempSync(path.join(os.tmpdir(), "mal-shared-buffer-consumers-"));
		binary = buildNativeBinary({
			fixture: "tests/local/shared-memory-atomics/buffer-consumers.mjs",
			name: "shared-buffer-consumers",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});
	afterAll(() => {
		if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
	});
	it("copies shared bytes through Buffer, text, crypto, fs and decoders", () => {
		const invocation = resolveHarnessExecutionInvocation(binary);
		const result = spawnSync(invocation.executable, invocation.args, {
			encoding: "utf8",
			timeout: scaledNativeRunTimeoutMs(20_000),
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(`${BUFFER_CONSUMERS_EXPECTED}\n`);
	});
});
