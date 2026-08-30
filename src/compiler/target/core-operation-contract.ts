import {
	CORE_OPCODES,
	coreInstructionEffects,
	coreOpcodeRegistry,
	isCoreOpcode,
} from "../core/core-ir-opcodes.ts";
import type { CoreOpcode } from "../core/core-ir-opcodes.ts";
import type { CoreInstruction, CoreOpcodeRegistry } from "../core/core-ir.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";

/** Target-only forms synthesized from Core's structural control-flow model. */
export const CORE_STRUCTURAL_TARGET_OPERATIONS = [
	"sourcePos",
	"return",
	"jumpIf",
	"jump",
	"throw",
	"catch",
	"tryBegin",
	"tryEnd",
] as const satisfies ReadonlyArray<CompilerInstruction["type"]>;

type StructuralTargetOperation = (typeof CORE_STRUCTURAL_TARGET_OPERATIONS)[number];
type CompilerCoreOperation = Extract<CompilerInstruction, { type: CoreOpcode }>;
type MissingCompilerCoreOperation = Exclude<CoreOpcode, CompilerCoreOperation["type"]>;
type UnownedCompilerOperation = Exclude<
	CompilerInstruction["type"],
	CoreOpcode | StructuralTargetOperation
>;

const compilerOperationOwnershipIsExact: [
	MissingCompilerCoreOperation,
	UnownedCompilerOperation,
] extends [never, never]
	? true
	: never = true;

const CORE_REGISTERLESS_OPERATIONS = [
	"asyncStart",
	"createPrivateNames",
	"envCopy",
	"envPop",
	"envPush",
	"generatorStart",
	"initGlobalVars",
] as const satisfies ReadonlyArray<CoreOpcode>;

type RegisterlessCoreOperation = (typeof CORE_REGISTERLESS_OPERATIONS)[number];
type RegisterBearingCompilerCoreOperation = Extract<
	CompilerCoreOperation,
	{ readonly registers: ReadonlyArray<number> }
>["type"];
type MissingRepresentationCarrier = Exclude<
	CoreOpcode,
	RegisterlessCoreOperation | RegisterBearingCompilerCoreOperation
>;

const compilerRepresentationCarrierIsComplete: MissingRepresentationCarrier extends never
	? true
	: never = true;

export interface CoreTargetOperationContract {
	readonly opcode: CoreOpcode;
	/** Ordinary operations preserve their Core identity through target lowering. */
	readonly targetType: CoreOpcode;
	readonly outputCount: number;
	/** Output representations are carried by the corresponding physical registers. */
	readonly representation: "none" | "core-value-register";
	/** Refined instruction effects decide whether target lowering records a safepoint. */
	readonly safepoint: "instruction-effects";
}

function createCoreTargetOperationContracts(
	registry: CoreOpcodeRegistry,
): ReadonlyMap<CoreOpcode, CoreTargetOperationContract> {
	const descriptors = new Map(registry.entries().map((entry) => [entry.opcode, entry]));
	for (const opcode of CORE_OPCODES) {
		if (!descriptors.has(opcode)) {
			throw new Error(`Core target contract is missing opcode ${opcode}`);
		}
	}
	for (const opcode of descriptors.keys()) {
		if (!isCoreOpcode(opcode)) {
			throw new Error(`Core target contract has unowned opcode ${opcode}`);
		}
	}
	const registerless = new Set<CoreOpcode>(CORE_REGISTERLESS_OPERATIONS);
	return new Map(
		CORE_OPCODES.map((opcode) => {
			const descriptor = descriptors.get(opcode)!;
			if (descriptor.outputs.minimum !== descriptor.outputs.maximum) {
				throw new Error(
					`Core target contract requires fixed outputs for ${opcode}, received ${descriptor.outputs.minimum}..${descriptor.outputs.maximum}`,
				);
			}
			if (registerless.has(opcode) && descriptor.outputs.minimum !== 0) {
				throw new Error(
					`Core target contract cannot carry ${opcode}'s outputs without registers`,
				);
			}
			return [
				opcode,
				Object.freeze({
					opcode,
					targetType: opcode,
					outputCount: descriptor.outputs.minimum,
					representation:
						descriptor.outputs.minimum === 0 ? "none" : "core-value-register",
					safepoint: "instruction-effects",
				}),
			] as const;
		}),
	);
}

export const coreTargetOperationContracts =
	createCoreTargetOperationContracts(coreOpcodeRegistry);

export function verifyCoreTargetOperationContracts(
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
): void {
	createCoreTargetOperationContracts(registry);
}

export function requireCoreTargetOperationContract(
	opcode: string,
): CoreTargetOperationContract {
	if (!isCoreOpcode(opcode)) {
		throw new Error(`Core target contract has no lowering for ${opcode}`);
	}
	return coreTargetOperationContracts.get(opcode)!;
}

export function coreInstructionNeedsOperationSafepoint(
	instruction: CoreInstruction,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
): boolean {
	requireCoreTargetOperationContract(instruction.opcode);
	return coreInstructionEffects(instruction, registry).mayGc;
}

void compilerOperationOwnershipIsExact;
void compilerRepresentationCarrierIsComplete;
