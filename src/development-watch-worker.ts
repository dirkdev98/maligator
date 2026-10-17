import type { TaskContext } from "maligator:workers";

const mal = Reflect.get(globalThis, "mal") as unknown as {
	_waitDevelopmentChange(directories: Array<string>, timeoutMs: number): void;
};

/**
 * Block until a watched directory changes or the timeout passes. It runs on a
 * worker because the wait is synchronous: on the coordinator it would stall the
 * compilation and application events of a rebuild in flight.
 */
export function waitForChange(
	_context: TaskContext,
	directories: Array<string>,
	timeoutMs: number,
): void {
	mal._waitDevelopmentChange(directories, timeoutMs);
}
