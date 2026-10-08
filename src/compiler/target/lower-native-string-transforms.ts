import {
	COMPILER_VALUE_KIND_STRING,
	compilerBuiltinInputKindsAreValid,
} from "../shared/compiler-value-kinds.ts";
import { stringCaseLocale } from "../shared/string-case-locale.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import { decodeVmValueOperand } from "./runtime-image.ts";

export const NATIVE_STRING_TRANSFORM_KINDS = [
	"html",
	"trim",
	"is-well-formed",
	"to-well-formed",
	"normalize",
	"case",
] as const;
export const NATIVE_STRING_NORMALIZATION_FORMS = ["NFC", "NFD", "NFKC", "NFKD"] as const;
export const NATIVE_STRING_CASE_LOCALES = ["root", "turkic", "lithuanian"] as const;
export const NATIVE_STRING_HTML_TAGS = [
	"a",
	"big",
	"blink",
	"b",
	"tt",
	"font",
	"i",
	"small",
	"strike",
	"sub",
	"sup",
] as const;
export const NATIVE_STRING_HTML_ATTRIBUTES = ["name", "color", "size", "href"] as const;

interface NativeStringTransformSite {
	readonly instructionIp: number;
	readonly receiver: "string" | "guarded";
	readonly fallback: "original-call";
}

export type NativeStringTransformPlan = NativeStringTransformSite &
	(
		| {
				readonly kind: "html";
				readonly tag: (typeof NATIVE_STRING_HTML_TAGS)[number];
				readonly attribute?: (typeof NATIVE_STRING_HTML_ATTRIBUTES)[number];
		  }
		| { readonly kind: "trim"; readonly start: boolean; readonly end: boolean }
		| { readonly kind: "is-well-formed" | "to-well-formed" }
		| {
				readonly kind: "normalize";
				readonly form: (typeof NATIVE_STRING_NORMALIZATION_FORMS)[number];
		  }
		| {
				readonly kind: "case";
				readonly upper: boolean;
				readonly locale: (typeof NATIVE_STRING_CASE_LOCALES)[number];
		  }
	);

const HTML_TRANSFORMS: Readonly<
	Record<
		string,
		readonly [
			(typeof NATIVE_STRING_HTML_TAGS)[number],
			(typeof NATIVE_STRING_HTML_ATTRIBUTES)[number]?,
		]
	>
> = {
	anchor: ["a", "name"],
	big: ["big"],
	blink: ["blink"],
	bold: ["b"],
	fixed: ["tt"],
	fontcolor: ["font", "color"],
	fontsize: ["font", "size"],
	italics: ["i"],
	link: ["a", "href"],
	small: ["small"],
	strike: ["strike"],
	sub: ["sub"],
	sup: ["sup"],
};

export function selectNativeStringTransform(
	native: NativeFunctionPlan,
	instructionIp: number,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): NativeStringTransformPlan | undefined {
	const op = native.body.instructions[instructionIp];
	if (
		op?.opcode !== "CALL_KNOWN" ||
		op.construct ||
		op.argumentMode !== undefined ||
		!op.operation.startsWith("String.prototype.")
	)
		return undefined;
	const method = op.operation.slice("String.prototype.".length);
	const receiver = decodeVmValueOperand(op.thisValue);
	const proof = native.instructions[instructionIp];
	const site: NativeStringTransformSite = {
		instructionIp,
		receiver:
			receiver.kind === "string" ||
			(receiver.kind === "register" &&
				native.registerRepresentations[receiver.register] === "string") ||
			(proof?.kind === "exact-builtin-input-kinds" &&
				compilerBuiltinInputKindsAreValid(
					proof.inputKindMasks,
					op.arguments.length + 1,
				) &&
				proof.inputKindMasks[0] === COMPILER_VALUE_KIND_STRING)
				? "string"
				: "guarded",
		fallback: "original-call",
	};
	const html = Object.hasOwn(HTML_TRANSFORMS, method)
		? HTML_TRANSFORMS[method]
		: undefined;
	if (html !== undefined)
		return {
			...site,
			kind: "html",
			tag: html[0],
			...(html[1] === undefined ? {} : { attribute: html[1] }),
		};
	if (["trim", "trimStart", "trimLeft", "trimEnd", "trimRight"].includes(method))
		return {
			...site,
			kind: "trim",
			start: method !== "trimEnd" && method !== "trimRight",
			end: method !== "trimStart" && method !== "trimLeft",
		};
	if (method === "isWellFormed") return { ...site, kind: "is-well-formed" };
	if (method === "toWellFormed") return { ...site, kind: "to-well-formed" };
	if (
		![
			"normalize",
			"toUpperCase",
			"toLowerCase",
			"toLocaleUpperCase",
			"toLocaleLowerCase",
		].includes(method)
	)
		return undefined;
	const first = op.arguments[0];
	const decoded = first === undefined ? undefined : decodeVmValueOperand(first);
	const absent = decoded === undefined || decoded.kind === "undefined";
	const units = decoded?.kind === "string" ? stringConstants[decoded.index] : undefined;
	const parameter =
		units === undefined || units.length > 16 ? undefined : String.fromCharCode(...units);
	if (method === "normalize") {
		const form = absent ? "NFC" : parameter;
		const selected = NATIVE_STRING_NORMALIZATION_FORMS.find(
			(candidate) => candidate === form,
		);
		return selected === undefined
			? undefined
			: { ...site, kind: "normalize", form: selected };
	}
	const selected =
		method.includes("Locale") && !absent
			? parameter === undefined
				? undefined
				: stringCaseLocale(parameter)
			: "und";
	if (selected === undefined) return undefined;
	return {
		...site,
		kind: "case",
		upper: method.includes("Upper"),
		locale: selected === "tr" ? "turkic" : selected === "lt" ? "lithuanian" : "root",
	};
}

export function nativeStringTransformPlansMatch(
	stored: ReadonlyArray<NativeStringTransformPlan>,
	selected: ReadonlyArray<NativeStringTransformPlan>,
): boolean {
	return (
		stored.length === selected.length &&
		stored.every((plan, index) => {
			const expected = selected[index]!;
			if (
				plan.instructionIp !== expected.instructionIp ||
				plan.receiver !== expected.receiver ||
				plan.fallback !== expected.fallback
			)
				return false;
			switch (plan.kind) {
				case "html":
					return (
						expected.kind === "html" &&
						plan.tag === expected.tag &&
						plan.attribute === expected.attribute
					);
				case "trim":
					return (
						expected.kind === "trim" &&
						plan.start === expected.start &&
						plan.end === expected.end
					);
				case "normalize":
					return expected.kind === "normalize" && plan.form === expected.form;
				case "case":
					return (
						expected.kind === "case" &&
						plan.upper === expected.upper &&
						plan.locale === expected.locale
					);
				default:
					return plan.kind === expected.kind;
			}
		})
	);
}
