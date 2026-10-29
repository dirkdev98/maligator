import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import { compilerFactIsWorldInvariant } from "../shared/compiler-facts.ts";
import type { KnownBuiltinCall } from "../shared/compiler-facts.ts";
import { knownOperationCallProves } from "../shared/known-operations.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import type { PrimordialValue } from "../shared/primordial-catalog-types.ts";
import {
	primordialConstantDescription,
	primordialNodeAvailable,
	provePrimordialAccess,
} from "../shared/primordial-catalog.ts";
import type { PrimordialKey } from "../shared/primordial-catalog.ts";
import { staticNumberDescription } from "../shared/static-values.ts";
import type { StaticDescriptionId, StaticMember } from "../shared/static-values.ts";
import { CoreEditor } from "./core-editor.ts";
import { CORE_STATIC_SELECTION_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import type { CoreAttributeValue, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import {
	CORE_STATIC_VALUE_ANALYSIS,
	CORE_STATIC_VALUE_FUNCTION_DEPENDENCIES,
	CORE_STATIC_VALUE_PROGRAM_DEPENDENCIES,
} from "./core-static-values.ts";
import type { CoreProgram } from "./core-store.ts";

const STATIC_VALUE_WAKES = [
	...CORE_STATIC_VALUE_FUNCTION_DEPENDENCIES,
	...CORE_STATIC_VALUE_PROGRAM_DEPENDENCIES,
];

export interface CoreStaticMemberOperation {
	readonly opcode: string;
	readonly inputs: ReadonlyArray<CoreValueId>;
	readonly attributes?: Readonly<Record<string, CoreAttributeValue>>;
}

type StaticDescriptorMember = { readonly key: string } & (
	| { readonly operation: CoreStaticMemberOperation }
	| { readonly text: string }
);

export function coreStaticMemberOperation(
	program: CoreProgram,
	member: StaticMember,
	operands: ReadonlyArray<CoreValueId>,
): CoreStaticMemberOperation | undefined {
	if (member.kind === "operand")
		return { opcode: "move", inputs: [operands[member.index]!] };
	if (member.kind !== "constant") return undefined;
	return coreStaticConstantOperation(program, member.description);
}

export function coreStaticConstantOperation(
	program: CoreProgram,
	id: StaticDescriptionId,
	editor?: CoreEditor,
): CoreStaticMemberOperation | undefined {
	const constant = program.staticDescriptions.description(id);
	switch (constant.kind) {
		case "undefined":
		case "null":
			return {
				opcode: constant.kind === "null" ? "createNull" : "createUndefined",
				inputs: [],
			};
		case "boolean":
			return {
				opcode: "createBoolean",
				inputs: [],
				attributes: { value: constant.value },
			};
		case "number": {
			const bits = new DataView(new ArrayBuffer(8));
			bits.setUint32(0, constant.low, true);
			bits.setUint32(4, constant.high, true);
			const value = bits.getFloat64(0, true);
			return {
				opcode:
					Number.isInteger(value) &&
					value >= -0x80000000 &&
					value <= 0x7fffffff &&
					!Object.is(value, -0)
						? "createNumber"
						: "createF64",
				inputs: [],
				attributes: { value },
			};
		}
		case "string": {
			let index = program.stringConstantSlot(constant.codeUnits, "first") ?? -1;
			if (index < 0 && editor !== undefined)
				index = editor.appendStringConstants([constant.codeUnits]);
			return index < 0
				? undefined
				: { opcode: "createString", inputs: [], attributes: { stringIndex: index } };
		}
		case "bigint": {
			let index = program.bigintConstants.findIndex(
				(value) => String(value) === constant.decimal,
			);
			if (index < 0 && editor !== undefined)
				index = editor.appendBigintConstants([BigInt(constant.decimal)]);
			return index < 0
				? undefined
				: { opcode: "createBigint", inputs: [], attributes: { bigintIndex: index } };
		}
		default:
			return undefined;
	}
}

export const selectStaticPropertyReads: CoreFunctionPass = {
	name: "select-static-property-reads",
	admission: {
		predicate: "dynamic property read without an existing static-selection fallback",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			for (const instruction of fn.instructionIds()) {
				const header = fn.instructionHeader(instruction);
				if (typeof header === "string") continue;
				const opcode = header.opcode;
				if (
					opcode === "loadProperty" &&
					!fn.instructionAttributes(instruction)[CORE_STATIC_SELECTION_FALLBACK_ATTRIBUTE]
				)
					return true;
			}
			return false;
		},
	},
	stage: "memory",
	requiredFunctionOpcodesAny: ["loadProperty"],
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: STATIC_VALUE_WAKES,
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context,
			fn = program.function(item.function);
		const analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "loadProperty" ||
				fn.instructionAttributes(instruction)[CORE_STATIC_SELECTION_FALLBACK_ATTRIBUTE]
			)
				continue;
			const block = fn.instructionBlock(instruction),
				terminator = fn.blockTerminator(block);
			if (
				fn.instructionKind(terminator) === "guard" ||
				fn.kernel.blockHandlerBlock(block) !== undefined
			)
				continue;
			const start = fn.kernel.instructionOperandStart(instruction),
				receiver = fn.kernel.operandAt(start),
				key = fn.kernel.operandAt(start + 1);
			if (analysis.constant(key) !== undefined) continue;
			const keyFact = analysis.query(key);
			if (keyFact.kind === "known" && keyFact.brand === "symbol") continue;
			const fact = analysis.queryAt(receiver, instruction);
			// ToPropertyKey can invoke arbitrary code before the read; it cannot reach a private fresh
			// receiver.
			if (fact.kind !== "known" || !fact.privateUntilObservation) continue;
			const description = program.staticDescriptions.description(fact.description);
			if (description.kind !== "array" && description.kind !== "object") continue;
			const cases = description.properties.flatMap((property) => {
				if (typeof property.key !== "string" || property.descriptor.kind !== "data")
					return [];
				const operation = coreStaticMemberOperation(
					program,
					property.descriptor.value,
					fact.operands,
				);
				return operation === undefined ? [] : [{ key: property.key, operation }];
			});
			if (
				cases.length === 0 ||
				cases.length > 16 ||
				cases.length * 7 + 12 > context.remainingEdits
			)
				continue;
			analysis.verify(fact, instruction);
			const tail: Array<CoreInstructionId> = [];
			for (
				let next = fn.instructionNext(instruction);
				next !== undefined && next !== terminator;
				next = fn.instructionNext(next)
			)
				tail.push(next);
			const editor = CoreEditor.open(program, fn.id);
			const stringStart = editor.appendStringConstants(
				cases.map((item) =>
					Array.from({ length: item.key.length }, (_, index) =>
						item.key.charCodeAt(index),
					),
				),
			);
			const join = editor.createBlock([
				{
					representation: fn.valueRepresentation(
						fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
					),
				},
			]);
			const joined = fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(join));
			const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			for (const next of tail) editor.moveInstruction(next, join);
			editor.replaceValueUses(output, joined);
			editor.setTerminator(join, coreTerminatorInput(fn, terminator));
			const fallback = editor.createBlock();
			editor.moveInstruction(instruction, fallback);
			const propertyKey = editor.appendInstruction(block, "toPropertyKey", [
				receiver,
				key,
			]).outputs[0]!;
			editor.replaceInstruction(instruction, "loadProperty", [receiver, propertyKey], {
				attributes: {
					...fn.instructionAttributes(instruction),
					[CORE_STATIC_SELECTION_FALLBACK_ATTRIBUTE]: true,
				},
			});
			editor.setTerminator(fallback, {
				kind: "jump",
				edge: { block: join, arguments: [output] },
			});
			let check = block;
			for (let index = 0; index < cases.length; index++) {
				const candidate = cases[index]!,
					hit = editor.createBlock(),
					next = index === cases.length - 1 ? fallback : editor.createBlock();
				const expected = editor.appendInstruction(check, "createString", [], {
					attributes: { stringIndex: stringStart + index },
				}).outputs[0]!;
				const match = editor.appendInstruction(check, "binary", [propertyKey, expected], {
					attributes: { operator: "===" },
				}).outputs[0]!;
				const branch = {
					kind: "branch" as const,
					condition: match,
					consequent: { block: hit, arguments: [] },
					alternate: { block: next, arguments: [] },
				};
				if (check === block) editor.replaceTerminator(check, branch);
				else editor.setTerminator(check, branch);
				const value = editor.appendInstruction(
					hit,
					candidate.operation.opcode,
					candidate.operation.inputs,
					{ attributes: candidate.operation.attributes },
				).outputs[0]!;
				editor.setTerminator(hit, {
					kind: "jump",
					edge: { block: join, arguments: [value] },
				});
				check = next;
			}
			return editor.commit();
		}
		return undefined;
	},
};

