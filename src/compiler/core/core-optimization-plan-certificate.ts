import type {
	CoreOptimizationPlan,
	VerifiedCoreOptimizationPlan,
} from "./core-ir-regions.ts";
import type { SealedCoreProgram } from "./core-store.ts";

const verifiedPlans = new WeakMap<CoreOptimizationPlan, SealedCoreProgram>();

export function certifyCoreOptimizationPlan(
	program: SealedCoreProgram,
	plan: CoreOptimizationPlan,
): VerifiedCoreOptimizationPlan {
	verifiedPlans.set(plan, program);
	return plan as VerifiedCoreOptimizationPlan;
}

export function assertCoreOptimizationPlanCertificate(
	program: SealedCoreProgram,
	plan: VerifiedCoreOptimizationPlan,
): void {
	if (verifiedPlans.get(plan) !== program) {
		throw new Error(
			"Core target lowering requires the optimizer's verified plan certificate",
		);
	}
}
