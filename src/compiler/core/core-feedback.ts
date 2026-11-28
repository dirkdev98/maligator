import type { FeedbackSiteValue } from "../../feedback/dump.ts";
import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import { probeReadKindIsNamed } from "../shared/compiler-instruction.ts";
import type { ProbeReadKind } from "../shared/compiler-instruction.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

/** What a feedback file says about a program, as its source functions name it. */
export interface CoreFeedbackProjection {
	/** Hash of the matched, combined sites; absent when nothing matched. */
	readonly hash: string | undefined;
	/** Matched function origin to its applied site keys (`<offset>:<op>:<key>`). */
	readonly functions: ReadonlyMap<string, ReadonlyMap<string, FeedbackSiteValue>>;
	readonly matched: number;
	/** Recorded at another revision of the function. */
	readonly stale: number;
	/** Recorded for a function this program doesn't have. */
	readonly absent: number;
}

/**
 * Feedback matched to a program before lowering, keyed by source position so it
 * survives inlining and cloning: a Core instruction's position names its source
 * function's file even in an inlined copy, exactly as the recorder attributed it.
 */
export interface CoreFeedback {
	readonly projection: CoreFeedbackProjection;
	/** Every source function of the program with a known identity: origin to revision. */
	readonly identities: ReadonlyMap<string, string>;
	/** `coreFeedbackPositionKey` to `<op>:<key>` to the combined value. */
	readonly sites: ReadonlyMap<string, ReadonlyMap<string, FeedbackSiteValue>>;
	readonly recordedSites: number;
}

export interface CoreFeedbackSource {
	/**
	 * Match against `semantic` after module linking and before lowering, the point
	 * where source function origins are captured.
	 */
	resolve(semantic: SemanticProgram): CoreFeedback;
}

export function coreFeedbackPositionKey(
	sourcePath: string,
	line: number,
	column: number,
): string {
	return `${sourcePath}\n${line}:${column}`;
}

/** The recorder's op and key for a Core instruction that owns a property inline cache. */
export function corePropertyFeedbackSite(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): { readonly op: "get" | "set"; readonly key: string } | undefined {
	const decode = (index: unknown) => {
		const units = typeof index === "number" ? program.stringConstants[index] : undefined;
		return units === undefined ? undefined : String.fromCodePoint(...units);
	};
	const named = () => decode(fn.instructionAttributes(instruction).stringIndex);
	// Construction lowers `a.b` to a computed access with a constant key, which
	// optimization later makes static; the recorder saw the static form.
	const constantKey = () => {
		const key = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1);
		if (fn.kernel.valueDefinitionKind(key) !== 1) return "*";
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(key));
		return fn.instructionOpcodeName(definition) === "createString"
			? (decode(fn.instructionAttributes(definition).stringIndex) ?? "*")
			: "*";
	};
	switch (fn.instructionOpcodeName(instruction)) {
		case "loadProperty":
			return { op: "get", key: constantKey() };
		case "storeProperty":
			return { op: "set", key: constantKey() };
		case "loadPropertyStatic":
		case "loadPropertyStaticShapeCase": {
			const key = named();
			return key === undefined ? undefined : { op: "get", key };
		}
		case "storePropertyStatic": {
			const key = named();
			return key === undefined ? undefined : { op: "set", key };
		}
		case "probeRead": {
			const kind = fn.instructionAttributes(instruction).readKind as ProbeReadKind;
			const key = probeReadKindIsNamed(kind) ? named() : undefined;
			return key === undefined ? undefined : { op: "get", key };
		}
		default:
			return undefined;
	}
}

function propertyFeedbackAt(
	feedback: CoreFeedback,
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): { readonly position: string; readonly site: string } | undefined {
	if (feedback.sites.size === 0) return undefined;
	const site = corePropertyFeedbackSite(program, fn, instruction);
	const positionId = fn.instructionSourcePosition(instruction);
	if (site === undefined || positionId === undefined) return undefined;
	const position = program.sourcePositionAt(positionId);
	if (position === undefined) return undefined;
	const inlined = position.inlinedFunctionIndex as CoreFunctionId | undefined;
	if (inlined !== undefined && !program.hasFunction(inlined)) return undefined;
	const owner = inlined === undefined ? fn : program.function(inlined);
	return {
		position: coreFeedbackPositionKey(
			owner.metadata.sourcePath,
			position.line,
			position.column,
		),
		site: `${site.op}:${site.key}`,
	};
}

/** The combined feedback recorded at a property get or set site, if any. */
export function corePropertyFeedback(
	feedback: CoreFeedback | undefined,
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): FeedbackSiteValue | undefined {
	if (feedback === undefined) return undefined;
	const at = propertyFeedbackAt(feedback, program, fn, instruction);
	return at === undefined ? undefined : feedback.sites.get(at.position)?.get(at.site);
}

/** Recorded sites that some Core instruction names, and how many instructions do. */
export function attachedCoreFeedbackSites(
	feedback: CoreFeedback,
	program: CoreProgram,
): {
	readonly sites: ReadonlyMap<string, FeedbackSiteValue>;
	readonly instructions: number;
} {
	const sites = new Map<string, FeedbackSiteValue>();
	let instructions = 0;
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const block of fn.blockIds()) {
			for (const instruction of fn.bodyInstructionIds(block)) {
				const at = propertyFeedbackAt(feedback, program, fn, instruction);
				if (at === undefined) continue;
				const value = feedback.sites.get(at.position)?.get(at.site);
				if (value === undefined) continue;
				instructions++;
				sites.set(`${at.position}\n${at.site}`, value);
			}
		}
	}
	return { sites, instructions };
}

export interface CoreFeedbackReport {
	readonly matched: number;
	readonly stale: number;
	readonly absent: number;
	readonly recordedSites: number;
	/** Recorded sites with an instruction after construction. */
	readonly constructed: number;
	/** Recorded sites with an instruction after optimization. */
	readonly attached: number;
	readonly instructions: number;
	/** Attached sites per value class: shapes, dictionary, megamorphic or `mode <name>`. */
	readonly classes: Readonly<Record<string, number>>;
}

function valueClass(value: FeedbackSiteValue): string {
	if ("megamorphic" in value) return "megamorphic";
	if ("dictionary" in value) return "dictionary";
	if ("mode" in value) return `mode ${value.mode}`;
	return "shapes";
}

export function coreFeedbackReport(
	feedback: CoreFeedback,
	constructed: number,
	optimized: ReturnType<typeof attachedCoreFeedbackSites>,
): CoreFeedbackReport {
	const classes = new Map<string, number>();
	for (const value of optimized.sites.values()) {
		const name = valueClass(value);
		classes.set(name, (classes.get(name) ?? 0) + 1);
	}
	return {
		matched: feedback.projection.matched,
		stale: feedback.projection.stale,
		absent: feedback.projection.absent,
		recordedSites: feedback.recordedSites,
		constructed,
		attached: optimized.sites.size,
		instructions: optimized.instructions,
		classes: Object.fromEntries(
			[...classes].sort(([left], [right]) => (left < right ? -1 : 1)),
		),
	};
}

export function formatCoreFeedbackReport(report: CoreFeedbackReport): string {
	const classes =
		Object.entries(report.classes)
			.map(([name, count]) => `${name}=${count}`)
			.join(", ") || "none";
	return `${report.matched} functions matched/${report.stale} stale/${report.absent} absent, ${report.recordedSites} recorded sites, ${report.constructed} attached after construction, ${report.attached} after optimization on ${report.instructions} instructions (${classes})`;
}
