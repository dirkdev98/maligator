import type { WorldFacts } from "./compiler-facts.ts";

export interface BuiltinWorldAssumptions {
	readonly operation: string;
	readonly primordials: "locked";
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
): BuiltinWorldAssumptions {
	return {
		operation,
		primordials: "locked",
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
	const expected = builtinWorldAssumptions(
		operation,
		record.receiver,
		record.realm === "single-realm",
	);
	for (const [key, value] of Object.entries(expected))
		if (record[key] !== value)
			throw new Error(`Invalid ${key} assumption for ${operation}`);
	if (
		world !== undefined &&
		(world.primordialPolicy !== "locked" ||
			(expected.realm === "single-realm" && world.realms))
	)
		throw new Error(`World assumptions are unavailable for ${operation}`);
}
