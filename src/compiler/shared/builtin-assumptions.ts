import type { WorldFacts } from "./compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
	compilerValueKindMaskIsValid,
	compilerValueKindMaskIsSubset,
} from "./compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "./compiler-value-kinds.ts";

export interface BuiltinWorldAssumptions {
	readonly operation: string;
	/**
	 * `guarded`: in a mutable world, the primordial-bindings protector
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

export const GUARDED_NUMBER_PREDICATES: ReadonlySet<string> = new Set([
	"Number.isNaN",
	"Number.isFinite",
	"Number.isInteger",
	"Number.isSafeInteger",
]);

// These consumers neither construct realm-owned values nor reenter JavaScript.
export const GUARDED_CURRENT_REALM_OPERATIONS: ReadonlySet<string> = new Set([
	...GUARDED_NUMBER_PREDICATES,
	"Date.now",
	"Boolean",
]);

export function guardedCurrentRealmOperation(
	operation: string,
	consumedArgumentKinds?: ReadonlyArray<CompilerValueKindMask>,
): boolean {
	return (
		GUARDED_CURRENT_REALM_OPERATIONS.has(operation) ||
		(operation === "Date.UTC" &&
			consumedArgumentKinds !== undefined &&
			consumedArgumentKinds.every((kind) => kind === COMPILER_VALUE_KIND_NUMBER)) ||
		((operation === "String" || operation === "Number") &&
			consumedArgumentKinds !== undefined &&
			(consumedArgumentKinds.length === 0 ||
				(consumedArgumentKinds.length === 1 &&
					compilerValueKindMaskIsValid(consumedArgumentKinds[0]) &&
					compilerValueKindMaskIsSubset(
						consumedArgumentKinds[0],
						COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
					)))) ||
		((operation === "Date.parse" || operation === "parseFloat") &&
			consumedArgumentKinds?.length === 1 &&
			consumedArgumentKinds[0] === COMPILER_VALUE_KIND_STRING) ||
		(operation === "parseInt" &&
			consumedArgumentKinds?.[0] === COMPILER_VALUE_KIND_STRING &&
			(consumedArgumentKinds.length === 1 ||
				(consumedArgumentKinds.length === 2 &&
					(consumedArgumentKinds[1] === COMPILER_VALUE_KIND_NUMBER ||
						consumedArgumentKinds[1] === COMPILER_VALUE_KIND_UNDEFINED))))
	);
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
	consumedArgumentKinds?: ReadonlyArray<CompilerValueKindMask>,
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
	if (
		guarded &&
		expected.realm === "current-execution-realm" &&
		!guardedCurrentRealmOperation(operation, consumedArgumentKinds)
	)
		throw new Error(`Unsupported current-realm guarded operation ${operation}`);
	if (
		world !== undefined &&
		(world.primordialPolicy !== (guarded ? "mutable" : "locked") ||
			(expected.realm === "single-realm" && world.realms))
	)
		throw new Error(`World assumptions are unavailable for ${operation}`);
}
