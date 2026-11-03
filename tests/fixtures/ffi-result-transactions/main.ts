/* oxlint-disable no-console -- Reports observable conversion and ownership behavior. */
import * as c from "maligator:ffi/transactions";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
async function rangeFailure(action: () => unknown): Promise<void> {
	let caught: unknown;
	try {
		await action();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof RangeError, "preserves the conversion error");
}
for (const invoke of [c.tx_pair, c.pairAsync]) {
	for (const distinct of [0, 1]) {
		const before = c.tx_destroyed();
		await rangeFailure(() => invoke(1, distinct));
		check(
			c.tx_destroyed() === before + 1 + distinct,
			"failed new outputs release each resource once",
		);
		const result = await invoke(0, distinct);
		check(
			result.message === "x" && c.tx_read(result.result!) === 17,
			"successful outputs remain usable",
		);
		check(
			(result.result === result.other) === (distinct === 0),
			"output identity follows native aliasing",
		);
		result.result![Symbol.dispose]();
		if (distinct !== 0) result.other![Symbol.dispose]();
		check(
			c.tx_destroyed() === before + 2 * (1 + distinct),
			"successful outputs retain ordinary disposal",
		);
	}
}
for (const invoke of [c.tx_existing, c.existingAsync]) {
	for (const borrowed of [false, true]) {
		const prior = borrowed ? c.tx_borrow(31) : c.tx_create(31);
		const before = c.tx_destroyed();
		await rangeFailure(() => invoke(1));
		check(
			c.tx_destroyed() === before && c.tx_read(prior!) === 31,
			"failed output preserves a prior alias",
		);
		prior![Symbol.dispose]();
		check(
			c.tx_destroyed() === before + (borrowed ? 0 : 1),
			"failed output preserves prior ownership",
		);
		c.tx_clear();
	}
	const prior = c.tx_borrow(37);
	const before = c.tx_destroyed();
	const result = await invoke(0);
	check(
		result.result === prior && result.other === prior,
		"successful adoption keeps canonical identity",
	);
	result.result![Symbol.dispose]();
	check(c.tx_destroyed() === before + 1, "successful conversion commits ownership");
}
for (const invoke of [c.tx_borrowed_result, c.borrowedResultAsync]) {
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(1));
	check(
		c.tx_destroyed() === before + 1,
		"an earlier borrowed output joins the owned claim",
	);
	const result = await invoke(0);
	check(
		result.result === result.owned && c.tx_read(result.owned!) === 23,
		"borrowed and owned outputs share the committed wrapper",
	);
	result.owned![Symbol.dispose]();
	check(c.tx_destroyed() === before + 2, "borrowed-first output ownership commits once");
}
const failNextCell = (
	globalThis as typeof globalThis & { __mal_fail_next_cell_allocation?: () => void }
).__mal_fail_next_cell_allocation;
if (failNextCell !== undefined) {
	const prior = c.tx_borrow(41);
	const before = c.tx_destroyed();
	let caught: unknown;
	try {
		Reflect.apply(c.tx_arm, undefined, [failNextCell]);
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof Error && caught.message === "Out of memory",
		"later handle allocation failure remains observable",
	);
	check(
		c.tx_read(prior!) === 41 && c.tx_destroyed() === before + 1,
		"later allocation failure releases only the newly returned resource",
	);
	prior![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 1,
		"later allocation failure leaves borrowed ownership unchanged",
	);
	c.tx_clear();
}
for (const invoke of [c.tx_existing, c.existingAsync]) {
	const prior = c.tx_base(53);
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(1));
	check(c.tx_base_read(prior!) === 53, "failed conversion preserves the original view");
	let caught: unknown;
	try {
		Reflect.apply(c.tx_read, undefined, [prior]);
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof TypeError,
		"failed conversion does not publish an additional type view",
	);
	const result = await invoke(0);
	check(
		result.result === prior && Reflect.apply(c.tx_read, undefined, [prior]) === 53,
		"successful conversion publishes its additional view",
	);
	result.result![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 1,
		"successful view adoption acquires ownership once",
	);
}
for (const invoke of [c.tx_invalid, c.invalidAsync]) {
	const state = c.TxManaged();
	state.data = new Uint8Array(4);
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(state));
	check(
		c.tx_destroyed() === before + 1,
		"final managed input validation rolls back resource output",
	);
	state[Symbol.dispose]();
}
console.log("result transactions passed");
