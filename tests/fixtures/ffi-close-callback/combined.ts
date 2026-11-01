/* oxlint-disable no-console -- The fixture reports observable C completion. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import * as c from "maligator:ffi/close";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
const view = c.CloseState();
let viewed = false;
c.close_view_set(view, (base) => {
	viewed = base === view;
});
check(viewed, "compatible handle views preserve a replacement key");
c.close_now(view, () => {});
let calls = 0;
const weak: Array<WeakRef<(value: c.CloseBase | null) => void>> = [];
function closeNested(): void {
	const first = c.close_reused_open()!;
	const listener = (_value: c.CloseBase | null) => {
		calls++;
	};
	weak.push(new WeakRef(listener));
	c.close_and_listen(
		first,
		() => {
			const second = c.close_reused_open()!;
			check(second !== first, "a reused address has a fresh wrapper");
			const next = (_value: c.CloseBase | null) => {
				calls++;
			};
			weak.push(new WeakRef(next));
			c.close_and_listen(second, () => {}, next);
		},
		listener,
	);
}
closeNested();
check(calls === 2, "a fresh lifetime can register before the previous setter returns");
await new Promise<void>((resolve) => {
	setTimeout(resolve, 0);
});
collect();
check(
	weak.every((reference) => reference.deref() === undefined),
	"completion retires both listener roots",
);

const blockers = Array.from({ length: 64 }, () => c.close_block_async());
c.close_wait_blocked();
let replacement: c.CloseBase | undefined;
let registration: Promise<void> | undefined;
let emitted = 0;
try {
	c.close_and_listen(
		c.close_reused_open()!,
		() => {
			replacement = c.close_reused_open()!;
			registration = c.close_reused_set_async(replacement, () => {
				emitted++;
			});
		},
		() => {},
	);
} finally {
	c.close_unblock();
}
check(
	registration !== undefined && replacement !== undefined,
	"completion schedules the fresh registration",
);
await registration;
await Promise.all(blockers);
c.close_reused_emit();
check(emitted === 1, "an old completion preserves a newer queued reservation");
c.close_now(replacement, () => {});
console.log("combined close callbacks passed");
