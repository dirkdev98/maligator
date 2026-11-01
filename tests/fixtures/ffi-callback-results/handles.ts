/* oxlint-disable no-console -- The fixture reports observable native lease behavior. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
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
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

for (const invoke of [c.result_handle, c.result_handle_async]) {
	let first: c.ResultResource | undefined;
	const result = await invoke((index) => {
		if (index === 0) {
			first = c.result_resource_new(77)!;
			return first;
		}
		collect();
		rejects(() => first![Symbol.dispose](), "leased resource cannot be disposed");
		rejects(() => c.result_resource_free(first!), "leased resource cannot be destroyed");
		return c.result_resource_new(88);
	});
	check(
		result === first && c.result_resource_value(result) === 77,
		"result preserves canonical ownership",
	);
	result[Symbol.dispose]();
	collect();
	const before = c.result_resource_freed();
	const ephemeral = await invoke((index) => {
		if (index === 1) {
			collect();
			check(
				c.result_resource_freed() === before,
				"earlier native results survive collection",
			);
		}
		return c.result_resource_new(index === 0 ? 77 : 88);
	});
	check(
		c.result_resource_value(ephemeral!) === 77,
		"collected callback result remains usable after alias conversion",
	);
	ephemeral![Symbol.dispose]();
}
for (const invoke of [c.result_state, c.result_state_async]) {
	let first: ReturnType<typeof c.ResultState> | undefined;
	const result = await invoke((index) => {
		if (index === 0) {
			first = c.ResultState();
			first.bytes = new Uint8Array([5, 0, 7]);
			first.text = "Grü\0";
			return first;
		}
		collect();
		rejects(() => {
			first!.bytes = new Uint8Array([9]);
		}, "leased state prevents backing-store replacement");
		rejects(() => {
			void first!.text;
		}, "leased state prevents concurrent reads");
		rejects(() => first![Symbol.dispose](), "leased state cannot free its storage");
		return c.ResultState();
	});
	check(
		result === first && first.bytes!.join() === "5,0,7" && first.text === "Grü\0",
		"state lease ends after output conversion",
	);
	first.bytes = new Uint8Array([5, 0, 7]);
	first.text = "Grü\0";
	check(
		(await invoke(() => first!)) === first,
		"repeated publication refreshes backing stores after an earlier lease",
	);
	first[Symbol.dispose]();
}
rejects(
	() => c.result_lend_handle((loan) => loan!),
	"callback loans cannot escape as native results",
);
check(
	c.result_handle(() => null) === null,
	"nullable handle result does not acquire a lease",
);
console.log("handle callback results passed");
