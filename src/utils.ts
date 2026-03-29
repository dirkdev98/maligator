export function isNil(value: unknown): value is null | undefined {
	return value === null || value === undefined;
}

const debug = process.env.MAL_DEBUG === "true";

export const log = {
	debug(args: unknown, depth: number | null = null) {
		if (!debug) {
			return;
		}

		if (typeof args === "string") {
			this.info(args);
		} else {
			this.dir(args, depth);
		}
	},
	time(label: string) {
		console.time(label);
		return () => console.timeEnd(label);
	},
	info(args: unknown) {
		// eslint-disable-next-line no-console
		console.log(args);
	},
	dir(arg: unknown, depth: number | null = null) {
		console.dir(arg, { colors: true, depth });
	},
};
