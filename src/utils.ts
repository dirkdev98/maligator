export function isNil(value: unknown): value is null | undefined {
	return value === null || value === undefined;
}

// `typeof` guard so this module loads on MalVm too (the self-hosted compiler),
// where there is no `process` global — `typeof process` is then "undefined".
export const debugEnabled =
	typeof process !== "undefined" && process.env.MAL_DEBUG === "true";

export const log = {
	debug(args: unknown, depth: number | null = null) {
		if (!debugEnabled) {
			return;
		}

		if (typeof args === "string") {
			this.info(args);
		} else {
			this.dir(args, depth);
		}
	},
	time(label: string) {
		if (!debugEnabled) return () => {};
		console.time(label);
		return () => console.timeEnd(label);
	},
	info(args: unknown) {
		// oxlint-disable-next-line no-console
		console.log(args);
	},
	dir(arg: unknown, depth: number | null = null) {
		console.dir(arg, { colors: true, depth });
	},
};
