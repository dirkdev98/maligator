import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-numeric-branch-ranges-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("numeric branch range semantics", () => {
	let compiled: string;
	let interpreted: string;
	let image: ProgramImage;

	beforeAll(() => {
		({
			compiled,
			interpreted,
			programImage: image,
		} = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/numeric-branch-ranges.js",
			name: "numeric-branch-ranges",
			outDir,
			config: resolveBuildConfig({
				engine: { eval: false, primordials: "mutable", realms: true },
			}),
		}));
	}, 600_000);
	it("selects typed transitive fields and removes the bounded remainder", () => {
		const named = (name: string) =>
			image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === name,
			)!;
		const entry = named("transitiveRecord").directEntries.find(
			(entry) => entry.resultFields,
		)!;
		expect(entry.resultFields!.storage[0]).toMatchObject({
			representation: "int32",
			integerRange: { minimum: 0, maximum: 14 },
		});
		expect(named("readTransitiveRecords").recordCalls?.length ?? 0).toBeGreaterThan(0);
		expect(
			named("readTransitiveRecords").body.instructions.some(
				(op) => op.opcode === "BINARY" && op.operator === "%",
			),
		).toBe(false);
		const effectful = named("effectfulIdentityRemainder").body.instructions;
		expect(effectful.some((op) => op.opcode === "BINARY" && op.operator === "%")).toBe(
			false,
		);
		expect(effectful.some((op) => op.opcode === "CALL")).toBe(true);
	});

	it("preserves edge polarity and conservative numeric cases in both backends", () => {
		for (const binary of [compiled, interpreted]) {
			assertExactLines(runToStdout(binary), ["numeric-branch-ranges PASS"]);
		}
	});
});
