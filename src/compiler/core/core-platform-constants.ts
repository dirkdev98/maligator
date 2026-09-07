import type { PlatformData } from "../../platform/catalog.ts";
import type { ConstructedCoreCompilation } from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type {
	CoreEdge,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface KnownValue {
	readonly value: PlatformData | undefined;
	readonly platform: boolean;
}

interface StoredValue {
	readonly function: CoreFunctionId;
	readonly value: CoreValueId;
}

function operand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId {
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function edge(fn: CoreFunctionStore, row: number): CoreEdge {
	const start = fn.kernel.terminatorEdgeArgumentStart(row);
	return {
		block: fn.kernel.terminatorEdgeBlock(row),
		arguments: Array.from(
			{ length: fn.kernel.terminatorEdgeArgumentCount(row) },
			(_, index) => fn.kernel.operandAt(start + index),
		),
	};
}

class PlatformValues {
	readonly roots = new Map<string, KnownValue>();
	readonly stores = new Map<string, StoredValue | null>();
	readonly values = new Map<string, KnownValue | null>();
	readonly visiting = new Set<string>();
	readonly strings: ReadonlyArray<string>;
	readonly #program: CoreProgram;

	constructor(compilation: ConstructedCoreCompilation) {
		this.#program = compilation.program;
		this.strings = compilation.program.stringConstants.map((units) =>
			String.fromCharCode(...units),
		);
		const data = compilation.context.data;
		for (const install of data.hostInstallCandidates) {
			for (const entry of install.exports) {
				if (entry.constant !== undefined)
					this.roots.set(`global:${entry.slot}`, {
						value: entry.constant,
						platform: true,
					});
			}
		}
		if (this.roots.size === 0) return;
		const closed = new Set([
			...data.singleAssignmentGlobalSlots.map((slot) => `global:${slot}`),
			...data.singleAssignmentCapturedSlots.map(
				(slot) => `captured:${slot.owner}:${slot.index}`,
			),
		]);
		for (const functionId of this.#program.functionIds()) {
			const fn = this.#program.function(functionId);
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const opcode = fn.instructionOpcodeName(instruction);
				if (opcode !== "storeGlobal" && opcode !== "storeCaptured") continue;
				const attributes = fn.instructionAttributes(instruction);
				const key =
					opcode === "storeGlobal"
						? `global:${attributes.index}`
						: `captured:${attributes.functionIndex}:${attributes.index}`;
				if (!closed.has(key)) continue;
				const value = operand(fn, instruction, 0);
				if (
					fn.kernel.valueDefinitionKind(value) === 1 &&
					fn.instructionOpcodeName(
						coreInstructionId(fn.kernel.valueDefinitionOwner(value)),
					) === "createEmpty"
				)
					continue;
				this.stores.set(
					key,
					this.stores.has(key) ? null : { function: functionId, value },
				);
			}
		}
	}

	cell(key: string): KnownValue | undefined {
		const root = this.roots.get(key);
		if (root !== undefined) return root;
		const store = this.stores.get(key);
		return store == null
			? undefined
			: this.value(this.#program.function(store.function), store.value);
	}

	value(fn: CoreFunctionStore, value: CoreValueId): KnownValue | undefined {
		const key = `${fn.id}:${value}`;
		const cached = this.values.get(key);
		if (cached !== undefined) return cached ?? undefined;
		if (this.visiting.has(key) || this.visiting.size > 1024) return undefined;
		this.visiting.add(key);
		const result = this.resolve(fn, value);
		this.visiting.delete(key);
		this.values.set(key, result ?? null);
		return result;
	}

	resolve(fn: CoreFunctionStore, value: CoreValueId): KnownValue | undefined {
		if (fn.kernel.valueDefinitionKind(value) === 0) {
			const block = coreBlockId(fn.kernel.valueDefinitionOwner(value));
			const parameterIndex = fn.kernel.valueDefinitionIndex(value);
			let result: KnownValue | undefined;
			for (const predecessor of fn.blockIds()) {
				const terminator = fn.blockTerminator(predecessor);
				const start = fn.kernel.terminatorEdgeStart(terminator);
				let selected: number | undefined;
				if (fn.instructionKind(terminator) === "branch") {
					const condition = this.value(fn, operand(fn, terminator, 0));
					if (condition !== undefined) selected = condition.value ? 0 : 1;
				}
				for (let index = 0; index < fn.kernel.terminatorEdgeCount(terminator); index++) {
					if (selected !== undefined && selected !== index) continue;
					const incoming = edge(fn, start + index);
					if (incoming.block !== block) continue;
					const argument = incoming.arguments[parameterIndex];
					if (argument === undefined || argument === value) return undefined;
					const candidate = this.value(fn, argument);
					if (
						candidate === undefined ||
						(result !== undefined && !Object.is(result.value, candidate.value))
					)
						return undefined;
					result = candidate;
				}
			}
			return result;
		}
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionKind(instruction) !== "operation") return undefined;
		const attributes = fn.instructionAttributes(instruction);
		const input = (index: number) => this.value(fn, operand(fn, instruction, index));
		switch (fn.instructionOpcodeName(instruction)) {
			case "createNull":
				return { value: null, platform: false };
			case "createUndefined":
				return { value: undefined, platform: false };
			case "createBoolean":
			case "createNumber":
			case "createF64":
				return typeof attributes.value === "boolean" ||
					typeof attributes.value === "number"
					? { value: attributes.value, platform: false }
					: undefined;
			case "createString":
				return typeof attributes.stringIndex === "number"
					? { value: this.strings[attributes.stringIndex], platform: false }
					: undefined;
			case "move":
				return input(0);
			case "loadGlobal":
				return this.cell(`global:${attributes.index}`);
			case "loadCaptured":
				return this.cell(`captured:${attributes.functionIndex}:${attributes.index}`);
			case "createModuleNamespace": {
				if (!Array.isArray(attributes.exports)) return undefined;
				const entries: Array<[string, PlatformData]> = [];
				for (const entry of attributes.exports) {
					if (entry === null || typeof entry !== "object" || Array.isArray(entry))
						return undefined;
					const name =
						typeof entry.nameStringIndex === "number"
							? this.strings[entry.nameStringIndex]
							: undefined;
					const constant = this.roots.get(`global:${entry.slot}`);
					if (name === undefined || constant?.value === undefined) return undefined;
					entries.push([name, constant.value]);
				}
				return { value: Object.fromEntries(entries), platform: true };
			}
			case "loadPropertyStatic":
			case "loadProperty": {
				const object = input(0);
				const key =
					fn.instructionOpcodeName(instruction) === "loadPropertyStatic"
						? this.strings[attributes.stringIndex as number]
						: input(1)?.value;
				if (
					!object?.platform ||
					object.value === null ||
					typeof object.value !== "object" ||
					(typeof key !== "string" && typeof key !== "number") ||
					!Object.hasOwn(object.value, key)
				)
					return undefined;
				return {
					value: (object.value as Readonly<Record<string, PlatformData>>)[String(key)],
					platform: true,
				};
			}
			case "unary": {
				const argument = input(0);
				if (!argument?.platform) return undefined;
				if (attributes.operator === "!")
					return { value: !argument.value, platform: true };
				if (attributes.operator === "typeof")
					return { value: typeof argument.value, platform: true };
				return undefined;
			}
			case "binary": {
				const left = input(0);
				const right = input(1);
				if (
					left === undefined ||
					right === undefined ||
					(!left.platform && !right.platform)
				)
					return undefined;
				if (attributes.operator === "===")
					return { value: left.value === right.value, platform: true };
				if (attributes.operator === "!==")
					return { value: left.value !== right.value, platform: true };
				if (
					(left.value !== null && typeof left.value === "object") ||
					(right.value !== null && typeof right.value === "object")
				)
					return undefined;
				const a = left.value as string | number;
				const b = right.value as string | number;
				switch (attributes.operator) {
					case "==":
						return { value: a == b, platform: true };
					case "!=":
						return { value: a != b, platform: true };
					case "<":
						return { value: a < b, platform: true };
					case "<=":
						return { value: a <= b, platform: true };
					case ">":
						return { value: a > b, platform: true };
					case ">=":
						return { value: a >= b, platform: true };
					default:
						return undefined;
				}
			}
			default:
				return undefined;
		}
	}
}

/** Frozen platform data licenses own reads, without assuming anything about prototypes. */
export function specializeCorePlatformConstants(
	compilation: ConstructedCoreCompilation,
): void {
	const values = new PlatformValues(compilation);
	if (values.roots.size === 0) return;
	const { program } = compilation;
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		const editor = CoreEditor.open(program, functionId);
		const discardable: Array<CoreInstructionId> = [];
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "requireCoercible") {
				const object = values.value(fn, operand(fn, instruction, 0));
				if (object?.platform && object.value !== null && object.value !== undefined)
					editor.removeInstruction(instruction);
				continue;
			}
			if (
				opcode !== "loadProperty" &&
				opcode !== "loadPropertyStatic" &&
				opcode !== "unary" &&
				opcode !== "binary" &&
				opcode !== "createModuleNamespace"
			)
				continue;
			const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			const known = values.value(fn, result);
			if (!known?.platform) continue;
			if (known.value !== null && typeof known.value === "object") {
				discardable.push(instruction);
				continue;
			}
			let constantOpcode: string;
			let attributes: { value?: boolean | number; stringIndex?: number } = {};
			if (known.value === undefined) constantOpcode = "createUndefined";
			else if (known.value === null) constantOpcode = "createNull";
			else if (typeof known.value === "boolean") {
				constantOpcode = "createBoolean";
				attributes = { value: known.value };
			} else if (typeof known.value === "number") {
				constantOpcode = "createNumber";
				attributes = { value: known.value };
			} else {
				const index = values.strings.indexOf(known.value);
				if (index < 0) continue;
				constantOpcode = "createString";
				attributes = { stringIndex: index };
			}
			editor.replaceInstruction(instruction, constantOpcode, [], {
				attributes,
				sourcePosition: fn.instructionSourcePosition(instruction),
			});
		}
		for (const block of fn.blockIds()) {
			const terminator = fn.blockTerminator(block);
			if (fn.instructionKind(terminator) !== "branch") continue;
			const condition = values.value(fn, operand(fn, terminator, 0));
			if (condition?.platform)
				editor.replaceTerminator(block, {
					kind: "jump",
					edge: edge(
						fn,
						fn.kernel.terminatorEdgeStart(terminator) + (condition.value ? 0 : 1),
					),
					sourcePosition: fn.instructionSourcePosition(terminator),
				});
		}
		for (const instruction of discardable.reverse()) {
			const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			if (fn.valueUseCount(value) + fn.kernel.valueHandlerUseCount(value) === 0)
				editor.removeInstruction(instruction);
		}
		editor.commit();
	}
}
