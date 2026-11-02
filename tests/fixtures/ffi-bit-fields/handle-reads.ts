/* oxlint-disable no-console -- The fixture reports its public FFI result. */
import {
	FlagState,
	fields_advance_async,
	fields_advance_many_async,
	fields_observe,
} from "maligator:ffi/fields";

function check(value: boolean): void {
	if (!value) throw new Error("Unexpected state field value");
}
function busy(read: () => unknown): void {
	try {
		read();
	} catch (error) {
		if (error instanceof TypeError) return;
		throw error;
	}
	throw new Error("Field read succeeded during a worker operation");
}
const state = FlagState();
fields_observe(state, () => check(state.count === 0n && state.generation === 0));
for (const start of [
	() => fields_advance_async(state),
	() => fields_advance_many_async([state, state]),
]) {
	const pending = start();
	busy(() => state.count);
	busy(() => state.generation);
	await pending;
	check(state.count === BigInt(state.generation));
}
check(state.count === 3n && state.generation === 3);
state[Symbol.dispose]();
console.log("handle reads passed");
