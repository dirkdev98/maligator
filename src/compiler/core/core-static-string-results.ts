import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import type { StaticPropertyDescription } from "../shared/static-values.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreStaticValue, CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

// The caller must prove a canonical call in the locked current realm.
export function coreStaticStringResult(
	program: CoreProgram,
	fn: CoreFunctionStore,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
	value: CoreValueId,
	operation: string,
	receiver: CoreValueId,
	args: ReadonlyArray<CoreValueId>,
): CoreStaticValue | undefined {
	if (operation !== "String.prototype.split" || args.length > 4096) return undefined;
	const source = analysis.queryAt(receiver, instruction);
	const separator =
		args[0] === undefined ? undefined : analysis.queryAt(args[0], instruction);
	if (
		source.kind !== "known" ||
		source.brand !== "string" ||
		(separator !== undefined &&
			(separator.kind !== "known" ||
				(separator.brand !== "string" && separator.brand !== "undefined")))
	)
		return undefined;
	const limitFact =
		args[1] === undefined ? undefined : analysis.queryAt(args[1], instruction);
	if (limitFact?.kind === "known") {
		const description = program.staticDescriptions.description(limitFact.description);
		if (
			description.kind === "bigint" ||
			(description.kind === "string" && description.codeUnits.length > 4096)
		)
			return undefined;
	}
	const limit =
		limitFact === undefined
			? { kind: "undefined" as const }
			: limitFact.kind === "known"
				? analysis.descriptionConstant(limitFact.description)
				: undefined;
	if (limit === undefined || limit.kind === "bigint") return undefined;
	const converted =
		limit.kind === "undefined"
			? { kind: "value" as const, value: { kind: "number" as const, value: 0xffffffff } }
			: evaluateConstantBuiltin("Number", undefined, [limit]);
	if (converted.kind !== "value" || converted.value.kind !== "number") return undefined;
	const empty = converted.value.value >>> 0 === 0;
	if (!empty && separator?.brand === "string") return undefined;
	const properties: Array<StaticPropertyDescription> = empty
		? []
		: [
				{
					key: "0",
					enumerable: true,
					configurable: true,
					descriptor: {
						kind: "data",
						writable: true,
						value: { kind: "operand", index: 0 },
					},
				},
			];
	const prototype = { kind: "intrinsic", id: "Array.prototype" } as const;
	const dependencies = new Set([
		"primordials.locked",
		"realm.current",
		...source.environmentDependencies,
	]);
	for (const fact of [separator, limitFact])
		if (fact?.kind === "known")
			for (const dependency of fact.environmentDependencies) dependencies.add(dependency);
	return {
		kind: "known",
		value,
		description: program.staticDescriptions.intern({
			kind: "array",
			prototype,
			length: properties.length,
			properties,
			ownKeysComplete: true,
		}),
		brand: "array",
		exactBrand: "Array",
		prototype,
		identity: { kind: "fresh-per-evaluation", function: fn.id, value },
		construction: { kind: "call", callee: operation, instruction, arguments: args },
		state: "initial-allocation",
		operands: empty ? [] : [receiver],
		allocationIdentities: [],
		environmentDependencies: [...dependencies],
	};
}
