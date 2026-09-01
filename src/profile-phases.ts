export const PROFILE_PHASE_NAMES = [
	"graph",
	"semantic",
	"construct core ir",
	"optimize core ir",
	"core to execution",
	"execution to image",
	"serialize",
] as const;

export type ProfilePhaseName = (typeof PROFILE_PHASE_NAMES)[number];

/** Stable one-based IDs written to the raw profile event stream. */
export function profilePhaseId(phase: ProfilePhaseName): number {
	return PROFILE_PHASE_NAMES.indexOf(phase) + 1;
}

export function profilePhaseName(id: number): string {
	return PROFILE_PHASE_NAMES[id - 1] ?? `phase-${id}`;
}
