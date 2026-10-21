import type { CoreCompilationContext } from "../core/core-compilation.ts";
import type { ProgramImage } from "./program-image.ts";
import { withClosureCaptureOwners } from "./runtime-image.ts";

/** Retain external lexical scopes needed by this function or closures it creates. */
export function analyzeClosureCaptures(
	image: ProgramImage,
	context: CoreCompilationContext,
): ProgramImage {
	if (context.facts.closure.sourceClosure.kind !== "known") return image;
	const functions = image.runtime.functions;
	if (
		functions.some((fn) =>
			fn.instructions.some((instruction) => instruction.opcode.startsWith("WITH_")),
		)
	) {
		return image;
	}
	const localOwners = functions.map((fn, index) => {
		const owners = new Set([index]);
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "ENV_PUSH" || instruction.opcode === "ENV_COPY") {
				owners.add(instruction.scopeId);
			}
		}
		return owners;
	});
	const creators = functions.map(() => new Set<number>());
	const captures = functions.map(() => new Set<number>());
	const pending: Array<{ functionIndex: number; owner: number }> = [];
	const retain = (functionIndex: number, owner: number): void => {
		if (localOwners[functionIndex]!.has(owner)) return;
		const required = captures[functionIndex]!;
		if (required.has(owner)) return;
		required.add(owner);
		pending.push({ functionIndex, owner });
	};
	for (const [functionIndex, fn] of functions.entries()) {
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "CREATE_FUNCTION") {
				const targetCreators = creators[instruction.functionIndex];
				if (targetCreators === undefined) {
					throw new Error(`Invalid closure function ${instruction.functionIndex}`);
				}
				targetCreators.add(functionIndex);
			} else if (
				instruction.opcode === "LOAD_CAPTURED" ||
				instruction.opcode === "STORE_CAPTURED" ||
				(instruction.opcode === "CREATE_PRIVATE_NAMES" &&
					instruction.capturedIndices.length > 0)
			) {
				retain(functionIndex, instruction.ownerFunctionIndex);
			}
		}
	}
	// Propagating individual requirements visits each function/owner pair once,
	// including recursive creation graphs and scopes forwarded through many levels.
	let propagated = 0;
	const propagate = () => {
		for (; propagated < pending.length; propagated++) {
			const { functionIndex, owner } = pending[propagated]!;
			for (const creator of creators[functionIndex]!) retain(creator, owner);
		}
	};
	propagate();
	// A layout that skips a scope its creator's chain holds cannot reuse that chain, so
	// closures fall back to capture vectors. Every scope a creator's environment links
	// to stays reachable through it anyway, so naming the skipped scopes costs nothing.
	const creatorOf = (index: number): number | undefined =>
		creators[index]!.size === 1 ? [...creators[index]!][0] : undefined;
	const fillGaps = (index: number): boolean => {
		const owners = captures[index]!;
		if (owners.size < 2) return false;
		const missing = new Set(owners);
		const gaps: Array<number> = [];
		for (
			let ancestor = creatorOf(index);
			ancestor !== undefined && missing.size > 0;
			ancestor = creatorOf(ancestor)
		) {
			if (localOwners[ancestor]!.size !== 1) return false;
			if (!missing.delete(ancestor) && functions[ancestor]!.capturedCount > 0)
				gaps.push(ancestor);
		}
		if (missing.size !== 0) return false;
		const before = owners.size;
		for (const gap of gaps) retain(index, gap);
		return owners.size !== before;
	};
	for (let round = 0, changed = true; changed && round < 4; round++) {
		changed = false;
		for (let index = 0; index < functions.length; index++)
			if (fillGaps(index)) changed = true;
		propagate();
	}
	return {
		...image,
		native: {
			...image.native,
			functions: image.native.functions.map((fn, index) => ({
				...fn,
				body: withClosureCaptureOwners(
					fn.body,
					[...captures[index]!].sort((a, b) => a - b),
				),
			})),
		},
		runtime: {
			...image.runtime,
			functions: functions.map((fn, index) =>
				withClosureCaptureOwners(
					fn,
					[...captures[index]!].sort((left, right) => left - right),
				),
			),
		},
	};
}
