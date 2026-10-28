// Must match MAL_STATIC_DATA_QUERY_POLL_INTERVAL in runtime/src/vm_ops.h.
export const STATIC_DATA_QUERY_POLL_INTERVAL = 1024;

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
