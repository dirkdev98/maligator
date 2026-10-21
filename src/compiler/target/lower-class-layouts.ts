import { coreClassLayoutKeyId, coreClassLayouts } from "../core/core-class-layouts.ts";
import type { CoreClassLayout } from "../core/core-class-layouts.ts";
import type { CoreCompilation } from "../core/core-compilation.ts";
import { coreInstructionId } from "../core/core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "../core/core-ir.ts";
import { coreModulePrivateNames } from "../core/core-private-names.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import type { CompilerClassLayoutSite } from "../shared/compiler-instruction.ts";
import type { CoreTargetClassLayout, CoreTargetFunctionMap } from "./core-target-ir.ts";

const UNDER_CONSTRUCTION: ReadonlySet<string> = new Set([
	"createBaseConstructReceiver",
	"constructSuper",
	"constructSuperExplicit",
	"createObject",
	"createObjectShaped",
	"instantiateLiteralTemplate",
]);

/** A guard chain longer than this costs more on a miss than the inline cache it precedes. */
const CLASS_LAYOUT_SITE_CANDIDATES = 4;

export interface CoreClassLayoutPlan {
	readonly layouts: ReadonlyArray<CoreTargetClassLayout>;
	readonly sites: ReadonlyMap<
		CoreFunctionId,
		ReadonlyMap<CoreInstructionId, CompilerClassLayoutSite>
	>;
}

interface PlannedLayout {
	readonly ordinal: number;
	readonly slots: ReadonlyMap<string, number>;
	readonly methods: ReadonlyMap<number, number>;
}

function rootDefinition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	for (let depth = 0; depth < 16; depth++) {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(instruction) !== "move") return instruction;
		value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	}
	return undefined;
}

/**
 * Assigns each live class a layout ordinal and each class-member access the
 * layouts it can guard on: the method's own class family for `this`, otherwise
 * every class that installs the key or resolves the method name.
 */
export function planCoreClassLayouts(
	compilation: CoreCompilation,
	functionMap: CoreTargetFunctionMap,
): CoreClassLayoutPlan {
	const program = compilation.program;
	const index = coreClassLayouts(program);
	const privateNames = coreModulePrivateNames(program, compilation.context);
	const live = (id: CoreFunctionId) => (functionMap.coreToExecution[id] ?? -1) >= 0;
	const layouts: Array<CoreTargetClassLayout> = [];
	const planned = new Map<CoreFunctionId, PlannedLayout>();
	const plan = (layout: CoreClassLayout): void => {
		if (!live(layout.constructor)) return;
		const keys: Array<number> = [];
		const slots = new Map<string, number>();
		for (const key of layout.keys) {
			// A private name the program can rebind would let a stale shape pass the guard.
			if (key.private && !privateNames.validSlot(key.index)) break;
			slots.set(coreClassLayoutKeyId(key), keys.length);
			keys.push(key.private ? ~key.index : key.index);
		}
		const methods: Array<number> = [];
		const methodOrdinals = new Map<number, number>();
		for (const method of layout.methods) {
			if (!live(method.target)) continue;
			methodOrdinals.set(method.stringIndex, methods.length / 2);
			methods.push(method.stringIndex, functionMap.coreToExecution[method.target]!);
		}
		if (keys.length === 0 && methods.length === 0) return;
		planned.set(layout.constructor, {
			ordinal: layouts.length,
			slots,
			methods: methodOrdinals,
		});
		layouts.push({
			constructor: functionMap.coreToExecution[layout.constructor]!,
			keys,
			methods,
		});
	};
	for (const layout of index.layouts.values()) plan(layout);
	const sites = new Map<
		CoreFunctionId,
		Map<CoreInstructionId, CompilerClassLayoutSite>
	>();
	if (layouts.length === 0) return { layouts, sites };
	const site = (
		classes: ReadonlyArray<CoreFunctionId> | undefined,
		select: (layout: PlannedLayout) => number | undefined,
	): CompilerClassLayoutSite["candidates"] | undefined => {
		const candidates: Array<{ layout: number; index: number }> = [];
		for (const constructor of classes ?? []) {
			const layout = planned.get(constructor);
			const selected = layout === undefined ? undefined : select(layout);
			if (selected === undefined) continue;
			if (candidates.length === CLASS_LAYOUT_SITE_CANDIDATES) return undefined;
			candidates.push({ layout: layout!.ordinal, index: selected });
		}
		return candidates.length === 0 ? undefined : candidates;
	};
	for (const core of functionMap.executionToCore) {
		const fn = program.function(core);
		const owner = fn.metadata.lexicalThis ? undefined : index.methodClass.get(core);
		const family = owner === undefined ? undefined : index.family.get(owner);
		let functionSites: Map<CoreInstructionId, CompilerClassLayoutSite> | undefined;
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			const start = fn.kernel.instructionOperandStart(instruction);
			let keyId: string | undefined;
			let name: number | undefined;
			if (opcode === "loadPropertyStatic" || opcode === "storePropertyStatic") {
				const stringIndex = fn.instructionAttributes(instruction).stringIndex;
				if (typeof stringIndex !== "number") continue;
				name = stringIndex;
				keyId = coreClassLayoutKeyId({ private: false, index: stringIndex });
			} else if (opcode === "loadPrivate" || opcode === "storePrivate") {
				const slot = privateNames.keySlot(fn, fn.kernel.operandAt(start + 1));
				if (slot === undefined) continue;
				keyId = coreClassLayoutKeyId({ private: true, index: slot });
			} else continue;
			const receiver = rootDefinition(fn, fn.kernel.operandAt(start));
			const receiverOpcode =
				receiver === undefined ? undefined : fn.instructionOpcodeName(receiver);
			// An object under construction has not reached any layout's shape yet.
			if (
				(receiverOpcode === "loadThis" && fn.metadata.isClassConstructor) ||
				(receiverOpcode !== undefined && UNDER_CONSTRUCTION.has(receiverOpcode))
			)
				continue;
			const own =
				family !== undefined &&
				receiver !== undefined &&
				fn.instructionOpcodeName(receiver) === "loadThis";
			// Objects that own the name as data never match a class layout, so a guess by
			// name would only add a guard to their sites.
			if (!own && name !== undefined && index.ordinaryKeys.has(name)) continue;
			let result: CompilerClassLayoutSite | undefined;
			if (opcode === "loadPropertyStatic") {
				const methods = site(own ? family : index.byMethodName.get(name!), (layout) =>
					layout.methods.get(name!),
				);
				if (methods !== undefined) result = { kind: "method", candidates: methods };
			}
			if (result === undefined) {
				const slots = site(own ? family : index.byKey.get(keyId), (layout) =>
					layout.slots.get(keyId),
				);
				if (slots !== undefined) result = { kind: "slot", candidates: slots };
			}
			if (result === undefined) continue;
			functionSites ??= new Map();
			functionSites.set(instruction, result);
		}
		if (functionSites !== undefined) sites.set(core, functionSites);
	}
	return { layouts, sites };
}
