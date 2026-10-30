import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { coreNumericTypedArrayKind } from "../../src/compiler/core/core-heap-brands.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const kinds = Object.getOwnPropertyNames(globalThis).flatMap((name) => {
	const kind = coreNumericTypedArrayKind(name);
	return kind === undefined ? [] : [kind];
});
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-exact-typed-store-"));
const fixture = path.join(outDir, "stores.js");

describe("exact numeric TypedArray stores with external buffers", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;

	beforeAll(() => {
		writeFileSync(
			fixture,
			[
				`"use strict";
			function snapshot(view) {
				return Array.from(view, value => Object.is(value, -0) ? "-0" : String(value));
			}
			`,
				...kinds.map(
					(kind) => `
			function probe${kind}() {
				const bytes = ${kind}.BYTES_PER_ELEMENT;
				const buffer = new ArrayBuffer(bytes * 10, { maxByteLength: bytes * 16 });
				const fixed = new ${kind}(buffer, bytes, 4);
				const tracking = new ${kind}(buffer, bytes);
				const rows = [];
				for (let phase = 0; phase < 5; phase++) {
					for (let index = -2; index < 12; index++) {
						let value = index * 7919.5 - 31;
						if (phase === 1) value = index * 1099511627776 + 0.75;
						if (phase === 2) value = (index - 2) / 0;
						if (phase === 3) value = -(index % 2) * 0;
						if (phase === 4) value = index === 3 ? 254.5 : index + 0.5;
						fixed[index] = value;
						const observed = fixed[index];
						rows.push(Object.is(observed, -0) ? "-0" : String(observed));
						tracking[index] = value;
					}
					fixed[phase + 0.5] = phase;
					tracking[NaN] = phase;
					rows.push(snapshot(tracking));
				}
				buffer.resize(bytes * 2);
				for (let index = 0; index < 6; index++) {
					fixed[index] = index + 10;
					tracking[index] = index + 20;
				}
				rows.push(snapshot(tracking));
				buffer.resize(bytes * 12);
				for (let index = 0; index < 14; index++) {
					fixed[index] = index + 30;
					tracking[index] = index + 40;
				}
				rows.push(snapshot(tracking));
				tracking["label"] = 71;
				tracking["-0"] = 72;
				tracking[-0] = 73;
				rows.push([tracking.label, tracking[0]]);
				let conversions = 0;
				fixed[0] = { valueOf() { conversions++; buffer.resize(0); return 93; } };
				rows.push([conversions, fixed.length, tracking.length]);
				buffer.resize(bytes * 10);
				tracking[0] = { valueOf() { conversions++; buffer.transfer(); return 94; } };
				for (let index = -1; index < 3; index++) tracking[index] = index + 100;
				rows.push([conversions, tracking.length, tracking[0]]);
				for (const value of [1n, Symbol("bad")]) {
					try { tracking[100] = value; rows.push("missed throw"); }
					catch (error) { rows.push(error instanceof TypeError); }
				}
				const shared = new SharedArrayBuffer(bytes * 4, { maxByteLength: bytes * 8 });
				const sharedView = new ${kind}(shared, bytes);
				for (let index = -1; index < 5; index++) sharedView[index] = index + 0.5;
				rows.push(snapshot(sharedView));
				shared.grow(bytes * 8);
				for (let index = 0; index < 9; index++) sharedView[index] = index + 10.5;
				rows.push(snapshot(sharedView));
				return rows;
			}
			console.log("${kind}", JSON.stringify(probe${kind}()));
			`,
				),
			].join("\n"),
		);
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "exact-typed-stores",
			outDir,
			nativeStackRoots: "precise",
			config: resolveBuildConfig({}),
		});
		({ compiled, interpreted } = pair);
		const directKinds = new Set<string>();
		pair.programImage.native.functions.forEach((plan, index) => {
			const emitted = emitCompiledFunction(plan, index, "", false);
			if (!emitted?.source.includes("mal_vm_numeric_typed_array_store_known_receiver("))
				return;
			for (const [ip, instruction] of plan.body.instructions.entries()) {
				const access = plan.instructions[ip];
				if (
					instruction.opcode === "STORE_PROPERTY" &&
					access?.kind === "exact-typed-array-element"
				)
					directKinds.add(access.elementKind);
			}
		});
		expect(directKinds.size).toBeGreaterThan(0);
		expect([...directKinds].sort()).toEqual(kinds.toSorted());
	}, 600_000);

	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("matches Node for conversions, bounds, resize, detachment, and shared growth", () => {
		for (const binary of [compiled, interpreted])
			expect(runToStdout(binary)).toBe(expected);
	});

	it("preserves backing storage and coercion effects under GC stress", () => {
		expect(runToStdout(compiled, { env: { MAL_HOST_GC: "1", ...STRESS_ENV } })).toBe(
			expected,
		);
	});
});
