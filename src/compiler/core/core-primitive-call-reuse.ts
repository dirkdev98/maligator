import { builtinPrimitiveResult } from "../shared/builtin-semantics.ts";
import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import { PORTABLE_CONSTANT_TARGET } from "../shared/constant-evaluator.ts";
import type { ConstantEvaluationTarget } from "../shared/constant-evaluator.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";

const localeCaseOperations = new Set([
	"String.prototype.toLocaleLowerCase",
	"String.prototype.toLocaleUpperCase",
]);

const primitiveBrands = new Set([
	"undefined",
	"null",
	"boolean",
	"number",
	"string",
	"bigint",
	"symbol",
]);
const immutableReceiverMethods = new Map([
	["Boolean.prototype.valueOf", 0],
	["Boolean.prototype.toString", 0],
	["Number.prototype.valueOf", 0],
	["Number.prototype.toString", 1],
	["Number.prototype.toFixed", 1],
	["Number.prototype.toExponential", 1],
	["Number.prototype.toPrecision", 1],
	["String.prototype.valueOf", 0],
	["String.prototype.toString", 0],
	["BigInt.prototype.valueOf", 0],
	["BigInt.prototype.toString", 1],
	["Symbol.prototype.valueOf", 0],
	["Symbol.prototype.toString", 0],
	["Symbol.prototype[%Symbol.toPrimitive%]", 0],
	["Symbol.prototype.description<get>", 0],
]);
const predicates = new Set([
	"Number.isNaN",
	"Number.isFinite",
	"Number.isInteger",
	"Number.isSafeInteger",
]);
const variadic = new Set([
	"Math.min",
	"Math.max",
	"Math.hypot",
	"String.fromCharCode",
	"String.fromCodePoint",
	"String.prototype.concat",
]);
const binary = new Set([
	"Math.atan2",
	"Math.pow",
	"Math.imul",
	"parseInt",
	"Number.parseInt",
	"BigInt.asIntN",
	"BigInt.asUintN",
	...[
		"includes",
		"indexOf",
		"lastIndexOf",
		"startsWith",
		"endsWith",
		"slice",
		"substring",
		"substr",
		"padStart",
		"padEnd",
		"replace",
		"replaceAll",
		"split",
	].map((method) => `String.prototype.${method}`),
]);
const parameterless = new Set([
	"valueOf",
	"toWellFormed",
	"isWellFormed",
	"trim",
	"trimStart",
	"trimEnd",
	"toUpperCase",
	"toLowerCase",
	"description<get>",
	"big",
	"blink",
	"bold",
	"fixed",
	"italics",
	"small",
	"strike",
	"sub",
	"sup",
]);
const nonthrowingStrings = new Set([
	"toString",
	"valueOf",
	"at",
	"charAt",
	"charCodeAt",
	"codePointAt",
	"includes",
	"indexOf",
	"lastIndexOf",
	"startsWith",
	"endsWith",
	"slice",
	"substring",
	"substr",
	"trim",
	"trimStart",
	"trimEnd",
	"isWellFormed",
	"toWellFormed",
	"toLowerCase",
	"toUpperCase",
	"split",
]);

function candidate(operation: string): boolean {
	return (
		operation !== "Date" &&
		operation !== "Math.random" &&
		operation !== "Math.sumPrecise" &&
		operation !== "String.raw" &&
		(!operation.includes("toLocale") || localeCaseOperations.has(operation)) &&
		!operation.endsWith("localeCompare") &&
		(immutableReceiverMethods.has(operation) ||
			// A successful registry lookup fixes this primitive key's Symbol identity permanently.
			operation === "Symbol.for" ||
			(builtinPrimitiveResult(operation) !== undefined &&
				builtinPrimitiveResult(operation) !== "symbol") ||
			[
				"String.prototype.replace",
				"String.prototype.replaceAll",
				"String.prototype.split",
				"globalThis.escape",
				"globalThis.unescape",
			].includes(operation))
	);
}

