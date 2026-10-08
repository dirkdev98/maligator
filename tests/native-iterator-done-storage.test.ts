import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function iteratorKernel(
	profile = false,
	source = "source",
	body = "total+=value.amount",
) {
	const out = inspectStaticValueFunction(
		`function iterate(source,gate){let total=0;for(const value of ${source}){gate();${body};}return total;}globalThis.iterate=iterate;`,
		"iterate",
		{ profile },
	);
	const ip = out.native.body.instructions.findIndex(
		(op) => op.opcode === "ITERATOR_STEP",
	);
	const op = out.native.body.instructions[ip]!;
	if (op.opcode !== "ITERATOR_STEP") throw new Error("Missing iterator step");
	return { ...out, ip, op };
}

describe("native iterator done storage", () => {
	it("keeps a Boolean done flag outside roots while retaining collected iterator values", () => {
		const out = iteratorKernel();
		expect(out.native.registerRepresentations[out.op.doneDst]).toBe("boxed");
		expect(
			out.native.gc.safepoints.some((point) =>
				point.incomingRootRegisters.includes(out.op.doneDst),
			),
		).toBe(true);
		expect(out.native.storage!.rootRegisters).not.toContain(out.op.doneDst);
		expect(out.native.storage!.rootRegisters).toContain(out.op.valueDst);
		expect(out.c.source).toContain(`r${out.op.doneDst} = mal_value_new_boolean(`);
		expect(out.c.source).toContain(`r${out.op.doneDst} = MAL_VALUE_UNDEFINED;`);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each([
		["[source,{amount:2}]", "total+=value.amount"],
		["'prefix:'+source", "total+=value.length"],
	])("preserves the selected cursor and fallback contract for %s", (source, body) => {
		const out = iteratorKernel(false, source, body);
		expect(out.native.storage!.rootRegisters).not.toContain(out.op.doneDst);
		expect(out.c.source).toContain("mal_vm_iterator_step");
		expect(out.native.storage!.rootRegisters).toContain(out.op.valueDst);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("preserves profile sites and materialized Boolean assignments", () => {
		const out = iteratorKernel(true);
		expect(out.native.storage!.rootRegisters).not.toContain(out.op.doneDst);
		expect(out.c.source).toContain("MAL_PROFILE_SITE_EXECUTION");
		expect(out.c.source).toContain("mal_value_new_boolean");
		expect(out.native.storage!.expressionIps).not.toContain(out.ip);
	});

	it("requires real SSA identity for the private final-output proof", () => {
		const out = iteratorKernel();
		const native = lowerNativeFunctionStorage({
			...out.native,
			storageValues: undefined,
		});
		expect(native.storage!.rootRegisters).toContain(out.op.doneDst);
		expect(() =>
			validateNativeStorage({ ...native, storage: out.native.storage }),
		).toThrow(/invalid or stale storage plan/);
	});

	it("keeps a done destination traced when another writer can store a heap value", () => {
		const out = iteratorKernel();
		const instructions = out.native.body.instructions.map((op, ip) =>
			ip === out.ip + 1 ? { opcode: "MOVE" as const, dst: out.op.doneDst, src: 0 } : op,
		);
		const native = lowerNativeFunctionStorage({
			...out.native,
			body: { ...out.native.body, instructions },
		});
		expect(native.storage!.rootRegisters).toContain(out.op.doneDst);
		expect(() =>
			validateNativeStorage({ ...native, storage: out.native.storage }),
		).toThrow(/invalid or stale storage plan/);
	});

	it("retains aliased value and done outputs", () => {
		const out = iteratorKernel();
		const instructions = out.native.body.instructions.map((op, ip) =>
			ip === out.ip && op.opcode === "ITERATOR_STEP"
				? { ...op, valueDst: op.doneDst }
				: op,
		);
		const native = lowerNativeFunctionStorage({
			...out.native,
			body: { ...out.native.body, instructions },
		});
		expect(native.storage!.rootRegisters).toContain(out.op.doneDst);
	});

	it("retains suspended iterator done values under the coroutine ownership contract", () => {
		const out = inspectStaticValueFunction(
			"async function iterate(source,gate){let total=0;for(const value of source){await gate;total+=value.amount;}return total;}globalThis.iterate=iterate;",
			"iterate",
		);
		const op = out.native.body.instructions.find((op) => op.opcode === "ITERATOR_STEP")!;
		if (op.opcode !== "ITERATOR_STEP") throw new Error("Missing suspended iterator step");
		expect(out.native.storage!.rootRegisters).toContain(op.doneDst);
	});
});
