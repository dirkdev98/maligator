import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypointToBuffer } from "../src/compiler/pipeline/compile-runtime-program.ts";
import { deserializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const source = `
function invoke(index, replacement) {
  let shared = 1;
  const callbacks = Array.from({ length: 16 }, (_, bias) => function selected(value) {
    return value * 3 + bias + shared;
  });
  if (replacement) callbacks[index] = replacement;
  shared = index;
  return callbacks[index](7);
}
globalThis.invoke = invoke;
`;

function inspect(options: { locked?: boolean; realms?: boolean } = {}) {
	const result = inspectStaticValueFunction(source, "invoke", options);
	const target = result.image.runtime.functions.findIndex(
		(fn) =>
			String.fromCharCode(
				...(result.image.runtime.stringConstants[fn.nameStringIndex] ?? []),
			) === "selected",
	);
	expect(target).toBeGreaterThanOrEqual(0);
	const calls = result.native.instructions.flatMap((plan, instructionIp) =>
		plan?.kind === "call" && plan.guardedFunctionIndices?.includes(target)
			? [{ plan, instructionIp }]
			: [],
	);
	return { ...result, calls };
}

describe("mapped closure target hints", () => {
	it("retains advisory targets in configured portable runtime images", () => {
		const directory = mkdtempSync(join(tmpdir(), "mal-mapped-wire-"));
		try {
			const entrypoint = join(directory, "entry.mjs");
			writeFileSync(entrypoint, source);
			const image = deserializeRuntimeImage(
				compileEntrypointToBuffer(entrypoint, {
					buildConfig: resolveBuildConfig({ engine: { eval: false, realms: false } }),
				}),
			);
			const selected = image.functions.findIndex(
				(fn) =>
					String.fromCharCode(...(image.stringConstants[fn.nameStringIndex] ?? [])) ===
					"selected",
			);
			expect(selected).toBeGreaterThanOrEqual(0);
			expect(
				image.functions.some((fn) =>
					fn.instructions.some(
						(instruction) =>
							instruction.opcode === "CALL" &&
							instruction.guardedFunctionIndices?.includes(selected),
					),
				),
			).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("keeps replacement results boxed and retains the ordinary call ABI", () => {
		const { calls, native } = inspect();
		expect(calls).toHaveLength(1);
		const { plan, instructionIp } = calls[0]!;
		expect(plan.directFunctionIndex).toBeUndefined();
		expect(plan.directEntryId).toBeUndefined();
		const call = native.body.instructions[instructionIp]!;
		if (call.opcode !== "CALL") throw new Error("Hint must refer to an ordinary call");
		expect(native.registerRepresentations[call.dst]).toBe("boxed");
		expect(
			native.storage?.callTransports.some(
				(transport) => transport.instructionIp === instructionIp,
			),
		).toBe(false);
	});
	it.each([{ locked: false }, { realms: true }])(
		"keeps world-dependent calls ordinary for %j",
		(options) => {
			expect(inspect(options).calls).toEqual([]);
		},
	);
});
