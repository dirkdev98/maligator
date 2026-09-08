import { invocationPreservesPrivateReceiver } from "../shared/builtin-semantics.ts";
import { knownOperationIndex, knownOperations } from "../shared/known-operations.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export interface CoreMaterializationDemand {
	readonly value: CoreValueId;
	readonly instruction: CoreInstructionId;
	readonly operand: number;
	readonly kind: "metadata" | "content" | "mutation" | "alias" | "identity";
	readonly reason: string;
}

export interface CoreMaterializationPlan {
	readonly identity: { readonly function: number; readonly value: CoreValueId };
	readonly choice: "virtual" | "fresh" | "private-read-only";
	readonly demands: ReadonlyArray<CoreMaterializationDemand>;
}

export function coreMaterializationPlan(
	fn: CoreFunctionStore,
	root: CoreValueId,
	options: {
		readonly initializers?: ReadonlySet<CoreInstructionId>;
		readonly graphAllocations?: ReadonlySet<CoreInstructionId>;
		readonly shallow?: boolean;
	} = {},
): CoreMaterializationPlan {
	const demands: Array<CoreMaterializationDemand> = [];
	const pending = [
			root,
			...[...(options.graphAllocations ?? [])].flatMap((instruction) =>
				Array.from(
					{ length: fn.kernel.instructionResultCount(instruction) },
					(_, index) =>
						fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction) + index),
				),
			),
		],
		aliases = new Set<CoreValueId>();
	let fresh = false,
		storage = false;
	while (pending.length > 0) {
		const value = pending.pop()!;
		if (aliases.has(value)) continue;
		aliases.add(value);
		for (
			let use = fn.kernel.valueFirstHandlerUse(value);
			use >= 0;
			use = fn.kernel.handlerArgumentNextUse(use)
		) {
			demands.push({
				value,
				instruction: fn.blockTerminator(fn.kernel.handlerArgumentBlock(use)),
				operand: -1,
				kind: "identity",
				reason: "exception-handler-storage",
			});
			fresh = true;
			storage = true;
		}
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			const instruction = fn.kernel.useInstruction(use),
				operand = fn.kernel.useOperand(use);
			const kind = fn.instructionKind(instruction);
			const record = (kind: CoreMaterializationDemand["kind"], reason: string) => {
				demands.push({ value, instruction, operand, kind, reason });
			};
			if (
				(options.initializers?.has(instruction) &&
					(operand === 0 || options.graphAllocations !== undefined)) ||
				options.graphAllocations?.has(instruction)
			)
				continue;
			if (kind !== "operation") {
				record(
					kind === "jump" ? "alias" : "identity",
					kind === "return"
						? "returned-value"
						: kind === "jump"
							? "control-flow-storage"
							: "control-flow-observation",
				);
				fresh = storage = true;
				continue;
			}
			const opcode = fn.instructionOpcodeName(instruction),
				attributes = fn.instructionAttributes(instruction);
			if (opcode === "move") {
				record("alias", "same-evaluation-alias");
				const start = fn.kernel.instructionResultStart(instruction);
				for (
					let index = 0;
					index < fn.kernel.instructionResultCount(instruction);
					index++
				)
					pending.push(fn.kernel.resultAt(start + index));
				continue;
			}
			if (
				opcode === "typeofCompare" ||
				(opcode === "unary" && attributes.operator === "typeof")
			) {
				record("metadata", "type-observation");
				storage = true;
				continue;
			}
			if (
				opcode === "callKnown" &&
				!attributes.construct &&
				attributes.argumentMode === undefined &&
				operand === 0
			) {
				const operation =
					typeof attributes.operation === "string"
						? knownOperations()[knownOperationIndex(attributes.operation) ?? -1]
						: undefined;
				if (
					operation !== undefined &&
					invocationPreservesPrivateReceiver(
						operation.semantics,
						options.shallow === true,
					)
				) {
					record("content", operation.id);
					storage = true;
					continue;
				}
				if (operation?.semantics.steps.some((step) => step.kind === "write")) {
					record("mutation", operation.id);
					fresh = storage = true;
					if (operation.semantics.result === "receiver-alias") {
						const start = fn.kernel.instructionResultStart(instruction);
						for (
							let index = 0;
							index < fn.kernel.instructionResultCount(instruction);
							index++
						)
							pending.push(fn.kernel.resultAt(start + index));
					}
					continue;
				}
			}
			if (
				operand === 0 &&
				[
					"storeProperty",
					"storePropertyStatic",
					"defineProperty",
					"definePropertyAccessor",
					"deleteProperty",
					"deletePropertyStatic",
				].includes(opcode)
			) {
				record("mutation", "receiver-state-write");
			} else if (
				operand === 0 &&
				["loadProperty", "loadPropertyStatic"].includes(opcode)
			) {
				record("content", "unproved-property-observation");
			} else {
				record(
					"identity",
					opcode === "yield" || opcode === "await"
						? "suspension"
						: opcode === "storeCaptured"
							? "captured-by-closure"
							: opcode.startsWith("call")
								? "observable-call-argument"
								: "identity-or-storage-exposure",
				);
			}
			fresh = storage = true;
		}
	}
	return {
		identity: { function: fn.id, value: root },
		choice: fresh ? "fresh" : storage ? "private-read-only" : "virtual",
		demands,
	};
}
