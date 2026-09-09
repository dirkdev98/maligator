import type { WorldFacts } from "../shared/compiler-facts.ts";
import { provePrimordialAccess } from "../shared/primordial-catalog.ts";
import type { CoreEditor } from "./core-editor.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export type PrimitiveWrapperObservation =
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "undefined" }
	| {
			readonly kind: "string-property";
			readonly receiver: CoreValueId;
			readonly property: string;
			readonly descriptor: boolean;
	  };

// The caller must prove the entire wrapper component has no writes or escapes.
export function primitiveWrapperObservation(
	fn: CoreFunctionStore,
	analysis: CoreStaticValueAnalysis,
	world: WorldFacts,
	wrapper: string,
	instruction: CoreInstructionId,
	receiver: CoreValueId,
	operand: number,
	operation: string,
	argumentOffset = 0,
): PrimitiveWrapperObservation | undefined {
	const start = fn.kernel.instructionOperandStart(instruction) + argumentOffset;
	if (operation === "instanceof") {
		if (operand !== 0) return undefined;
		const right = analysis.query(fn.kernel.operandAt(start + 1));
		if (
			right.kind !== "known" ||
			right.canonical === undefined ||
			!["Object", "Boolean", "Number", "String", "BigInt", "Symbol"].includes(
				right.canonical,
			)
		)
			return undefined;
		const target = {
			kind: "intrinsic" as const,
			id: right.canonical,
			realm: "current" as const,
		};
		if (
			provePrimordialAccess(world, target, { symbol: "%Symbol.hasInstance%" })?.resolution
				?.value?.[0] !== "Function.prototype[%Symbol.hasInstance%]" ||
			provePrimordialAccess(world, target, "prototype")?.resolution?.value?.[0] !==
				`${right.canonical}.prototype`
		)
			return undefined;
		return {
			kind: "boolean",
			value: right.canonical === "Object" || right.canonical === wrapper,
		};
	}
	const inherited = operation === "in" || operation === "Reflect.has";
	const prototypeMethod =
		operation === "Object.prototype.hasOwnProperty" ||
		operation === "Object.prototype.propertyIsEnumerable";
	const descriptor =
		operation === "Object.getOwnPropertyDescriptor" ||
		operation === "Reflect.getOwnPropertyDescriptor";
	if (!inherited && !prototypeMethod && !descriptor && operation !== "Object.hasOwn")
		return undefined;
	if (operand !== (prototypeMethod ? 0 : 1)) return undefined;
	const keyIndex = operation === "in" ? 0 : prototypeMethod ? 1 : 2;
	const constant =
		keyIndex < fn.kernel.instructionOperandCount(instruction) - argumentOffset
			? analysis.constant(fn.kernel.operandAt(start + keyIndex))
			: { kind: "undefined" as const };
	if (constant === undefined) return undefined;
	const property = constant.kind === "undefined" ? "undefined" : String(constant.value);
	const length = wrapper === "String" && property === "length";
	const index = Number(property);
	const indexed =
		wrapper === "String" &&
		Number.isSafeInteger(index) &&
		index >= 0 &&
		String(index) === property;
	if (inherited && !length) {
		const proof = provePrimordialAccess(
			world,
			{ kind: "intrinsic", id: `${wrapper}.prototype`, realm: "current" },
			property,
		);
		if (proof === undefined) return undefined;
		if (proof.kind === "descriptor") return { kind: "boolean", value: true };
	}
	if (!length && !indexed)
		return descriptor ? { kind: "undefined" } : { kind: "boolean", value: false };
	if (length && !descriptor)
		return {
			kind: "boolean",
			value: operation !== "Object.prototype.propertyIsEnumerable",
		};
	if (indexed && descriptor) {
		const block = fn.instructionBlock(instruction);
		if (
			fn.instructionKind(fn.blockTerminator(block)) === "guard" ||
			fn.kernel.blockHandlerBlock(block) !== undefined
		)
			return undefined;
	}
	return { kind: "string-property", receiver, property, descriptor };
}

export function lowerPrimitiveWrapperObservation(
	editor: CoreEditor,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	plan: PrimitiveWrapperObservation,
): void {
	if (plan.kind === "boolean") {
		editor.replaceInstruction(instruction, "createBoolean", [], {
			attributes: { value: plan.value },
		});
		return;
	}
	if (plan.kind === "undefined") {
		editor.replaceInstruction(instruction, "createUndefined", []);
		return;
	}
	const names = [
		"length",
		plan.property,
		"value",
		"writable",
		"enumerable",
		"configurable",
	];
	const strings = editor.appendStringConstants(
		names.map((name) =>
			Array.from({ length: name.length }, (_, index) => name.charCodeAt(index)),
		),
	);
	const block = fn.instructionBlock(instruction);
	const insert = (
		opcode: string,
		inputs: ReadonlyArray<CoreValueId>,
		attributes?: Record<string, string | number | boolean>,
	) =>
		editor.insertInstruction(block, instruction, opcode, inputs, { attributes })
			.outputs[0]!;
	const length = insert("loadPropertyStatic", [plan.receiver], { stringIndex: strings });
	let present: CoreValueId | undefined;
	if (plan.property !== "length") {
		const index = Number(plan.property);
		const position = insert(index <= 0x7fffffff ? "createNumber" : "createF64", [], {
			value: index,
		});
		present = insert("binary", [position, length], { operator: "<" });
	}
	if (!plan.descriptor) {
		editor.replaceInstruction(instruction, "move", [present!]);
		return;
	}
	const makeDescriptor = (before: CoreInstructionId) => {
		const target = fn.instructionBlock(before);
		const value =
			plan.property === "length"
				? length
				: editor.insertInstruction(
						target,
						before,
						"loadPropertyStatic",
						[plan.receiver],
						{
							attributes: { stringIndex: strings + 1 },
						},
					).outputs[0]!;
		const no = editor.insertInstruction(target, before, "createBoolean", [], {
			attributes: { value: false },
		}).outputs[0]!;
		const enumerable =
			plan.property === "length"
				? no
				: editor.insertInstruction(target, before, "createBoolean", [], {
						attributes: { value: true },
					}).outputs[0]!;
		editor.replaceInstruction(before, "createObjectShaped", [value, no, enumerable, no], {
			attributes: {
				keyStringIndices: [strings + 2, strings + 3, strings + 4, strings + 5],
			},
		});
	};
	if (present === undefined) {
		makeDescriptor(instruction);
		return;
	}
	const terminator = fn.blockTerminator(block);
	const tail: Array<CoreInstructionId> = [];
	for (
		let next = fn.instructionNext(instruction);
		next !== undefined && next !== terminator;
		next = fn.instructionNext(next)
	)
		tail.push(next);
	const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
	const join = editor.createBlock([{ representation: fn.valueRepresentation(output) }]);
	const joined = fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(join));
	for (const next of tail) editor.moveInstruction(next, join);
	editor.replaceValueUses(output, joined);
	editor.setTerminator(join, coreTerminatorInput(fn, terminator));
	const hit = editor.createBlock(),
		absent = editor.createBlock();
	editor.moveInstruction(instruction, hit);
	makeDescriptor(instruction);
	const missing = editor.appendInstruction(absent, "createUndefined", []).outputs[0]!;
	editor.setTerminator(hit, { kind: "jump", edge: { block: join, arguments: [output] } });
	editor.setTerminator(absent, {
		kind: "jump",
		edge: { block: join, arguments: [missing] },
	});
	editor.replaceTerminator(block, {
		kind: "branch",
		condition: present,
		consequent: { block: hit, arguments: [] },
		alternate: { block: absent, arguments: [] },
	});
}
