/* oxlint-disable no-console -- The fixture reports observable registration leases. */
import * as c from "maligator:ffi/results";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function rejects(action: () => void, message: string): void {
	let rejected = false;
	try {
		action();
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(rejected, message);
}
for (const asynchronous of [false, true]) {
	const resource = c.result_resource_new(77)!;
	if (asynchronous) await c.result_keep_resource_async(() => resource);
	else c.result_keep_resource(() => resource);
	check(
		(await c.result_kept_resource_call_async(0)) === resource,
		"registration preserves the resource owner",
	);
	rejects(() => resource[Symbol.dispose](), "retained resource cannot be disposed");
	rejects(
		() => c.result_resource_free(resource),
		"retained resource cannot be destroyed",
	);
	await c.result_kept_resource_clear_async();
	resource[Symbol.dispose]();
}
const state = c.ResultState();
state.bytes = new Uint8Array([5, 0, 7]);
state.text = "Grü\0";
const base = c.result_state_base(state)!;
await c.result_keep_state_async(() => state);
check(
	(await c.result_kept_state_call_async(0)) === state,
	"registration preserves caller storage",
);
check(
	(await c.result_kept_state_call_async(1)) === state,
	"one managed resource can supply repeated results",
);
rejects(() => {
	state.bytes = null;
}, "retained state rejects backing-store changes");
rejects(() => {
	void state.text;
}, "retained state excludes concurrent reads");
rejects(() => {
	c.result_state_tag(base);
}, "managed view C calls share result exclusion");
await c.result_kept_state_clear_async();
check(
	state.text === "Grü\0" && state.bytes.join() === "5,0,7",
	"release restores access to managed state",
);
state[Symbol.dispose]();

const late = c.result_resource_new(77)!;
c.result_keep_resource(() => {
	c.result_kept_resource_clear();
	return late;
});
rejects(() => {
	c.result_kept_resource_call(0);
}, "self-release rejects a new native resource lease");
late[Symbol.dispose]();

const previous = c.result_resource_new(77)!;
const next = c.result_resource_new(88)!;
await c.result_replace_resource_async(() => previous);
check(
	(await c.result_replaced_resource_call_async(0)) === previous,
	"replacement owns its native result lease",
);
rejects(() => previous[Symbol.dispose](), "replacement result remains leased");
await c.result_replace_resource_async(() => next);
previous[Symbol.dispose]();
check(
	c.result_replaced_resource_call(0) === next,
	"new registration survives retiring the previous owner",
);
c.result_replace_resource(() => {
	c.result_replace_resource(() => next);
	return next;
});
rejects(() => {
	c.result_replaced_resource_call(0);
}, "reentrant replacement rejects publication into the retired registration");
check(c.result_replaced_resource_call(0) === next, "new result region remains usable");
c.result_replace_resource(null);
next[Symbol.dispose]();
const owner = c.result_resource_new(77)!;
c.result_replace_owned(owner, () => owner);
rejects(() => {
	c.result_replaced_owned_call();
}, "a keyed registration cannot lease its own owner");
c.result_replace_owned(owner, null);
const independent = c.result_resource_new(88)!;
c.result_replace_owned(owner, () => independent);
check(
	c.result_replaced_owned_call() === independent,
	"a keyed registration can lease an independent resource",
);
c.result_replace_owned(owner, null);
independent[Symbol.dispose]();
owner[Symbol.dispose]();
console.log("retained handle callback results passed");
