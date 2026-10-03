import { transfer } from "maligator:workers";

let counter = 0;
export function increment(context, amount) {
	context.throwIfCancelled();
	counter += amount;
	return counter;
}
export function sum(context, values) {
	context.throwIfCancelled();
	let value = 0;
	for (const number of values) value += number;
	return value;
}
export function buffer(context, bytes) {
	context.throwIfCancelled();
	bytes[0]++;
	return transfer(bytes, [bytes.buffer]);
}
export function port(context, endpoint) {
	context.throwIfCancelled();
	return transfer(endpoint, [endpoint]);
}
export function spin(context, started) {
	Atomics.store(started, 0, 1);
	for (;;) context.throwIfCancelled();
}
export async function delay(context, value) {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, 20);
		context.signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(context.signal.reason);
			},
			{ once: true },
		);
	});
	context.throwIfCancelled();
	return value;
}

export async function awaitCancellation(context, started) {
	Atomics.store(started, 0, 1);
	await new Promise((resolve, reject) => {
		context.signal.addEventListener("abort", () => reject(context.signal.reason), {
			once: true,
		});
	});
}

export function uncloneableFailure() {
	throw () => {};
}
