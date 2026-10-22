import type { CoreCompilationContext } from "../core/core-compilation.ts";
import type { ProgramImage } from "./program-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
	RuntimeImage,
} from "./runtime-image.ts";

type CaptureStorageTransform = (fn: BytecodeFunction, owner: number) => BytecodeFunction;

/** Compact physical capture slots only after unreachable function bodies are gone. */
export function compactCaptureStorage(
	image: ProgramImage,
	context: CoreCompilationContext,
): ProgramImage {
	const transform = captureStorageTransform(image.runtime.functions, context);
	if (transform === undefined) return image;
	return {
		...image,
		runtime: { ...image.runtime, functions: image.runtime.functions.map(transform) },
		native: {
			...image.native,
			functions: image.native.functions.map((fn, index) => ({
				...fn,
				body: transform(fn.body, index),
			})),
		},
	};
}

/** The same compaction for an image that is only interpreted, so both products agree. */
export function compactRuntimeCaptureStorage(
	runtime: RuntimeImage,
	context: CoreCompilationContext,
): RuntimeImage {
	const transform = captureStorageTransform(runtime.functions, context);
	return transform === undefined
		? runtime
		: { ...runtime, functions: runtime.functions.map(transform) };
}

function captureStorageTransform(
	functions: ReadonlyArray<BytecodeFunction>,
	context: CoreCompilationContext,
): CaptureStorageTransform | undefined {
	if (context.facts.closure.sourceClosure.kind !== "known") return undefined;
	if (functions.every((fn) => fn.capturedCount === 0)) return undefined;
	const live = functions.map(() => new Set<number>());
	const retain = (owner: number, index: number): void => {
		// Per-iteration scope identities are independent of the function table.
		if (owner < 0) return;
		const fn = functions[owner];
		if (fn === undefined || index < 0 || index >= fn.capturedCount) {
			throw new Error(`Invalid captured slot ${owner}:${index}`);
		}
		live[owner]!.add(index);
	};
	for (const [owner, fn] of functions.entries()) {
		for (const capture of fn.closureCaptureValues ?? [])
			retain(capture.ownerFunctionIndex, capture.capturedIndex);
		for (const index of fn.mappedArgumentSlots) {
			if (index >= 0) retain(owner, index);
		}
		for (const instruction of fn.instructions) {
			// Dynamic scope has implicit readers that are not LOAD_CAPTURED sites.
			if (instruction.opcode.startsWith("WITH_")) return undefined;
			if (instruction.opcode === "LOAD_CAPTURED") {
				retain(instruction.ownerFunctionIndex, instruction.index);
			} else if (instruction.opcode === "CREATE_PRIVATE_NAMES") {
				for (const index of instruction.capturedIndices) {
					retain(instruction.ownerFunctionIndex, index);
				}
			}
		}
	}
	const layouts = live.map((slots, owner) => {
		if (slots.size === functions[owner]!.capturedCount) return undefined;
		const layout = new Map<number, number>();
		for (const index of [...slots].sort((left, right) => left - right)) {
			layout.set(index, layout.size);
		}
		return layout;
	});
	if (layouts.every((layout) => layout === undefined)) return undefined;
	const remap = (owner: number, index: number): number => {
		const layout = layouts[owner];
		if (owner < 0 || layout === undefined) return index;
		const mapped = layout.get(index);
		if (mapped === undefined)
			throw new Error(`Unretained captured slot ${owner}:${index}`);
		return mapped;
	};
	const instruction = (operation: BytecodeInstruction): BytecodeInstruction => {
		if (operation.opcode === "CREATE_PRIVATE_NAMES") {
			if (layouts[operation.ownerFunctionIndex] === undefined) return operation;
			return {
				...operation,
				capturedIndices: operation.capturedIndices.map((index) =>
					remap(operation.ownerFunctionIndex, index),
				),
			};
		}
		if (operation.opcode !== "LOAD_CAPTURED" && operation.opcode !== "STORE_CAPTURED") {
			return operation;
		}
		const layout = layouts[operation.ownerFunctionIndex];
		if (layout === undefined) return operation;
		if (operation.opcode === "STORE_CAPTURED" && !layout.has(operation.index)) {
			// Preserve IPs, register uses, handlers, and native-plan anchors. Native C
			// removes this self-move; evaluation of the stored value remains intact.
			return { opcode: "MOVE", dst: operation.src, src: operation.src };
		}
		return { ...operation, index: remap(operation.ownerFunctionIndex, operation.index) };
	};
	return (fn, owner) => ({
		...fn,
		capturedCount: layouts[owner]?.size ?? fn.capturedCount,
		mappedArgumentSlots: fn.mappedArgumentSlots.map((index) =>
			index < 0 ? index : remap(owner, index),
		),
		...(fn.closureCaptureValues === undefined
			? {}
			: {
					closureCaptureValues: fn.closureCaptureValues.map((capture) => ({
						...capture,
						capturedIndex: remap(capture.ownerFunctionIndex, capture.capturedIndex),
					})),
				}),
		instructions: fn.instructions.map(instruction),
	});
}
