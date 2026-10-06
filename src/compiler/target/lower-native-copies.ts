import type { CoreRepresentation } from "../core/core-ir.ts";
import type {
	CoreTargetMove,
	CoreTargetRegisterRepresentation,
} from "./core-target-ir.ts";
import type { CoreParallelCopyLowerer } from "./lower-core-target.ts";

export function createNativeParallelCopyLowerer(
	nextRegister: { value: number },
	representations: Map<number, CoreRepresentation>,
	canonicalRepresentations: ReadonlyMap<number, CoreTargetRegisterRepresentation>,
	variants: ReadonlyArray<ReadonlyMap<number, CoreTargetRegisterRepresentation>>,
): CoreParallelCopyLowerer {
	const scratches = new Map<string, number>();
	const temporaryRepresentations = new Map<
		number,
		ReadonlyArray<CoreTargetRegisterRepresentation>
	>();
	return {
		temporaryRepresentations,
		lower(assignments) {
			const pending = new Map(
				assignments
					.filter(({ destination, source }) => destination !== source)
					.map(({ destination, source }) => [destination, source]),
			);
			const readers = new Map<number, Set<number>>();
			const addReader = (source: number, destination: number): void => {
				const destinations = readers.get(source) ?? new Set();
				destinations.add(destination);
				readers.set(source, destinations);
			};
			for (const [destination, source] of pending) addReader(source, destination);
			const ready = [...pending.keys()].filter(
				(destination) => !readers.get(destination)?.size,
			);
			const moves: Array<CoreTargetMove> = [];
			const used = new Set<number>();
			let cursor = 0;
			while (pending.size > 0) {
				while (cursor < ready.length) {
					const destination = ready[cursor++]!;
					const source = pending.get(destination);
					if (source === undefined) continue;
					moves.push({ type: "move", registers: [destination, source] });
					pending.delete(destination);
					const destinations = readers.get(source)!;
					destinations.delete(destination);
					if (destinations.size === 0 && pending.has(source)) ready.push(source);
				}
				if (pending.size === 0) break;
				const saved = pending.keys().next().value!;
				const representation = representations.get(saved);
				if (representation === undefined)
					throw new Error(`Native parallel copy lacks a representation for r${saved}`);
				const profile = variants.map((variant) => variant.get(saved)!);
				const key = [canonicalRepresentations.get(saved)!, ...profile].join(":");
				let scratch = scratches.get(key);
				if (scratch === undefined) {
					scratch = nextRegister.value++;
					scratches.set(key, scratch);
					representations.set(scratch, representation);
					temporaryRepresentations.set(scratch, profile);
				}
				used.add(scratch);
				moves.push({ type: "move", registers: [scratch, saved] });
				// No scratch read remains when ready moves have drained the previous cycle.
				for (const destination of readers.get(saved)!) {
					pending.set(destination, scratch);
					addReader(scratch, destination);
				}
				readers.delete(saved);
				ready.push(saved);
			}
			return { moves, temporaries: [...used] };
		},
	};
}
