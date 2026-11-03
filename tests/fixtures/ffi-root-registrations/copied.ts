import * as c from "maligator:ffi/lifetime";
import { createWorkerUrl, Worker } from "maligator:workers";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function rejects(action: () => unknown): void {
	let rejected = false;
	try {
		action();
	} catch (error) {
		rejected = error instanceof Error;
	}
	check(rejected, "operation rejects without releasing live copied storage");
}
function cycle(): void {
	const root = c.copied_new(89);
	c.copied_subscribe(root, () => c.copied_value(root));
}
export async function checkCopied(collect: () => void): Promise<void> {
	for (const direct of [true, false]) {
		const before = c.life_destroyed();
		const root = c.copied_new(83);
		const child = root.child!;
		const callback = () => {
			rejects(() => root[Symbol.dispose]());
			return c.copied_value(root);
		};
		if (direct) c.copied_subscribe(root, callback);
		else c.life_subscribe(child, callback);
		check(
			c.life_fire(child) === 83,
			"copied roots stay pinned through direct and child-owned callbacks",
		);
		root[Symbol.dispose]();
		check(
			c.life_destroyed() === before + 1,
			"copied root disposal stops registrations before freeing storage",
		);
		rejects(() => c.life_value(child));
	}
	{
		const before = c.life_destroyed();
		const root = c.copied_new(109);
		const child = root.child!;
		c.copied_subscribe(root, () => c.copied_value(root));
		c.life_keep_child(() => child);
		rejects(() => root[Symbol.dispose]());
		check(
			c.life_held_child_value() === 109,
			"independent child leases block copied root disposal",
		);
		c.life_clear_child();
		c.copied_destroy(root);
		check(
			c.life_destroyed() === before + 1 && c.copied_live_value() === -1,
			"the explicit copied destructor releases registration and storage after leases end",
		);
	}
	{
		const root = c.manual_copy_new(97);
		const entries = c.copied_entries(),
			before = c.life_destroyed();
		rejects(() => c.manual_copy_subscribe(root, () => 97));
		check(
			c.copied_entries() === entries && c.life_value(root.child!) === 97,
			"non-collecting copied roots reject registration before C",
		);
		root[Symbol.dispose]();
		check(
			c.life_destroyed() === before + 1,
			"rejected copied registration preserves explicit disposal",
		);
	}
	{
		const root = c.retry_copy_new(101);
		const entries = c.copied_entries(),
			before = c.life_destroyed();
		rejects(() => c.retry_copy_subscribe(root, () => 101));
		rejects(() => root[Symbol.dispose]());
		check(
			c.copied_entries() === entries && c.life_value(root.child!) === 101,
			"conditional copied cleanup remains outside registration ownership",
		);
		c.retry_copy_allow(root);
		root[Symbol.dispose]();
		check(
			c.life_destroyed() === before + 1,
			"conditional copied cleanup keeps its existing retry behavior",
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
			c.life_destroyed() === before + 1 && c.copied_live_value() === -1,
			"collection releases a copied storage registration cycle",
		);
	}
	{
		const before = c.life_destroyed();
		const worker = new Worker(createWorkerUrl("./copied-worker.ts", import.meta.url));
		const admitted = new Promise<void>((resolve) => {
			worker.port.onmessage = () => resolve();
		});
		worker.port.start();
		await worker.ready;
		worker.port.postMessage(null);
		await admitted;
		await worker.terminate();
		check(
			c.life_held_child_value() === 107 &&
				c.copied_live_value() === 107 &&
				c.life_held_child_fire() === 0 &&
				c.life_destroyed() === before,
			"a child lease keeps copied outer storage alive after VM teardown",
		);
		await c.clearChildAsync();
		check(
			c.life_destroyed() === before + 1 && c.copied_live_value() === -1,
			"foreign final release destroys copied storage and callbacks once without a VM",
		);
	}
}
