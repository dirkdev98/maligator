/* oxlint-disable no-console -- The fixture reports observable native behavior. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import * as c from "maligator:ffi/close";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function refuses(action: () => void): void {
	let refused = false;
	try {
		action();
	} catch (error) {
		refused = error instanceof TypeError;
	}
	check(refused, "operation must refuse a closing or closed handle");
}
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

const state = c.CloseState();
const backing = new ArrayBuffer(24);
new Uint8Array(backing).fill(71);
state.bytes = new Uint8Array(backing, 3, 11);
let completed = false;
c.close_later(state, (handle) => {
	check(handle === state, "completion preserves canonical view identity");
	refuses(() => c.close_read(handle));
	check(backing.transfer().byteLength === 24, "completion retires retained buffer pins");
	state[Symbol.dispose]();
	completed = true;
});
refuses(() => c.close_read(state));
refuses(() => state[Symbol.dispose]());
refuses(() => backing.transfer());
collect();
c.close_flush();
check(completed, "deferred completion runs");

const immediate = c.CloseState();
let immediateDone = false;
c.close_now(immediate, (handle) => {
	check(handle === immediate, "immediate completion preserves identity");
	immediateDone = true;
});
check(immediateDone, "immediate completion runs");
refuses(() => c.close_read(immediate));

const thrown = c.CloseState();
let caught = false;
try {
	c.close_now(thrown, () => {
		throw new Error("completion failed");
	});
} catch (error) {
	caught = error instanceof Error && error.message === "completion failed";
}
check(caught, "completion exceptions propagate through the enclosing C call");
refuses(() => c.close_read(thrown));

const invalid = c.CloseState();
refuses(() => c.close_now(invalid, null as never));
check(
	c.close_read(invalid) === 0,
	"failed callback preparation leaves the handle usable",
);
c.close_visit(invalid, (handle) => {
	check(handle !== null, "C passes the active handle");
	refuses(() => c.close_now(handle, () => {}));
});
check(c.close_read(invalid) === 0, "overlapping call rejection leaves the handle usable");
c.close_data(invalid, (status) =>
	check(status === 17, "user data routes one-shot completion"),
);
refuses(() => c.close_read(invalid));

let lentDone = false;
c.close_lend((handle) => {
	check(handle !== null, "C lends a handle");
	c.close_later(handle, (closed) => {
		check(closed === handle, "a closing loan retains its canonical wrapper");
		lentDone = true;
	});
});
collect();
c.close_flush();
check(lentDone, "callback close extends the loan until completion");

const poisoned = c.CloseState();
Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	get() {
		throw new Error("array prototype reached");
	},
});
try {
	c.close_now(poisoned, () => {});
} finally {
	delete (Array.prototype as unknown as Record<string, unknown>)["0"];
}
refuses(() => c.close_read(poisoned));

const pending = c.CloseState();
const pendingBytes = new ArrayBuffer(8);
pending.bytes = pendingBytes;
let pendingCalled = false;
caught = false;
try {
	c.close_with_error(
		pending,
		() => {
			throw new Error("before completion");
		},
		() => {
			pendingCalled = true;
		},
	);
} catch (error) {
	caught = error instanceof Error && error.message === "before completion";
}
check(caught && !pendingCalled, "pending exceptions suppress JavaScript completion");
refuses(() => c.close_read(pending));
check(
	pendingBytes.transfer().byteLength === 8,
	"suppressed completion still retires pins",
);

const reused = c.close_reused_open();
check(reused !== null, "C opens a reusable resource");
let replacement: typeof reused | undefined;
let replacementCalls = 0;
c.close_reused_set(reused, () => {
	c.close_now(reused, () => {
		replacement = c.close_reused_open()!;
		check(replacement !== reused, "a new C lifetime gets a new wrapper");
		c.close_reused_set(replacement, () => {
			replacementCalls++;
		});
	});
});
c.close_reused_emit();
check(replacement !== undefined, "close runs inside an active replaced callback");
c.close_reused_emit();
check(replacementCalls === 1, "old close cannot retire the new lifetime's callbacks");
c.close_now(replacement, () => {});

const unheld = (() => {
	const value = c.CloseState();
	const weak = new WeakRef(value);
	c.close_later(value, (closed) =>
		check(closed === weak.deref(), "pending close roots its canonical wrapper"),
	);
	return weak;
})();
await new Promise<void>((resolve) => {
	setTimeout(resolve, 0);
});
collect();
check(unheld.deref() !== undefined, "a pending close survives without a caller root");
c.close_flush();

const foreign = c.CloseState();
await new Promise<void>((resolve) => {
	c.close_foreign(foreign, (handle) => {
		check(handle === foreign, "foreign completion preserves canonical identity");
		refuses(() => c.close_read(handle));
		resolve();
	});
});
console.log("close callbacks passed");
