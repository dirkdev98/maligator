import { debugEnabled } from "./compiler/shared/debug-env.ts";

export { debugEnabled };

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
