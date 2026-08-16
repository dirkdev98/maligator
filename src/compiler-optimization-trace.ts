import type {
	OptimizationMetrics,
	OptimizationPassDelta,
} from "./compiler-diagnostics.ts";
import type { IntermediateProgram, IRInstruction } from "./ir.ts";
import { isSafepoint } from "./liveness.ts";

const allocationTypes = new Set<IRInstruction["type"]>([
	"createObject",
	"createObjectShaped",
	"createArray",
	"instantiateLiteralTemplate",
	"createFunction",
	"createArgumentsObject",
	"createRestArguments",
	"createModuleNamespace",
	"createTemplateObject",
	"createBigint",
]);

const dynamicCallTypes = new Set<IRInstruction["type"]>([
	"callSpread",
	"callSpreadIterable",
	"constructSpread",
	"constructSuper",
	"constructSuperExplicit",
]);

const boxedOperationTypes = new Set<IRInstruction["type"]>([
	"binary",
	"unary",
	"toPropertyKey",
	"requireCoercible",
]);

const propertyHelperTypes = new Set<IRInstruction["type"]>([
	"loadProperty",
	"loadPropertyStatic",
	"storeProperty",
	"storePropertyStatic",
	"deleteProperty",
	"loadSuperProperty",
	"storeSuperProperty",
	"loadPrototype",
	"setPrototype",
	"loadGlobalProperty",
	"storeGlobalProperty",
	"copyDataProperties",
	"mergeDataProperties",
	"defineProperty",
]);

function isDynamicCall(instruction: IRInstruction): boolean {
	if (dynamicCallTypes.has(instruction.type)) return true;
	if (instruction.type === "construct") {
		return instruction.directFunctionIndex === undefined;
	}
	if (instruction.type !== "call") return false;
	return (
		instruction.directFunctionIndex === undefined &&
		instruction.directCallTargetFunctionIndex === undefined &&
		instruction.knownBuiltinCall?.identity.kind !== "known"
	);
}

function carriesWorldGuard(instruction: IRInstruction): boolean {
	if (instruction.type === "guardFunctionIndex") return true;
	if (instruction.type !== "call") return false;
	const identity = instruction.knownBuiltinCall?.identity;
	return (
		identity?.kind === "known" &&
		(identity.proof.dependencies.some(
			(dependency) => dependency.kind === "epoch" || dependency.kind === "guard",
		) ||
			identity.proof.obligations.some((obligation) => obligation.kind === "fallback"))
	);
}

export function optimizationMetrics(program: IntermediateProgram): OptimizationMetrics {
	const metrics = {
		allocationSites: 0,
		dynamicCalls: 0,
		boxedOperations: 0,
		propertyHelpers: 0,
		worldGuards: 0,
		safepoints: 0,
	};
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (allocationTypes.has(instruction.type)) metrics.allocationSites++;
				if (isDynamicCall(instruction)) metrics.dynamicCalls++;
				if (boxedOperationTypes.has(instruction.type)) metrics.boxedOperations++;
				if (propertyHelperTypes.has(instruction.type)) metrics.propertyHelpers++;
				if (carriesWorldGuard(instruction)) metrics.worldGuards++;
				if (isSafepoint(instruction)) metrics.safepoints++;
			}
		}
	}
	return metrics;
}

function metricDelta(
	before: OptimizationMetrics,
	after: OptimizationMetrics,
): OptimizationMetrics {
	return {
		allocationSites: after.allocationSites - before.allocationSites,
		dynamicCalls: after.dynamicCalls - before.dynamicCalls,
		boxedOperations: after.boxedOperations - before.boxedOperations,
		propertyHelpers: after.propertyHelpers - before.propertyHelpers,
		worldGuards: after.worldGuards - before.worldGuards,
		safepoints: after.safepoints - before.safepoints,
	};
}

export function optimizationPassDelta(
	pass: Omit<OptimizationPassDelta, "before" | "after" | "delta">,
	before: OptimizationMetrics,
	after: OptimizationMetrics,
): OptimizationPassDelta {
	return { ...pass, before, after, delta: metricDelta(before, after) };
}
