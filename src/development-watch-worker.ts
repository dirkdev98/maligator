import type { TaskContext } from "maligator:workers";

const mal = (
	globalThis as unknown as {
		mal: { _waitDevelopmentChange(directories: Array<string>, timeoutMs: number): void };
	}
).mal;

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