function argumentsUsed(operation: string): number {
	const immutable = immutableReceiverMethods.get(operation);
	if (immutable !== undefined) return immutable;
	if (variadic.has(operation)) return Infinity;
	if (binary.has(operation)) return 2;
	const method = operation.slice(operation.lastIndexOf(".") + 1);
	if (
		operation.includes(".prototype.") &&
		(parameterless.has(method) ||
			(method === "toString" &&
				!operation.startsWith("Number.") &&
				!operation.startsWith("BigInt.")))
	)
		return 0;
	return 1;
}

function canDiscard(
	operation: string,
	receiver: string | undefined,
	brands: ReadonlyArray<string | undefined>,
	inputs: ReadonlyArray<CoreValueId>,
	analysis: CoreStaticValueAnalysis,
	target: ConstantEvaluationTarget,
): boolean {
	if (predicates.has(operation) || operation === "Boolean") return true;
	if (brands.some((brand) => brand === undefined)) return false;
	const first = brands[0] ?? "undefined";
	const numeric = brands.every((brand) => brand !== "bigint" && brand !== "symbol");
	if (operation === "Number") return first !== "symbol";
	if (operation === "String") return true;
	if (operation === "BigInt") return first === "bigint" || first === "boolean";
	if (operation.startsWith("Math.")) return numeric;
	if (
		operation === "isNaN" ||
		operation === "isFinite" ||
		operation === "String.fromCharCode"
	)
		return numeric;
	if (operation.endsWith("parseFloat")) return first !== "symbol";
	if (operation.endsWith("parseInt"))
		return first !== "symbol" && !["bigint", "symbol"].includes(brands[1] ?? "undefined");
	if (
		["escape", "unescape", "globalThis.escape", "globalThis.unescape"].includes(operation)
	)
		return first !== "symbol";
	if (operation === "Symbol.keyFor") return first === "symbol";
	if (
		operation.startsWith("Symbol.prototype.") ||
		operation === "Symbol.prototype[%Symbol.toPrimitive%]"
	)
		return receiver === "symbol";
	if (operation.startsWith("Boolean.prototype.")) return receiver === "boolean";
	if (operation.startsWith("String.prototype.")) {
		if (receiver !== "string") return false;
		const method = operation.slice("String.prototype.".length);
		if (nonthrowingStrings.has(method)) return numeric;
		if (method !== "normalize" && !localeCaseOperations.has(operation)) return false;
		return (
			evaluateConstantBuiltin(
				operation,
				{ kind: "string", value: "" },
				inputs.map((input) => analysis.constant(input)),
				target,
			).kind === "value"
		);
	}
	if (
		operation.startsWith("Number.prototype.") ||
		operation.startsWith("BigInt.prototype.")
	) {
		if (receiver !== (operation.startsWith("Number.") ? "number" : "bigint"))
			return false;
		return (
			evaluateConstantBuiltin(
				operation,
				receiver === "number"
					? { kind: "number", value: 0 }
					: { kind: "bigint", value: 0n },
				inputs.map((input) => analysis.constant(input)),
			).kind === "value"
		);
	}
	if (operation === "BigInt.asIntN" || operation === "BigInt.asUintN") {
		if (brands[1] !== "bigint" && brands[1] !== "boolean") return false;
		return (
			evaluateConstantBuiltin(operation, undefined, [
				inputs[0] === undefined ? { kind: "undefined" } : analysis.constant(inputs[0]),
				{ kind: "bigint", value: 0n },
			]).kind === "value"
		);
	}
	return false;
}

