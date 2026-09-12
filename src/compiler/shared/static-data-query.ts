export const staticDataQueryKinds = [
	"includes",
	"has-own",
	"index-of",
	"last-index-of",
] as const;

export type StaticDataQueryKind = (typeof staticDataQueryKinds)[number];

export function staticDataQueryTag(kind: StaticDataQueryKind): number {
	return staticDataQueryKinds.indexOf(kind);
}
