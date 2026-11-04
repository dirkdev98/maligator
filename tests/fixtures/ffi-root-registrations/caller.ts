import * as c from "maligator:ffi/lifetime";
import * as plain from "maligator:ffi/plain";
import { createWorkerUrl, Worker } from "maligator:workers";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
async function failure(action: () => unknown, type: typeof Error): Promise<void> {
	let caught: unknown;
	try {
		await action();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof type, `caller initialization failure: ${String(caught)}`);
}
function rejects(action: () => unknown): boolean {
	try {
		action();
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}
function cycle(): void {
	const root = c.CallerRoot();
	c.caller_init_void(root, 449);
	c.caller_subscribe(root, () => c.caller_value(root));
}
function lastUse(): string | null {
	const state = plain.PlainState();
	return plain.plain_init(state);
}
export async function checkCallerInitialization(collect: () => void): Promise<void> {
	{
		const before = c.life_destroyed(),
			root = c.CallerRoot();
		check(
			c.caller_echo(root) === root,
			"an ordinary result echo preserves caller storage identity",
		);
		check(
			rejects(() => c.caller_cleanup(root)) &&
				rejects(() => c.caller_subscribe(root, () => 1)),
			"uninitialized caller storage rejects cleanup and registration before C",
		);
		root[Symbol.dispose]();
		check(
			c.life_destroyed() === before,
			"uninitialized disposal frees only outer storage",
		);
	}
	for (const invoke of [c.caller_init, c.callerInitAsync]) {
		{
			const root = c.CallerRoot(),
				before = c.life_destroyed();
			check(
				(await invoke(root, 457, 1)).result === -1,
				"failed native initialization remains unarmed",
			);
			check(
				(await invoke(root, 457, 0)).result === 0,
				"failed initialization can be retried",
			);
			const entries = c.caller_entries();
			await failure(() => invoke(root, 461, 0), TypeError);
			check(c.caller_entries() === entries, "repeated initialization rejects before C");
			const closes = c.caller_close_entries();
			check(
				rejects(() => c.caller_close_view(root, () => {})) &&
					c.caller_close_entries() === closes,
				"alias types cannot bypass managed caller cleanup admission",
			);
			c.caller_subscribe(root, () => {
				check(
					rejects(() => root[Symbol.dispose]()),
					"active caller-root callback pins its owner",
				);
				return c.caller_value(root);
			});
			check(
				c.life_fire(root.child!) === 457,
				"initialized caller storage owns direct-root callbacks",
			);
			root[Symbol.dispose]();
			check(
				c.life_destroyed() === before + 1,
				"caller disposal cleans C state before freeing storage",
			);
		}
		{
			const root = c.CallerRoot(),
				before = c.life_destroyed();
			await invoke(root, 463, 1);
			root[Symbol.dispose]();
			check(c.life_destroyed() === before, "failed initialization needs no C cleanup");
		}
		for (const mode of [2, 3]) {
			const root = c.CallerRoot(),
				before = c.life_destroyed();
			root.data = new Uint8Array([3, 5]);
			await failure(() => invoke(root, 467, mode), RangeError);
			root[Symbol.dispose]();
			check(
				c.life_destroyed() === before + 1,
				"native success arms cleanup before output or managed-state validation fails",
			);
		}
	}
	for (const invoke of [c.caller_init_callback, c.callerInitCallbackAsync]) {
		const root = c.CallerRoot(),
			before = c.life_destroyed();
		await failure(
			() =>
				invoke(root, () => {
					throw new RangeError("initializer callback");
				}),
			RangeError,
		);
		root[Symbol.dispose]();
		check(
			c.life_destroyed() === before + 1,
			"callback failure cannot discard successful native initialization",
		);
	}
	for (const invoke of [c.caller_init_late, c.callerInitLateAsync]) {
		const root = c.CallerRoot(),
			entries = c.caller_entries(),
			before = c.life_destroyed();
		let pinned = false;
		await failure(
			() =>
				invoke(root, {
					get value(): never {
						pinned = rejects(() => root[Symbol.dispose]());
						throw new RangeError("later initializer input");
					},
				}),
			RangeError,
		);
		check(
			pinned && c.caller_entries() === entries,
			"initializer inputs pin storage through later getters without entering C on failure",
		);
		await invoke(root, { value: 509 });
		root[Symbol.dispose]();
		check(
			c.life_destroyed() === before + 1,
			"failed argument conversion leaves initialization retryable",
		);
	}
	for (const invoke of [c.caller_init_void, c.callerInitVoidAsync]) {
		const root = c.CallerRoot(),
			before = c.life_destroyed();
		await Promise.resolve(invoke(root, 479));
		const child = root.child!;
		c.life_subscribe(child, () => c.caller_value(root));
		check(
			c.life_fire(child) === 479,
			"initialized caller parents anchor child registrations",
		);
		c.caller_cleanup(root);
		check(
			c.life_destroyed() === before + 1 && rejects(() => c.life_value(child)),
			"explicit caller cleanup retires registrations and child views",
		);
	}
	{
		const root = c.CallerRoot(),
			before = c.life_destroyed();
		const pending = c.callerInitAsync(root, 487, 4);
		await failure(() => c.callerInitAsync(root, 491, 0), TypeError);
		check(
			rejects(() => root[Symbol.dispose]()),
			"pending initialization exclusively owns its storage",
		);
		await pending;
		await c.callerCleanupAsync(root);
		check(
			c.life_destroyed() === before + 1,
			"async initialization and cleanup each settle once",
		);
	}
	{
		const before = c.life_destroyed();
		Reflect.apply(cycle, undefined, []);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		for (let index = 0; index < 8 && c.life_destroyed() === before; index++) collect();
		check(
			c.life_destroyed() === before + 1,
			"collection releases a caller-storage callback cycle",
		);
	}
	{
		const before = plain.plain_destroyed();
		check(
			Reflect.apply(lastUse, undefined, []) === "plain",
			"direct initialization keeps its last-used input alive through result allocation",
		);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		for (let index = 0; index < 8 && plain.plain_destroyed() === before; index++)
			collect();
		check(
			plain.plain_destroyed() === before + 1,
			"direct initializer cleanup responsibility survives collection",
		);
	}
	for (const mode of ["success", "failure", "queued", "lease"]) {
		const before = c.life_destroyed(),
			initialized = c.caller_inits(),
			started = c.caller_started();
		const worker = new Worker(createWorkerUrl("./caller-worker.ts", import.meta.url));
		const admitted = new Promise<void>((resolve) => {
			worker.port.onmessage = () => resolve();
		});
		worker.port.start();
		await worker.ready;
		worker.port.postMessage(mode);
		await admitted;
		if (mode === "success" || mode === "failure")
			while (c.caller_started() === started)
				await new Promise((resolve) => {
					setTimeout(resolve, 1);
				});
		await worker.terminate();
		if (mode === "lease") {
			check(
				c.life_destroyed() === before &&
					c.caller_live_value() === 499 &&
					c.caller_live_byte() === 39 &&
					c.life_held_child_fire() === 0,
				"independent child leases preserve caller storage and retained bytes after VM teardown",
			);
			await c.clearChildAsync();
			check(
				c.life_destroyed() === before + 1 && c.caller_live_value() === -1,
				"foreign final release cleans caller state, callbacks and outer storage once",
			);
		} else
			check(
				c.life_destroyed() - before === c.caller_inits() - initialized,
				"undelivered and cancelled initializers clean exactly the native states they acquired",
			);
	}
}
