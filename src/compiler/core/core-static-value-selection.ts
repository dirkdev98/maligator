import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import {
	knownBuiltinCallProves,
	compilerFactIsWorldInvariant,
} from "../shared/compiler-facts.ts";
import type { KnownBuiltinCall } from "../shared/compiler-facts.ts";
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
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";
import type { CoreProgram } from "./core-store.ts";

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
			let index = program.stringConstants.findIndex(
				(units) =>
					units.length === constant.codeUnits.length &&
					units.every((unit, index) => unit === constant.codeUnits[index]),
			);
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
				if (fn.instructionKind(instruction) !== "operation") continue;
				const opcode = fn.instructionOpcodeName(instruction);
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
	wakesOn: ["body", "memoryEffects", "facts"],
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
	admission: {
		predicate: "static or computed property read",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const opcode = fn.instructionOpcodeName(instruction);
				if (opcode === "loadPropertyStatic" || opcode === "loadProperty") return true;
			}
			return false;
		},
	},
	stage: "memory",
	requiredFunctionOpcodesAny: ["loadProperty", "loadPropertyStatic"],
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: ["body", "memoryEffects", "facts"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item, compilationContext } = context,
			fn = program.function(item.function);
		const analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const replacements: Array<{
			instruction: CoreInstructionId;
			opcode: string;
			inputs: ReadonlyArray<CoreValueId>;
			attributes?: Readonly<Record<string, CoreAttributeValue>>;
		}> = [];
		for (const instruction of fn.instructionIds()) {
			if (
				replacements.length >= context.remainingEdits ||
				fn.instructionKind(instruction) !== "operation"
			)
				continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode !== "loadProperty" && opcode !== "loadPropertyStatic") continue;
			const start = fn.kernel.instructionOperandStart(instruction),
				receiver = fn.kernel.operandAt(start);
			const keyConstant =
				opcode === "loadProperty"
					? analysis.constant(fn.kernel.operandAt(start + 1))
					: undefined;
			const key =
				opcode === "loadPropertyStatic"
					? analysis.string(fn.instructionAttributes(instruction).stringIndex as number)
					: keyConstant === undefined
						? undefined
						: keyConstant.kind === "undefined"
							? "undefined"
							: String(keyConstant.value);
			if (key === undefined) continue;
			const fact = analysis.queryAt(receiver, instruction);
			if (fact.kind === "unknown") continue;
			const description = program.staticDescriptions.description(fact.description);
			if (description.kind !== "array" && description.kind !== "object") continue;
			let member: StaticMember | undefined;
			if (description.kind === "array" && key === "length" && description.length !== null)
				member = {
					kind: "constant",
					description: program.staticDescriptions.intern(
						staticNumberDescription(description.length),
					),
				};
			else {
				const property = description.properties.find((property) => property.key === key);
				if (property !== undefined) {
					if (property.descriptor.kind !== "data") continue;
					member = property.descriptor.value;
				} else if (description.ownKeysComplete !== false) {
					const absent =
						fact.prototype.kind === "null" ||
						(fact.prototype.kind === "intrinsic" &&
							provePrimordialAccess(
								compilationContext.facts.world,
								{
									kind: "fresh-allocation",
									prototype: fact.prototype.id,
									realm: "current",
									ownKeys: [],
									ownKeysComplete: true,
									stableUntilRead: true,
								},
								key,
							)?.kind === "absent");
					if (absent)
						member = {
							kind: "constant",
							description: program.staticDescriptions.intern({ kind: "undefined" }),
						};
				}
			}
			if (member === undefined) continue;
			analysis.verify(fact, instruction);
			const operation = coreStaticMemberOperation(program, member, fact.operands);
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

export const foldStaticReflections: CoreFunctionPass = {
	name: "fold-static-reflections",
	admission: {
		predicate: "call or typeof observation",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const opcode = fn.instructionOpcodeName(instruction);
				if (
					opcode === "call" ||
					opcode === "callKnown" ||
					opcode === "typeofCompare" ||
					(opcode === "unary" &&
						fn.instructionAttributes(instruction).operator === "typeof")
				)
					return true;
			}
			return false;
		},
	},
	stage: "memory",
	requiredFunctionOpcodesAny: ["call", "callKnown", "unary", "typeofCompare"],
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: ["body", "memoryEffects", "facts"],
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
			if (opcode !== "call" && opcode !== "callKnown") continue;
			if (
				opcode === "callKnown" &&
				(fn.instructionAttributes(instruction).construct ||
					fn.instructionAttributes(instruction).argumentMode !== undefined)
			)
				continue;
			let canonical: string | undefined;
			const argument = opcode === "call" ? 2 : 1;
			if (fn.kernel.instructionOperandCount(instruction) <= argument) continue;
			if (opcode === "call") {
				const callee = analysis.query(fn.kernel.operandAt(start));
				if (callee.kind === "known") canonical = callee.canonical;
			} else {
				const known = fn.instructionAttributes(instruction)
					.knownBuiltinCall as unknown as KnownBuiltinCall | undefined;
				if (
					known !== undefined &&
					knownBuiltinCallProves(known, known.operation) &&
					compilerFactIsWorldInvariant(known.identity)
				)
					canonical = known.operation;
			}
			if (
				canonical === undefined ||
				![
					"Array.isArray",
					"Object.hasOwn",
					"Reflect.has",
					"Object.getOwnPropertyDescriptor",
					"Reflect.getOwnPropertyDescriptor",
				].includes(canonical)
			)
				continue;
			const fact = analysis.queryAt(fn.kernel.operandAt(start + argument), instruction);
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
			const input =
				fn.kernel.instructionOperandCount(instruction) > argument + 1
					? analysis.constant(fn.kernel.operandAt(start + argument + 1))
					: { kind: "undefined" as const };
			let key: PrimordialKey | undefined =
				input === undefined
					? undefined
					: input.kind === "undefined"
						? "undefined"
						: String(input.value);
			if (
				key === undefined &&
				fn.kernel.instructionOperandCount(instruction) > argument + 1
			) {
				const symbol = analysis.query(fn.kernel.operandAt(start + argument + 1));
				if (
					symbol.kind === "known" &&
					symbol.brand === "symbol" &&
					symbol.canonical !== undefined
				)
					key = { symbol: symbol.canonical };
			}
			if (key === undefined) continue;
			if (
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
				if (canonical === "Object.hasOwn" || canonical === "Reflect.has") {
					plans.push({
						instruction,
						operation: boolean(
							canonical === "Object.hasOwn"
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
						if (node === undefined || !primordialNodeAvailable(world, node[0]))
							return undefined;
						return {
							key,
							operation: {
								opcode: "loadPrimordial",
								inputs: [],
								attributes: {
									nodeIndex: value,
									worldAssumptions: {
										...builtinWorldAssumptions(node[0], "exact-builtin-proof", true),
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
			if (typeof key !== "string") continue;
			const description = program.staticDescriptions.description(fact.description);
			if (description.kind !== "array" && description.kind !== "object") continue;
			let property = description.properties.find((property) => property.key === key);
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
			if (property === undefined && description.ownKeysComplete === false) continue;
			if (canonical === "Object.hasOwn" || canonical === "Reflect.has") {
				let value = property !== undefined;
				if (!value && canonical === "Reflect.has") {
					const inherited = analysis.inherited(fact, key);
					if (inherited === undefined && fact.prototype.kind !== "null") continue;
					value = inherited?.kind === "descriptor";
				}
				plans.push({
					instruction,
					operation: { opcode: "createBoolean", inputs: [], attributes: { value } },
				});
				edits++;
				continue;
			}
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