export const reusePrimitiveCallResults: CoreFunctionPass = {
	name: "reuse-primitive-call-results",
	stage: "memory",
	requiredFunctionOpcodesAny: ["callKnown"],
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	admission: {
		predicate: "repeated or unused deterministic primitive builtin results",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId),
				seen = new Set<string>();
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				if (fn.instructionOpcodeName(instruction) !== "callKnown") continue;
				const attributes = fn.instructionAttributes(instruction),
					operation = attributes.operation as string;
				if (
					attributes.construct ||
					attributes.argumentMode !== undefined ||
					!candidate(operation)
				)
					continue;
				const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
				if (
					seen.has(operation) ||
					(fn.kernel.valueUseCount(result) === 0 &&
						fn.kernel.valueHandlerUseCount(result) === 0)
				)
					return true;
				seen.add(operation);
			}
			return false;
		},
	},
	wakesOn: ["body", "facts"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const fn = context.program.function(context.item.function),
			analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const target = {
			...PORTABLE_CONSTANT_TARGET,
			intl: context.compilationContext.facts.world.ecmaFeatures.intl,
		};
		const plans: Array<{
			instruction: CoreInstructionId;
			replacement?: CoreValueId;
		}> = [];
		const brand = (value: CoreValueId): string | undefined => {
			const fact = analysis.query(value);
			return fact.kind === "known" && primitiveBrands.has(fact.brand)
				? fact.brand
				: undefined;
		};
		const valueKey = (value: CoreValueId): string => {
			const fact = analysis.query(value);
			if (fact.kind === "known") {
				const description = context.program.staticDescriptions.description(
					fact.description,
				);
				if (
					["number", "string", "boolean", "bigint", "null", "undefined"].includes(
						description.kind,
					)
				)
					return `c${fact.description}`;
			}
			return `v${value}`;
		};
		let visits = 0;
		for (const block of fn.blockIds()) {
			if (visits >= 4096 || plans.length * 4 + 4 > context.remainingEdits) break;
			const available = new Map<string, CoreValueId>();
			for (const instruction of fn.instructionIds(block)) {
				if (++visits > 4096 || plans.length * 4 + 4 > context.remainingEdits) break;
				if (fn.instructionKind(instruction) !== "operation") continue;
				if (coreInstructionEffects(fn, instruction).maySuspend) available.clear();
				if (fn.instructionOpcodeName(instruction) !== "callKnown") continue;
				const attributes = fn.instructionAttributes(instruction),
					operation = attributes.operation as string;
				if (
					attributes.construct ||
					attributes.argumentMode !== undefined ||
					!candidate(operation)
				)
					continue;
				const start = fn.kernel.instructionOperandStart(instruction),
					receiver = fn.kernel.operandAt(start);
				const argumentCount = Math.min(
					fn.kernel.instructionOperandCount(instruction) - 1,
					argumentsUsed(operation),
				);
				if (visits + argumentCount > 4096) {
					visits = 4096;
					break;
				}
				visits += argumentCount;
				const args = Array.from({ length: argumentCount }, (_, index) =>
					fn.kernel.operandAt(start + index + 1),
				);
				const immutableReceiver = immutableReceiverMethods.has(operation);
				const usesReceiver = immutableReceiver || operation.includes(".prototype.");
				let receiverBrand = usesReceiver ? brand(receiver) : undefined;
				if (immutableReceiver && receiverBrand === undefined) {
					const fact = analysis.query(receiver);
					if (
						fact.kind === "known" &&
						fact.exactBrand !== undefined &&
						operation.startsWith(`${fact.exactBrand}.prototype`)
					)
						receiverBrand = fact.exactBrand.toLowerCase();
				}
				const brands = args.map(brand);
				if (
					!predicates.has(operation) &&
					operation !== "Boolean" &&
					(brands.some((value) => value === undefined) ||
						(usesReceiver && !immutableReceiver && receiverBrand === undefined))
				)
					continue;
				if (
					localeCaseOperations.has(operation) &&
					(receiverBrand !== "string" ||
						(target.intl && !["string", "undefined"].includes(brands[0] ?? "undefined")))
				)
					continue;
				const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
				if (
					fn.kernel.valueUseCount(result) === 0 &&
					fn.kernel.valueHandlerUseCount(result) === 0 &&
					canDiscard(operation, receiverBrand, brands, args, analysis, target)
				) {
					plans.push({ instruction });
					continue;
				}
				if (operation === "String.prototype.split") continue;
				// Strict receiver checks expose immutable slots, so reuse also preserves Symbol identity.
				const key = `${operation}:${usesReceiver ? valueKey(receiver) : ""}:${args.map(valueKey).join(",")}`;
				const previous = available.get(key);
				if (previous !== undefined) plans.push({ instruction, replacement: previous });
				else available.set(key, result);
			}
		}
		if (plans.length === 0) return undefined;
		const editor = CoreEditor.open(context.program, fn.id);
		for (const plan of plans)
			editor.replaceInstruction(
				plan.instruction,
				plan.replacement === undefined ? "createUndefined" : "move",
				plan.replacement === undefined ? [] : [plan.replacement],
			);
		return editor.commit();
	},
};