export const foldStaticPropertyReads: CoreFunctionPass = {
	name: "fold-static-property-reads",
	stage: "memory",
	requiredFunctionOpcodesAny: ["loadProperty", "loadPropertyStatic"],
	candidates: {
		dependencies: ["body"],
		opcodes: ["loadProperty", "loadPropertyStatic"],
	},
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: STATIC_VALUE_WAKES,
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context,
			fn = program.function(item.function);
		const loadPropertyOpcode = program.registry.get("loadProperty")?.id;
		const loadPropertyStaticOpcode = program.registry.get("loadPropertyStatic")?.id;
		const analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const replacements: Array<{
			instruction: CoreInstructionId;
			opcode: string;
			inputs: ReadonlyArray<CoreValueId>;
			attributes?: Readonly<Record<string, CoreAttributeValue>>;
		}> = [];
		for (const instruction of context.instructions()) {
			if (replacements.length >= context.remainingEdits) continue;
			const opcode = fn.kernel.instructionOpcode(instruction);
			if (opcode !== loadPropertyOpcode && opcode !== loadPropertyStaticOpcode) continue;
			const start = fn.kernel.instructionOperandStart(instruction),
				receiver = fn.kernel.operandAt(start);
			const key =
				opcode === loadPropertyStaticOpcode
					? analysis.string(fn.instructionAttributes(instruction).stringIndex as number)
					: analysis.propertyKey(fn.kernel.operandAt(start + 1), instruction);
			if (key === undefined) continue;
			const property = analysis.queryPropertyAt(receiver, key, instruction);
			if (property === undefined) continue;
			analysis.verifyProperty(property, instruction);
			const operation = coreStaticMemberOperation(
				program,
				property.member,
				property.operands,
			);
			if (operation !== undefined) replacements.push({ instruction, ...operation });
		}
		if (replacements.length === 0) return undefined;
		const editor = CoreEditor.open(program, fn.id);
		for (const replacement of replacements)
			editor.replaceInstruction(
				replacement.instruction,
				replacement.opcode,
				replacement.inputs,
				{ attributes: replacement.attributes },
			);
		return editor.commit();
	},
};

