import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { lowerNativeSuspension } from "../src/compiler/target/lower-native-suspension.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(prefix = "async function", transfer = "await gate") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.compute = ${prefix} compute(input, gate) { const a=+input; const square=a*a; const before=square+1; ${transfer}; return before+2; };`,
			"/suspension-plan.js",
		),
	);
}

describe("native suspension storage", () => {
	it("composes expressions and rematerialized constants without assigning to resumed expressions", () => {
		const image = compile();
		const native = image.native.functions[1]!;
		const storage = native.storage!;
		expect(storage.expressionIps.length).toBeGreaterThan(0);
		expect(storage.rematerializedConstantIps.length).toBeGreaterThan(0);
		const base = lowerNativeSuspension(native)!;
		expect(storage.suspension!.slotCount).toBeLessThan(base.slotCount);
		const saved = new Set(storage.suspension!.points.flatMap((point) => point.registers));
		for (const point of storage.suspension!.points) {
			const op = native.body.instructions[point.instructionIp]!;
			if (op.opcode === "AWAIT" || op.opcode === "YIELD") {
				saved.add(op.valueDst);
				saved.add(op.modeDst);
			}
		}
		for (const ip of [...storage.expressionIps, ...storage.rematerializedConstantIps]) {
			const op = native.body.instructions[ip]!;
			if (!("dst" in op)) throw new Error("Missing scalar destination");
			expect(saved).not.toContain(op.dst);
		}
		for (const local of storage.definitionInitializedRegisters) {
			const definition = native.body.instructions.findIndex(
				(op) => "dst" in op && op.dst === local,
			);
			const afterResume = native.body.instructions.findIndex(
				(op, ip) =>
					ip > definition && ["GENERATOR_START", "YIELD", "AWAIT"].includes(op.opcode),
			);
			if (afterResume >= 0) expect(saved).not.toContain(local);
		}
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it("couples a retained constant producer with its required suspension spill", () => {
		const image = compile();
		const native = image.native.functions[1]!;
		const retained = {
			...native,
			storage: {
				...native.storage!,
				rematerializedConstantIps: [],
				suspension: lowerNativeSuspension(native),
			},
		};
		const withRetained = {
			...image,
			native: { ...image.native, functions: image.native.functions.with(1, retained) },
		};
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(withRetained))).toEqual(
			withRetained,
		);
		expect(() =>
			serializeCompilerArtifact({
				...withRetained,
				native: {
					...withRetained.native,
					functions: image.native.functions.with(1, {
						...retained,
						storage: { ...retained.storage, suspension: native.storage!.suspension },
					}),
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});

	it("keeps handler-bearing resumables outside scalar motion", () => {
		const native = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				"globalThis.f = async function f(gate) { try { const one=1; await gate; return one+2; } catch (error) { return error; } };",
				"/protected-resume.js",
			),
		).native.functions[1]!;
		expect(native.body.handlers.length).toBeGreaterThan(0);
		expect(native.storage!.expressionIps).toEqual([]);
		expect(native.storage!.rematerializedConstantIps).toEqual([]);
		expect(native.storage!.definitionInitializedRegisters).toEqual([]);
	});

	it("reuses snapshot slots for locals live at different suspension points", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.phases = async function phases(gate, left, right) {
					const first = +left; await gate; globalThis.first = first;
					const second = +right; await gate; return second;
				};`,
				"/suspension-phases.js",
			),
		);
		const plan = image.native.functions[1]!.storage!.suspension!;
		const largest = Math.max(...plan.points.map((point) => point.registers.length));
		const union = new Set(plan.points.flatMap((point) => point.registers));
		expect(union.size).toBeGreaterThan(largest);
		expect(plan.valueSlot).toBe(largest);
		expect(plan.slotCount).toBe(largest + 2);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it("does not spill stale heap bits from conservative pure handler-input copies", () => {
		const original = compile().native.functions[1]!;
		const plan = lowerNativeSuspension({
			...original,
			registerRepresentations: ["boxed", "boxed", "boxed", "boxed", "boxed"],
			body: {
				...original.body,
				registerCount: 5,
				instructions: [
					{ opcode: "AWAIT", valueDst: 3, modeDst: 4, awaitedSrc: 1 },
					{ opcode: "MOVE", dst: 2, src: 0 },
					{ opcode: "THROW", value: 0 },
					{ opcode: "RETURN", value: 2 },
				],
				handlers: [{ startIp: 1, endIp: 3, handlerIp: 3 }],
			},
			gc: {
				safepoints: [
					{
						kind: "operation",
						instructionIp: 0,
						rootRegisters: [0, 1, 3, 4],
						incomingRootRegisters: [0, 1],
						outgoingRootRegisters: [0, 3, 4],
					},
				],
			},
		});
		expect(plan!.points[0]!.registers).toEqual([0]);
	});

	it.each([
		["async function", "await gate"],
		["function*", "yield before"],
		["async function*", "yield before"],
	])("persists a compact per-resume contract for %s", (prefix, transfer) => {
		const image = compile(prefix, transfer);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const native = restored.native.functions[1]!;
		const plan = native.storage!.suspension!;
		expect(plan).toEqual(image.native.functions[1]!.storage!.suspension);
		expect(plan.slotCount).toBeLessThan(native.body.registerCount);
		expect(native.registerRepresentations).toContain("number");
		expect(plan.points.map((point) => point.instructionIp)).toEqual(
			native.body.instructions.flatMap((op, ip) =>
				["GENERATOR_START", "YIELD", "AWAIT"].includes(op.opcode) ? [ip] : [],
			),
		);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});

	it("spills scalar live values independently of traced roots and drops old resume outputs", () => {
		const native = compile().native.functions[1]!;
		const plan = native.storage!.suspension!;
		const point = plan.points[0]!;
		const op = native.body.instructions[point.instructionIp]!;
		if (op.opcode !== "AWAIT") throw new Error("Missing await");
		expect(
			point.registers.some((local) => native.registerRepresentations[local] === "number"),
		).toBe(true);
		expect(point.registers).not.toContain(op.valueDst);
		expect(point.registers).not.toContain(op.modeDst);
		for (const local of native.gc.safepoints.find(
			(site) => site.instructionIp === point.instructionIp,
		)!.outgoingRootRegisters)
			if (local !== op.valueDst && local !== op.modeDst)
				expect(point.registers).toContain(local);
	});

	it("rejects missing scalar spills, invalid mailboxes and forged resume sites", () => {
		const image = compile(),
			native = image.native.functions[1]!;
		const plan = native.storage!.suspension!;
		for (const forged of [
			{ ...plan, points: plan.points.map((point) => ({ ...point, registers: [] })) },
			{ ...plan, valueSlot: 0 },
			{ ...plan, modeSlot: plan.valueSlot },
			{ ...plan, slotCount: plan.slotCount + 1 },
			{
				...plan,
				points: plan.points.map((point) => ({
					...point,
					instructionIp: point.instructionIp + 1,
				})),
			},
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, suspension: forged },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});

	it("retains deliberate outgoing root obligations even without an executable read", () => {
		const original = compile().native.functions[1]!;
		const ip = original.storage!.suspension!.points[0]!.instructionIp;
		const dead = original.body.instructions.find((op) => op.opcode === "LOAD_CALLEE")!;
		if (dead.opcode !== "LOAD_CALLEE") throw new Error("Missing dead boxed local");
		const originalPoint = original.gc.safepoints.find(
			(site) => site.instructionIp === ip,
		)!;
		const add = (values: ReadonlyArray<number>) =>
			[...new Set([...values, dead.dst])].sort((a, b) => a - b);
		const native = lowerNativeFunctionStorage({
			...original,
			gc: {
				safepoints: original.gc.safepoints.map((point) =>
					point === originalPoint
						? {
								...point,
								rootRegisters: add(point.rootRegisters),
								outgoingRootRegisters: add(point.outgoingRootRegisters),
							}
						: point,
				),
			},
		});
		expect(original.storage!.suspension!.points[0]!.registers).not.toContain(dead.dst);
		expect(native.storage!.suspension!.points[0]!.registers).toContain(dead.dst);
	});
});
