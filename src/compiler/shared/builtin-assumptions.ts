import type { WorldFacts } from "./compiler-facts.ts";

export interface BuiltinWorldAssumptions {
	readonly operation: string;
	/**
	 * `guarded`: in a mutable single-realm world, the primordial-bindings protector
	 * held where the program selected this operation over its loaded twin.
	 */
	readonly primordials: "locked" | "guarded";
	readonly receiver: "literal-allocation" | "primitive" | "exact-builtin-proof";
	readonly ownDescriptor: "absent-or-exact";
	readonly prototype: "proven-chain";
	readonly realm: "single-realm" | "current-execution-realm";
	readonly sourceClosure: "independent";
	readonly eval: "independent";
	readonly hostBindings: "not-authorized";
}

export function builtinWorldAssumptions(
	operation: string,
	receiver: BuiltinWorldAssumptions["receiver"],
	singleRealm = false,
	primordials: BuiltinWorldAssumptions["primordials"] = "locked",
): BuiltinWorldAssumptions {
	return {
		operation,
		primordials,
		receiver,
		ownDescriptor: "absent-or-exact",
		prototype: "proven-chain",
		realm: singleRealm ? "single-realm" : "current-execution-realm",
		sourceClosure: "independent",
		eval: "independent",
		hostBindings: "not-authorized",
	};
}

export function verifyBuiltinWorldAssumptions(
	assumptions: unknown,
	operation: string,
	world?: WorldFacts,
): void {
	if (typeof assumptions !== "object" || assumptions === null)
		throw new Error(`Missing world assumptions for ${operation}`);
	const record = assumptions as Record<string, unknown>;
	if (
		record.receiver !== "literal-allocation" &&
		record.receiver !== "primitive" &&
		record.receiver !== "exact-builtin-proof"
	)
		throw new Error(`Missing receiver proof for ${operation}`);
	const guarded = record.primordials === "guarded";
	const expected = builtinWorldAssumptions(
		operation,
		record.receiver,
		record.realm === "single-realm",
		guarded ? "guarded" : "locked",
	);
	for (const [key, value] of Object.entries(expected))
		if (record[key] !== value)
			throw new Error(`Invalid ${key} assumption for ${operation}`);
	if (guarded && expected.realm !== "single-realm")
		throw new Error(`Guarded world assumptions need one realm for ${operation}`);
	if (
		world !== undefined &&
		(world.primordialPolicy !== (guarded ? "mutable" : "locked") ||
			(expected.realm === "single-realm" && world.realms))
	)
		throw new Error(`World assumptions are unavailable for ${operation}`);
}
