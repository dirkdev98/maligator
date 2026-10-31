/* oxlint-disable no-console -- The fixture reports its results on standard output. */
import {
	shapes_add_async,
	shapes_bounds_async,
	shapes_canvas_lend,
	shapes_canvas_open,
	shapes_canvas_title_async,
	shapes_checksum_async,
	shapes_describe_async,
	shapes_hold_async,
	shapes_join_async,
	shapes_parse_async,
	shapes_set_ticker,
	shapes_tick,
	shapes_unwatch,
	shapes_watch,
	shapes_watch_call,
	shapes_watch_fire,
	shapes_watch_later,
} from "maligator:ffi/shapes";

// C calls on a worker thread: what they use stays pinned until their promise settles.
async function runAsync(): Promise<void> {
	console.log(
		`async checksum ${await shapes_checksum_async(new Uint8Array([1, 2, 3, 250]))}`,
	);
	console.log(`async describe ${await shapes_describe_async({ x: 1.5, y: -2 })}`);
	console.log(`async parse ${JSON.stringify(await shapes_parse_async("3,4"))}`);
	console.log(
		`async add ${JSON.stringify(await shapes_add_async({ x: 1, y: 2 }, { x: 3, y: 4 }))}`,
	);
	console.log(
		`async arrays ${await shapes_join_async(["one", "two"])} ${JSON.stringify(
			await shapes_bounds_async([
				{ x: 1, y: 2 },
				{ x: 3, y: 0 },
			]),
		)}`,
	);
	using canvas = shapes_canvas_open("Async")!;
	console.log(
		`async title ${await shapes_canvas_title_async(canvas)} ${await shapes_canvas_title_async(null)}`,
	);
	const held = new ArrayBuffer(4, { maxByteLength: 8 });
	new Uint8Array(held).set([5, 6, 7, 8]);
	const pending = shapes_hold_async(canvas, held, 50);
	const blocked = [
		() => held.transfer(),
		() => held.resize(2),
		() => canvas[Symbol.dispose](),
	].map((attempt) => {
		try {
			attempt();
			return "allowed";
		} catch (error) {
			return (error as Error).name;
		}
	});
	console.log(`async hold ${await pending} ${blocked.join(",")} ${held.byteLength}`);
	try {
		await shapes_checksum_async("text" as unknown as Uint8Array);
	} catch (error) {
		console.log(`async rejected ${(error as Error).message}`);
	}
	// A library thread's calls queue for this thread; calls made here run at once.
	const watched: Array<string> = [];
	shapes_watch((event, label) => {
		watched.push(`${event}:${label}`);
	});
	shapes_watch_fire(3);
	const queued = watched.length;
	shapes_watch_call(9);
	await new Promise((resolve) => {
		setTimeout(resolve, 20);
	});
	shapes_unwatch();
	console.log(`queued ${queued} ${watched.join(",")}`);
	const ticks: Array<number> = [];
	shapes_set_ticker((tick) => {
		ticks.push(tick);
	});
	shapes_tick(2);
	await new Promise((resolve) => {
		setTimeout(resolve, 20);
	});
	shapes_set_ticker(null);
	console.log(`ticks ${ticks.join(",")}`);
	// An async call outlives the callback a handle is lent to, so it refuses it.
	let lent: Promise<unknown> = Promise.resolve();
	shapes_canvas_lend(canvas, (_, temporary) => {
		lent = shapes_canvas_title_async(temporary);
	});
	try {
		await lent;
	} catch (error) {
		console.log(`async lent ${(error as Error).message}`);
	}
	// The event loop waits for a call a library thread makes later.
	shapes_watch((event, label) => {
		console.log(`later ${event}:${label}`);
		shapes_unwatch();
	});
	shapes_watch_later(7, 50);
}
void runAsync();
