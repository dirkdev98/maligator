/* oxlint-disable no-console -- Reports observable registration ownership. */
import * as c from "maligator:ffi/lifetime";
import { createWorkerUrl, Worker } from "maligator:workers";
import { checkCopied } from "./copied.ts";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function throws(action: () => unknown): void {
	let rejected = false;
	try {
		action();
	} catch (error) {
		rejected = error instanceof Error;
	}
	check(rejected, "operation rejects while the resource is in use");
}
throws(() => c.life_subscribe(null, () => 1));
{
	const destroyed = c.life_destroyed();
	const root = c.life_new(11)!;
	const child = root.child!;
	c.life_subscribe(child, () => {
		throws(() => root[Symbol.dispose]());
		return c.life_value(child);
	});
	check(c.life_fire(child) === 11, "active callback reads its child and pins its root");
	root[Symbol.dispose]();
	check(
		c.life_destroyed() === destroyed + 1,
		"root disposal releases a child registration without unregistration",
	);
	throws(() => c.life_value(child));
}
{
	const root = c.life_new(12)!;
	const child = root.child!;
	c.life_replace(child, () => 1);
	c.life_replace(child, () => {
		c.life_replace(child, () => 3);
		return 2;
	});
	check(
		c.life_fire(child) === 2 && c.life_fire(child) === 3,
		"replacement during a callback preserves the active generation",
	);
	root[Symbol.dispose]();
}
{
	const root = c.retry_new(13)!;
	const child = root.child!;
	c.life_subscribe(child, () => 13);
	throws(() => root[Symbol.dispose]());
	check(
		c.life_fire(child) === 13,
		"conditional destruction failure preserves the registration",
	);
	c.retry_allow(root);
	root[Symbol.dispose]();
}
{
	const root = c.life_new(14)!;
	c.life_subscribe(root.child, () => 14);
	c.life_keep_root(() => root);
	throws(() => root[Symbol.dispose]());
	c.life_clear_root();
	root[Symbol.dispose]();
}
{
	const root = c.life_new(15)!;
	const child = root.child!;
	await c.subscribeQueuedAsync(child, () => {
		throws(() => root[Symbol.dispose]());
		return c.life_value(child);
	});
	check(
		(await c.fireThreadAsync(child)) === 15,
		"queued callbacks retain active-use protection",
	);
	await c.destroyAsync(root);
}
const collect = (globalThis as typeof globalThis & { __mal_collect_garbage?: () => void })
	.__mal_collect_garbage;
check(collect !== undefined, "collection hook is available");
{
	const root = c.life_new(17)!;
	let calls = 0;
	c.life_subscribe_notice(root.child!, () => {
		calls++;
	});
	c.life_post(root.child!);
	root[Symbol.dispose]();
	collect();
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
	check(calls === 0, "queued calls skip a registration whose root was destroyed");
}
{
	const root = c.life_new(18)!;
	c.life_subscribe_result(root.child!, () => root);
	throws(() => c.life_fire_result(root.child!));
	root[Symbol.dispose]();
}
function cycle(): void {
	const root = c.life_new(16)!;
	const child = root.child!;
	c.life_subscribe(child, () => c.life_value(root.child!));
}
{
	const destroyed = c.life_destroyed();
	// A dispatched frame must unwind before conservative collection can release its locals.
	Reflect.apply(cycle, undefined, []);
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
	for (let index = 0; index < 8 && c.life_destroyed() === destroyed; index++) collect();
	check(
		c.life_destroyed() === destroyed + 1,
		"collection reclaims a registration closure that captures its root",
	);
}
{
	const destroyed = c.life_destroyed();
	const worker = new Worker(createWorkerUrl("./retained-worker.ts", import.meta.url));
	const admitted = new Promise<void>((resolve) => {
		worker.port.onmessage = () => resolve();
	});
	worker.port.start();
	await worker.ready;
	worker.port.postMessage(null);
	await admitted;
	await worker.terminate();
	check(
		c.life_held_value() === 77 && c.life_held_fire() === 0,
		"native leases survive worker teardown while callbacks detach",
	);
	check(
		c.life_destroyed() === destroyed,
		"external result lease still owns the root after teardown",
	);
	c.life_clear_root();
	check(
		c.life_destroyed() === destroyed + 1,
		"last independent lease destroys the root and its registrations",
	);
}
await checkCopied(collect);
console.log("root registrations passed");