// A binding proven to hold one immutable primitive feeds it to the operations that
// read it, so arithmetic and comparisons see a literal. The load and its TDZ check
// stay: the proof only covers reads the check has already admitted.
export const foldStaticBindingConstants: CoreFunctionPass = {
	name: "fold-static-binding-constants",
	stage: "memory",
	requiredFunctionOpcodesAny: ["loadGlobal", "loadCaptured"],
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: STATIC_VALUE_WAKES,
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context,
			fn = program.function(item.function);
		const loadGlobal = program.registry.get("loadGlobal")?.id;
		const loadCaptured = program.registry.get("loadCaptured")?.id;
		const throwIfTdz = program.registry.get("throwIfTdz")?.id;
		const analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const rewrites: Array<{
			readonly consumer: CoreInstructionId;
			readonly index: number;
			readonly opcode: string;
			readonly attributes: Readonly<Record<string, CoreAttributeValue>>;
		}> = [];
		for (const consumer of fn.instructionIds()) {
			if (rewrites.length >= context.remainingEdits) break;
			if (fn.instructionKind(consumer) !== "operation") continue;
			if (fn.kernel.instructionOpcode(consumer) === throwIfTdz) continue;
			const start = fn.kernel.instructionOperandStart(consumer);
			const count = fn.kernel.instructionOperandCount(consumer);
			for (let index = 0; index < count; index++) {
				const value = fn.kernel.operandAt(start + index);
				if (fn.kernel.valueDefinitionKind(value) !== 1) continue;
				const definition = fn.kernel.instructionOpcode(
					fn.kernel.valueDefinitionOwner(value) as CoreInstructionId,
				);
				if (definition !== loadGlobal && definition !== loadCaptured) continue;
				const constant = analysis.constant(value, consumer);
				const literal =
					constant === undefined
						? undefined
						: constant.kind === "number"
							? Number.isFinite(constant.value) && !Object.is(constant.value, -0)
								? {
										// `createNumber` carries int32 values; literal lowering uses f64 otherwise.
										opcode:
											Number.isInteger(constant.value) &&
											constant.value >= -2147483648 &&
											constant.value <= 2147483647
												? "createNumber"
												: "createF64",
										attributes: { value: constant.value },
									}
								: undefined
							: constant.kind === "boolean"
								? { opcode: "createBoolean", attributes: { value: constant.value } }
								: constant.kind === "undefined"
									? { opcode: "createUndefined", attributes: {} }
									: constant.kind === "null"
										? { opcode: "createNull", attributes: {} }
										: undefined;
				if (literal !== undefined) rewrites.push({ consumer, index, ...literal });
			}
		}
		if (rewrites.length === 0) return undefined;
		const editor = CoreEditor.open(program, fn.id);
		for (const { consumer, index, opcode, attributes } of rewrites) {
			const literal = editor.insertInstruction(
				fn.instructionBlock(consumer),
				consumer,
				opcode,
				[],
				{ attributes, sourcePosition: fn.instructionSourcePosition(consumer) },
			).outputs[0]!;
			const start = fn.kernel.instructionOperandStart(consumer);
			const inputs = Array.from(
				{ length: fn.kernel.instructionOperandCount(consumer) },
				(_, at) => (at === index ? literal : fn.kernel.operandAt(start + at)),
			);
			editor.replaceOperands(consumer, inputs);
		}
		return editor.commit();
	},
};

