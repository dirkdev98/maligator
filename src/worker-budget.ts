import * as os from "node:os";

export function workerCount(
	configured: string | undefined,
	name: string,
	fallback: number,
	limit = os.availableParallelism(),
): number {
	const count = configured === undefined ? fallback : Number(configured);
	if (
		(configured !== undefined && !/^\d+$/.test(configured)) ||
		!Number.isSafeInteger(count) ||
		count < 1
	)
		throw new Error(`${name} must be a positive integer`);
	return Math.min(count, Math.max(1, limit));
}

export function workerBudget(
	configured: string | undefined,
	available = os.availableParallelism(),
): number {
	return workerCount(
		configured,
		"MALIGATOR_WORKERS",
		Math.max(1, Math.floor(available / 2)),
		available,
	);
}

export function buildWorkerCount(
	environment: NodeJS.ProcessEnv,
	variable: "MAL_BUILD_JOBS" | "CARGO_BUILD_JOBS",
	fallback: number,
): number {
	const limit =
		environment.MALIGATOR_WORKERS === undefined
			? os.availableParallelism()
			: workerBudget(environment.MALIGATOR_WORKERS);
	return workerCount(
		environment[variable],
		variable,
		environment.MALIGATOR_WORKERS === undefined ? fallback : limit,
		limit,
	);
}

export function workerEnvironment(workers: number): NodeJS.ProcessEnv {
	const count = String(workers);
	return {
		MALIGATOR_WORKERS: count,
		MAL_BUILD_JOBS: count,
		CARGO_BUILD_JOBS: count,
		MAL_SANITIZER_WORKERS: count,
		T262_COMPILE_WORKERS: count,
		UV_THREADPOOL_SIZE: count,
		RUST_TEST_THREADS: count,
		RAYON_NUM_THREADS: count,
		GOMAXPROCS: count,
	};
}
