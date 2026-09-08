import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export type CoreStringPart =
	| string
	| { readonly value: CoreValueId }
	| {
			readonly callback: CoreValueId;
			readonly match: CoreValueId;
			readonly position: number;
			readonly source: CoreValueId;
	  };

export function coreStaticStringReplacementParts(
	analysis: CoreStaticValueAnalysis,
	operation: string,
	inputs: ReadonlyArray<CoreValueId>,
): ReadonlyArray<CoreStringPart> | undefined {
	const [source, match, callback] = inputs;
	if (source === undefined || match === undefined || callback === undefined)
		return undefined;
	const receiver = analysis.constant(source),
		needle = analysis.constant(match),
		replacer = analysis.query(callback);
	if (
		receiver?.kind !== "string" ||
		needle?.kind !== "string" ||
		replacer.kind !== "known" ||
		replacer.brand !== "function" ||
		(receiver.value.length + 1) * (needle.value.length + 1) > 4096
	)
		return undefined;
	const parts: Array<CoreStringPart> = [];
	let end = 0,
		count = 0;
	for (let start = 0; start <= receiver.value.length; ) {
		const position = receiver.value.indexOf(needle.value, start);
		if (position < 0) break;
		if (++count > 64) return undefined;
		parts.push(receiver.value.slice(end, position), {
			callback,
			match,
			position,
			source,
		});
		end = position + needle.value.length;
		if (operation === "String.prototype.replace") break;
		start = position + Math.max(1, needle.value.length);
	}
	parts.push(receiver.value.slice(end));
	return parts;
}

export function coreStaticStringRawParts(
	program: CoreProgram,
	fn: CoreFunctionStore,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
	inputs: ReadonlyArray<CoreValueId>,
): ReadonlyArray<CoreStringPart> | undefined {
	const template = inputs[1];
	if (template === undefined || fn.kernel.valueUseCount(template) !== 1) return undefined;
	const fact = analysis.queryAt(template, instruction);
	if (fact.kind !== "known" || !fact.privateUntilObservation) return undefined;
	const description = program.staticDescriptions.description(fact.description);
	if (description.kind !== "object") return undefined;
	const raw = description.properties.find((property) => property.key === "raw");
	if (raw?.descriptor.kind !== "data") return undefined;
	const member = raw.descriptor.value;
	let literalId;
	let operands = fact.operands;
	if (member.kind === "allocation") literalId = member.description;
	else if (member.kind === "operand") {
		const rawValue = fact.operands[member.index];
		if (
			rawValue === undefined ||
			fn.kernel.valueDefinitionKind(template) !== 1 ||
			fn.kernel.valueHandlerUseCount(rawValue) !== 0 ||
			fn.kernel.valueUseCount(rawValue) > 128
		)
			return undefined;
		const owner = coreInstructionId(fn.kernel.valueDefinitionOwner(template));
		if (fn.instructionOpcodeName(owner) !== "createObjectShaped") return undefined;
		const before = new Set<CoreInstructionId>();
		for (const prior of fn.instructionIds(fn.instructionBlock(owner))) {
			if (prior === owner) break;
			if (before.size >= 4096) return undefined;
			before.add(prior);
		}
		// The array escapes only into this single-use template, after its data definitions.
		for (
			let use = fn.kernel.valueFirstUse(rawValue);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			const user = fn.kernel.useInstruction(use);
			if (
				user !== owner &&
				!(
					before.has(user) &&
					fn.instructionOpcodeName(user) === "defineProperty" &&
					fn.kernel.useOperand(use) === 0
				)
			)
				return undefined;
		}
		const rawFact = analysis.queryAt(rawValue, owner);
		if (rawFact.kind !== "known" || !rawFact.privateUntilObservation) return undefined;
		literalId = rawFact.description;
		operands = rawFact.operands;
	} else return undefined;
	const literals = program.staticDescriptions.description(literalId);
	if (literals.kind !== "array" || literals.length === null || literals.length > 64)
		return undefined;
	const properties = new Map(
		literals.properties.map((property) => [property.key, property]),
	);
	const parts: Array<CoreStringPart> = [""];
	let size = 0;
	const append = (text: string) => {
		size += text.length;
		const last = parts[parts.length - 1];
		if (typeof last === "string") parts[parts.length - 1] = last + text;
		else parts.push(text);
	};
	for (let index = 0; index < literals.length; index++) {
		const property = properties.get(String(index));
		if (property?.descriptor.kind !== "data") return undefined;
		const element = property.descriptor.value;
		const value =
			element.kind === "constant"
				? analysis.descriptionConstant(element.description)
				: element.kind === "operand"
					? analysis.constant(operands[element.index]!)
					: undefined;
		const converted = evaluateConstantBuiltin("String", undefined, [value]);
		if (converted.kind !== "value" || converted.value.kind !== "string") return undefined;
		append(converted.value.value);
		const substitution = inputs[index + 2];
		if (index + 1 < literals.length && substitution !== undefined) {
			const constant = evaluateConstantBuiltin("String", undefined, [
				analysis.constant(substitution),
			]);
			if (constant.kind === "value" && constant.value.kind === "string")
				append(constant.value.value);
			else parts.push({ value: substitution });
		}
		if (size > 4096) return undefined;
	}
	return parts;
}
