export const DIRECT_EVAL_PRIVATE_STATIC = 1;
export const DIRECT_EVAL_PRIVATE_FIELD = 2;
export const DIRECT_EVAL_PRIVATE_METHOD = 4;
export const DIRECT_EVAL_PRIVATE_GETTER = 8;
export const DIRECT_EVAL_PRIVATE_SETTER = 16;

export interface DirectEvalPrivateNameContext {
	name: string;
	flags: number;
}

export interface DirectEvalContext {
	allowSuperProperty: boolean;
	allowSuperCall: boolean;
	hasInstanceInitializer: boolean;
	allowNewTarget: boolean;
	privateNames: Array<DirectEvalPrivateNameContext>;
	varConflictNames: Array<string>;
}

export type DirectEvalPrivateSlot = "brand" | "field" | "method" | "get" | "set";

const DIRECT_EVAL_CONTEXT_SEPARATOR = "\0";

export function encodeDirectEvalContext(context: DirectEvalContext): string {
	const flags =
		(context.allowSuperProperty ? 1 : 0) |
		(context.allowNewTarget ? 2 : 0) |
		(context.allowSuperCall ? 4 : 0) |
		(context.hasInstanceInitializer ? 8 : 0);
	return [
		String(flags),
		...context.privateNames.map((entry) => `${entry.flags}:${entry.name}`),
		...[...new Set(context.varConflictNames)].map((name) => `v:${name}`),
	].join(DIRECT_EVAL_CONTEXT_SEPARATOR);
}

export function decodeDirectEvalContext(encoded: string | undefined): DirectEvalContext {
	const parts = encoded ? encoded.split(DIRECT_EVAL_CONTEXT_SEPARATOR) : ["0"];
	const flags = Number(parts[0]);
	const privateNames: Array<DirectEvalPrivateNameContext> = [];
	const varConflictNames = new Set<string>();
	for (let index = 1; index < parts.length; index++) {
		const part = parts[index]!;
		const separator = part.indexOf(":");
		if (separator < 0) {
			throw new SyntaxError("Invalid inherited direct-eval context");
		}
		if (part.slice(0, separator) === "v") {
			const name = part.slice(separator + 1);
			if (!name) {
				throw new SyntaxError("Invalid inherited direct-eval context");
			}
			varConflictNames.add(name);
			continue;
		}
		privateNames.push({
			flags: Number(part.slice(0, separator)),
			name: part.slice(separator + 1),
		});
	}
	return {
		allowSuperProperty: (flags & 1) !== 0,
		allowNewTarget: (flags & 2) !== 0,
		allowSuperCall: (flags & 4) !== 0,
		hasInstanceInitializer: (flags & 8) !== 0,
		privateNames,
		varConflictNames: [...varConflictNames],
	};
}

export function directEvalHomeScopeKey(): string {
	return "\0maligator.eval.home";
}

export function directEvalScopeObjectKey(): string {
	return "\0maligator.eval.scope";
}

export function directEvalDirtyTrackerKey(): string {
	return "\0maligator.eval.dirty";
}

export function directEvalSuperConstructorScopeKey(): string {
	return "\0maligator.eval.super.constructor";
}

export function directEvalSuperThisStateScopeKey(): string {
	return "\0maligator.eval.super.this";
}

export function directEvalSuperNewTargetScopeKey(): string {
	return "\0maligator.eval.super.newTarget";
}

export function directEvalInstanceInitializerScopeKey(): string {
	return "\0maligator.eval.super.initialize";
}

export function directEvalPrivateScopeKey(
	index: number,
	slot: DirectEvalPrivateSlot,
): string {
	return `\0maligator.eval.private.${index}.${slot}`;
}
