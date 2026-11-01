/* oxlint-disable no-console -- The fixture reports callback delivery and process completion. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	CallerState,
	caller_state_init,
	caller_state_cleanup,
	caller_state_listen,
	caller_state_emit,
	caller_state_emit_thread,
} from "maligator:ffi/state";

function check(value: boolean): void {
	if (!value) throw new Error("caller callback lifetime failed");
}

function register(listener: (event: number) => void, dispose: boolean): void {
	const state = CallerState();
	check(caller_state_init(state, 7) === 0);
	caller_state_listen(state, listener);
	caller_state_emit(state, 1);
	check(caller_state_emit_thread(state, 2) === 0);
	caller_state_cleanup(state);
	if (dispose) state[Symbol.dispose]();
}

export async function run(dispose: boolean): Promise<void> {
	setFlagsFromString("--expose-gc");
	const collectGarbage = runInNewContext("gc") as () => void;
	const events: Array<number> = [];
	let finish!: () => void;
	const received = new Promise<void>((resolve) => {
		finish = resolve;
	});
	// A completed setup job leaves no native call-frame roots for explicit collection.
	await Promise.resolve().then(() => {
		register((event) => {
			events.push(event);
			if (event === 2) finish();
		}, dispose);
	});
	check(events.join(",") === "1");
	collectGarbage();
	await received;
	check(events.join(",") === "1,2");
	console.log("caller callback released");
}