export const foldStaticReflections: CoreFunctionPass = {
	name: "fold-static-reflections",
	admission: {
		predicate: "call, typeof, membership or delete observation",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			for (const instruction of fn.instructionIds()) {
				const header = fn.instructionHeader(instruction);
				if (typeof header === "string") continue;
				const opcode = header.opcode;
				if (
					opcode === "call" ||
					opcode === "callKnown" ||
					opcode === "deleteProperty" ||
					opcode === "typeofCompare" ||
					(opcode === "binary" &&
						fn.instructionAttributes(instruction).operator === "in") ||
					(opcode === "unary" &&
						fn.instructionAttributes(instruction).operator === "typeof")
				)
					return true;
			}
			return false;
		},
	},
	stage: "memory",
	requiredFunctionOpcodesAny: [
		"call",
		"callKnown",
		"unary",
		"typeofCompare",
		"binary",
		"deleteProperty",
	],
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: STATIC_VALUE_WAKES,
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context,
			fn = program.function(item.function),
			analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const plans: Array<{
			instruction: CoreInstructionId;
			operation?: CoreStaticMemberOperation;
			text?: string;
			descriptor?: ReadonlyArray<StaticDescriptorMember>;
		}> = [];
		let edits = 0;
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				edits + 8 > context.remainingEdits
			)
				continue;
			const opcode = fn.instructionOpcodeName(instruction),
				start = fn.kernel.instructionOperandStart(instruction);
			if (
				(opcode === "unary" &&
					fn.instructionAttributes(instruction).operator === "typeof") ||
				opcode === "typeofCompare"
			) {
				const fact = analysis.query(fn.kernel.operandAt(start));
				if (fact.kind !== "known") continue;
				const text = ["array", "null"].includes(fact.brand) ? "object" : fact.brand;
				if (opcode === "typeofCompare") {
					const attributes = fn.instructionAttributes(instruction);
					plans.push({
						instruction,
						operation: {
							opcode: "createBoolean",
							inputs: [],
							attributes: {
								value: (text === attributes.expected) !== (attributes.negated === true),
							},
						},
					});
				} else plans.push({ instruction, text });
				edits += 2;
				continue;
			}
			const membership =
				opcode === "binary" && fn.instructionAttributes(instruction).operator === "in";
			const deletion = opcode === "deleteProperty";
			if (opcode !== "call" && opcode !== "callKnown" && !membership && !deletion)
				continue;
			if (
				opcode === "callKnown" &&
				(fn.instructionAttributes(instruction).construct ||
					fn.instructionAttributes(instruction).argumentMode !== undefined)
			)
				continue;
			let canonical: string | undefined = membership
				? "Reflect.has"
				: deletion
					? "Reflect.deleteProperty"
					: undefined;
			const argument = opcode === "call" ? 2 : deletion ? 0 : 1;
			if (fn.kernel.instructionOperandCount(instruction) <= argument) continue;
			if (opcode === "call") {
				const callee = analysis.query(fn.kernel.operandAt(start));
				if (callee.kind === "known") canonical = callee.canonical;
			} else if (opcode === "callKnown") {
				const operation = fn.instructionAttributes(instruction).operation;
				if (typeof operation === "string") canonical = operation;
			}
			if (
				canonical === undefined ||
				![
					"Array.isArray",
					"Object.hasOwn",
					"Object.prototype.hasOwnProperty",
					"Object.prototype.propertyIsEnumerable",
					"Reflect.has",
					"Reflect.deleteProperty",
					"Object.getOwnPropertyDescriptor",
					"Reflect.getOwnPropertyDescriptor",
				].includes(canonical)
			)
				continue;
			if (opcode === "callKnown") {
				const known = fn.instructionAttributes(instruction)
					.knownBuiltinCall as unknown as KnownBuiltinCall | undefined;
				if (
					!knownOperationCallProves(known, canonical) ||
					!compilerFactIsWorldInvariant(known?.identity)
				)
					continue;
			}
			const enumerable = canonical === "Object.prototype.propertyIsEnumerable";
			const ownPresence =
				canonical === "Object.hasOwn" || canonical === "Object.prototype.hasOwnProperty";
			const receiverArgument =
				canonical === "Object.prototype.hasOwnProperty" || enumerable
					? opcode === "call"
						? 1
						: 0
					: argument;
			const receiver = fn.kernel.operandAt(start + receiverArgument);
			const initial =
				canonical === "Array.isArray" ? analysis.query(receiver) : undefined;
			const fact =
				initial?.kind === "known" ? initial : analysis.queryAt(receiver, instruction);
			if (fact.kind !== "known") continue;
			if (canonical === "Array.isArray") {
				plans.push({
					instruction,
					operation: {
						opcode: "createBoolean",
						inputs: [],
						attributes: { value: fact.brand === "array" },
					},
				});
				edits++;
				continue;
			}
			const keyInput = membership
				? fn.kernel.operandAt(start)
				: fn.kernel.instructionOperandCount(instruction) > receiverArgument + 1
					? fn.kernel.operandAt(start + receiverArgument + 1)
					: undefined;
			const propertyKey =
				keyInput === undefined
					? "undefined"
					: analysis.propertyKey(keyInput, instruction);
			if (propertyKey === undefined) continue;
			if (canonical === "Reflect.deleteProperty") {
				if (analysis.ownProperty(fact, propertyKey, instruction) !== "absent") continue;
				analysis.verify(fact, instruction);
				plans.push({
					instruction,
					operation: { opcode: "createBoolean", inputs: [], attributes: { value: true } },
				});
				edits++;
				continue;
			}
			let key: PrimordialKey | undefined =
				typeof propertyKey === "string" ? propertyKey : undefined;
			if (typeof propertyKey !== "string") {
				const symbol = analysis.queryAt(propertyKey, instruction);
				if (
					symbol.kind === "known" &&
					symbol.brand === "symbol" &&
					symbol.canonical !== undefined
				)
					key = { symbol: symbol.canonical };
			}
			if (
				key !== undefined &&
				fact.canonical !== undefined &&
				["object", "array", "function"].includes(fact.brand)
			) {
				const world = context.compilationContext.facts.world;
				const proof = provePrimordialAccess(
					world,
					{ kind: "intrinsic", id: fact.canonical, realm: "current" },
					key,
				);
				if (proof === undefined) continue;
				const resolution =
					proof.resolution?.owner[0] === fact.canonical ? proof.resolution : undefined;
				const boolean = (value: boolean): CoreStaticMemberOperation => ({
					opcode: "createBoolean",
					inputs: [],
					attributes: { value },
				});
				if (ownPresence || enumerable || canonical === "Reflect.has") {
					plans.push({
						instruction,
						operation: boolean(
							enumerable
								? resolution !== undefined && (resolution.descriptor[1] & 2) !== 0
								: ownPresence
									? resolution !== undefined
									: proof.kind === "descriptor",
						),
					});
					edits++;
					continue;
				}
				if (resolution === undefined) {
					plans.push({
						instruction,
						operation: { opcode: "createUndefined", inputs: [] },
					});
					edits++;
					continue;
				}
				const member = (
					key: string,
					value: PrimordialValue | null,
				): StaticDescriptorMember | undefined => {
					if (typeof value === "number") {
						if (value < 0)
							return { key, operation: { opcode: "createUndefined", inputs: [] } };
						const node = getPrimordialCatalog().nodes[value];
						if (
							node === undefined ||
							(node[2] & 9) === 0 ||
							!primordialNodeAvailable(world, node[0])
						)
							return undefined;
						return {
							key,
							operation: {
								opcode: "loadPrimordial",
								inputs: [],
								attributes: {
									nodeIndex: value,
									worldAssumptions: {
										...builtinWorldAssumptions(node[0], "exact-builtin-proof"),
									},
								},
							},
						};
					}
					if (value?.[0] === "string") return { key, text: value[1] };
					const constant = primordialConstantDescription(value);
					if (constant === undefined) return undefined;
					const operation = coreStaticConstantOperation(
						program,
						program.staticDescriptions.intern(constant),
					);
					return operation === undefined ? undefined : { key, operation };
				};
				const [, flags, value, get, set] = resolution.descriptor;
				// Catalog descriptor bits follow MalPropertyFlags, including accessor/data distinction.
				const members =
					(flags & 8) !== 0
						? [member("get", get), member("set", set)]
						: [
								member("value", value),
								{ key: "writable", operation: boolean((flags & 1) !== 0) },
							];
				if (!members.every((item): item is StaticDescriptorMember => item !== undefined))
					continue;
				analysis.verify(fact, instruction);
				plans.push({
					instruction,
					descriptor: [
						...members,
						{ key: "enumerable", operation: boolean((flags & 2) !== 0) },
						{ key: "configurable", operation: boolean((flags & 4) !== 0) },
					],
				});
				edits += 6;
				continue;
			}
			const description = program.staticDescriptions.description(fact.description);
			if (description.kind !== "array" && description.kind !== "object") continue;
			const own = analysis.ownProperty(fact, propertyKey, instruction);
			let property = own === "absent" ? undefined : own;
			if (ownPresence || enumerable || canonical === "Reflect.has") {
				// An Array keeps its nonconfigurable own length when its contents are unknown.
				const arrayLength = description.kind === "array" && key === "length";
				if (property === undefined && !arrayLength && own !== "absent") continue;
				let value = enumerable
					? property?.enumerable === true
					: property !== undefined || arrayLength;
				if (!value && canonical === "Reflect.has") {
					const inherited = key === undefined ? undefined : analysis.inherited(fact, key);
					if (inherited === undefined && fact.prototype.kind !== "null") continue;
					value = inherited?.kind === "descriptor";
				}
				analysis.verify(fact, instruction);
				plans.push({
					instruction,
					operation: { opcode: "createBoolean", inputs: [], attributes: { value } },
				});
				edits++;
				continue;
			}
			if (description.kind === "array" && key === "length") {
				if (description.length === null) continue;
				property = {
					key,
					enumerable: false,
					configurable: false,
					descriptor: {
						kind: "data",
						writable: true,
						value: {
							kind: "constant",
							description: program.staticDescriptions.intern(
								staticNumberDescription(description.length),
							),
						},
					},
				};
			}
			if (property === undefined && own !== "absent") continue;
			if (property === undefined) {
				plans.push({ instruction, operation: { opcode: "createUndefined", inputs: [] } });
				edits++;
				continue;
			}
			const boolean = (value: boolean): CoreStaticMemberOperation => ({
				opcode: "createBoolean",
				inputs: [],
				attributes: { value },
			});
			const members =
				property.descriptor.kind === "data"
					? [
							{
								key: "value",
								operation: coreStaticMemberOperation(
									program,
									property.descriptor.value,
									fact.operands,
								),
							},
							{ key: "writable", operation: boolean(property.descriptor.writable) },
						]
					: [
							{
								key: "get",
								operation: coreStaticMemberOperation(
									program,
									property.descriptor.get,
									fact.operands,
								),
							},
							{
								key: "set",
								operation: coreStaticMemberOperation(
									program,
									property.descriptor.set,
									fact.operands,
								),
							},
						];
			if (
				!members.every(
					(member): member is { key: string; operation: CoreStaticMemberOperation } =>
						member.operation !== undefined,
				)
			)
				continue;
			analysis.verify(fact, instruction);
			plans.push({
				instruction,
				descriptor: [
					...members,
					{ key: "enumerable", operation: boolean(property.enumerable) },
					{ key: "configurable", operation: boolean(property.configurable) },
				],
			});
			edits += 6;
		}
		if (plans.length === 0) return undefined;
		const strings = [
			...new Set(
				plans.flatMap((plan) =>
					plan.text === undefined
						? (plan.descriptor?.flatMap((member) =>
								"text" in member ? [member.key, member.text] : [member.key],
							) ?? [])
						: [plan.text],
				),
			),
		];
		const editor = CoreEditor.open(program, fn.id);
		const base = editor.appendStringConstants(
			strings.map((text) =>
				Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)),
			),
		);
		const index = (text: string) => base + strings.indexOf(text);
		for (const plan of plans) {
			if (plan.text !== undefined)
				editor.replaceInstruction(plan.instruction, "createString", [], {
					attributes: { stringIndex: index(plan.text) },
				});
			else if (plan.operation !== undefined)
				editor.replaceInstruction(
					plan.instruction,
					plan.operation.opcode,
					plan.operation.inputs,
					{ attributes: plan.operation.attributes },
				);
			else if (plan.descriptor !== undefined) {
				const values = plan.descriptor.map((member) => {
					const operation =
						"operation" in member
							? member.operation
							: {
									opcode: "createString",
									inputs: [],
									attributes: { stringIndex: index(member.text) },
								};
					return editor.insertInstruction(
						fn.instructionBlock(plan.instruction),
						plan.instruction,
						operation.opcode,
						operation.inputs,
						{ attributes: operation.attributes },
					).outputs[0]!;
				});
				editor.replaceInstruction(plan.instruction, "createObjectShaped", values, {
					attributes: {
						keyStringIndices: plan.descriptor.map((member) => index(member.key)),
					},
				});
			}
		}
		return editor.commit();
	},
};
