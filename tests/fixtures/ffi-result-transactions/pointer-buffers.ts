import * as c from "maligator:ffi/transactions";
import { createWorkerUrl, Worker } from "maligator:workers";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function rejects(action: () => unknown): boolean {
	try {
		action();
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}
async function rangeFailure(action: () => unknown): Promise<void> {
	let caught: unknown;
	try {
		await action();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof RangeError, `pointer buffer error: ${String(caught)}`);
}

export async function checkPointerBuffers(): Promise<void> {
	for (const invoke of [c.tx_pointer_buffer, c.pointerBufferAsync]) {
		for (const mode of [2, 3, 4]) {
			const before = c.tx_destroyed();
			await rangeFailure(() => invoke(4n, mode, null));
			check(
				c.tx_destroyed() === before + 2,
				"failed owned pointer buffers release distinct resources once",
			);
		}
		const before = c.tx_destroyed();
		check(
			(await invoke(0n, 0, null)).rows.length === 0 &&
				(await invoke(4n, 5, null)).rows.length === 0 &&
				c.tx_destroyed() === before,
			"empty pointer buffers allocate no pointees",
		);
		for (const mode of [0, 1]) {
			const value = await invoke(4n, mode, null);
			check(
				value.rows.length === (mode === 0 ? 4 : 1) && c.tx_read(value.rows[0]!) === 353,
				"owned pointer buffers return their written prefix",
			);
			if (mode === 0)
				check(
					value.rows[0] === value.rows[2] && value.rows[3] === null,
					"pointer slots preserve aliases and nulls",
				);
			value.rows[0]![Symbol.dispose]();
			if (mode === 0) value.rows[1]![Symbol.dispose]();
		}
		check(
			c.tx_destroyed() === before + 3,
			"owned pointer buffers commit one destructor per resource",
		);
	}
	for (const invoke of [c.tx_pointer_borrowed, c.pointerBorrowedAsync]) {
		for (const mode of [2, 3, 4]) {
			const before = c.tx_destroyed();
			await rangeFailure(() => invoke(4n, mode, null));
			check(
				c.tx_destroyed() === before && c.tx_pointer_bank_value() === 353,
				"failed borrowed buffers leave pointees owned by C",
			);
			c.tx_pointer_clear();
			check(c.tx_destroyed() === before + 2, "C can release failed borrowed pointees");
		}
		{
			const before = c.tx_destroyed();
			const value = await invoke(4n, 0, null);
			check(
				value.rows[0] === value.rows[2] && value.rows[3] === null,
				"borrowed pointer slots preserve identities",
			);
			value.rows[0]![Symbol.dispose]();
			value.rows[1]![Symbol.dispose]();
			check(
				c.tx_destroyed() === before && c.tx_pointer_bank_value() === 353,
				"disposing borrowed wrappers leaves C resources alive",
			);
			c.tx_pointer_clear();
			check(
				c.tx_destroyed() === before + 2,
				"borrowed resources retain their native owner",
			);
		}
		{
			const prior = c.tx_create(373)!;
			const before = c.tx_destroyed();
			const value = await invoke(4n, 0, prior);
			check(value.rows[0] === prior, "borrowed buffer preserves an existing owned alias");
			prior[Symbol.dispose]();
			value.rows[1]![Symbol.dispose]();
			check(
				c.tx_destroyed() === before + 1,
				"borrowed output does not downgrade prior ownership",
			);
			c.tx_pointer_clear();
			check(
				c.tx_destroyed() === before + 2,
				"C owns only the new borrowed buffer resource",
			);
		}
	}
	for (const invoke of [
		c.tx_pointer_return,
		c.pointerReturnAsync,
		() => c.tx_pointer_out().rows,
		async () => (await c.pointerOutAsync()).rows,
	]) {
		const before = c.tx_destroyed(),
			tables = c.tx_tables_freed();
		const value = (await invoke())!;
		check(
			value.length === 4 &&
				value[0] === value[2] &&
				value[3] === null &&
				c.tx_tables_freed() === tables + 1,
			"borrowed pointer tables release their outer allocation",
		);
		value[0]![Symbol.dispose]();
		value[1]![Symbol.dispose]();
		check(
			c.tx_destroyed() === before && c.tx_pointer_bank_value() === 353,
			"outer table release does not adopt pointees",
		);
		c.tx_pointer_clear();
		check(c.tx_destroyed() === before + 2, "C table pointees remain independently owned");
	}
	for (const invoke of [c.tx_pointer_mixed, c.pointerMixedAsync]) {
		const before = c.tx_special_destroyed();
		await rangeFailure(() => invoke(4n, 1));
		check(
			c.tx_special_destroyed() === before + 1,
			"borrowed-first pointer rollback uses its owning companion policy",
		);
		const value = await invoke(4n, 0);
		check(
			value.rows[0] === value.rows[1] &&
				value.rows[0] === value.owned &&
				value.rows[0]![Symbol.toStringTag] === "TxBase",
			"pointer buffers preserve first canonical metadata across owning aliases",
		);
		value.owned![Symbol.dispose]();
		check(
			c.tx_special_destroyed() === before + 2,
			"pointer buffer adoption retains the companion destructor",
		);
	}
	for (const invoke of [c.tx_pointer_existing, c.pointerExistingAsync]) {
		const prior = c.tx_base(431)!,
			before = c.tx_destroyed();
		await rangeFailure(() => invoke(4n, 1));
		check(
			rejects(() => Reflect.apply(c.tx_read, undefined, [prior])) &&
				c.tx_base_read(prior) === 431,
			"failed borrowed pointer conversion does not publish an additional view",
		);
		const result = await invoke(4n, 0);
		check(
			result.rows[0] === prior &&
				Reflect.apply(c.tx_read, undefined, [prior]) === 431 &&
				prior[Symbol.toStringTag] === "TxBase",
			"successful borrowed pointer conversion publishes its view and keeps canonical metadata",
		);
		prior[Symbol.dispose]();
		check(
			c.tx_destroyed() === before,
			"borrowed view publication preserves prior ownership",
		);
		c.tx_clear();
	}
	const failNextCell = (
		globalThis as typeof globalThis & { __mal_fail_next_cell_allocation?: () => void }
	).__mal_fail_next_cell_allocation;
	if (failNextCell !== undefined) {
		const before = c.tx_destroyed(),
			tables = c.tx_tables_freed();
		let failed = false;
		c.tx_watch(failNextCell);
		try {
			Reflect.apply(c.tx_pointer_out, undefined, []);
		} catch (error) {
			failed = error instanceof Error && error.message === "Out of memory";
		} finally {
			c.tx_watch(null);
		}
		check(
			failed &&
				c.tx_tables_freed() === tables + 1 &&
				c.tx_destroyed() === before &&
				c.tx_pointer_bank_value() === 353,
			"allocation failure after borrowed pointer conversion releases only the outer table",
		);
		c.tx_pointer_clear();
	}
	for (const [invoke, owned] of [
		[c.tx_pointer_inout, true],
		[c.pointerInoutAsync, true],
		[c.tx_pointer_inout_borrowed, false],
		[c.pointerInoutBorrowedAsync, false],
	] as const) {
		{
			const first = (owned ? c.tx_borrow(379) : c.tx_create(379))!,
				tail = c.tx_borrow(383)!;
			const before = c.tx_destroyed();
			const value = await invoke([first, tail], 1);
			check(
				value.rows.length === 1 && value.rows[0] === first,
				"inout pointer buffers return only the written prefix",
			);
			first[Symbol.dispose]();
			tail[Symbol.dispose]();
			check(
				c.tx_destroyed() === before + 1,
				"inout pointer ownership applies only to the written prefix and preserves prior owners",
			);
			c.tx_clear();
		}
		if (!owned) {
			const value = c.tx_borrow(421)!,
				before = c.tx_destroyed();
			const result = await invoke([value], 0);
			check(result.rows[0] === value, "borrowed inout pointers keep their wrapper");
			value[Symbol.dispose]();
			check(
				c.tx_destroyed() === before,
				"borrowed inout results do not adopt their input",
			);
			c.tx_clear();
		}
		{
			const first = c.tx_create(389)!,
				second = c.tx_create(397)!;
			const before = c.tx_destroyed();
			await rangeFailure(() => invoke([first, second], 2));
			check(
				c.tx_destroyed() === before && c.tx_read(first) === 389,
				"invalid pointer counts preserve existing resources",
			);
			first[Symbol.dispose]();
			second[Symbol.dispose]();
		}
		{
			const first = c.tx_create(401)!;
			const entries = c.tx_caller_entries();
			let pinned = false;
			const values = [first, first];
			Object.defineProperty(values, 1, {
				get() {
					pinned = rejects(() => first[Symbol.dispose]());
					throw new RangeError("later pointer getter");
				},
			});
			await rangeFailure(() => invoke(values, 0));
			check(
				pinned && c.tx_caller_entries() === entries && c.tx_read(first) === 401,
				"earlier pointer inputs stay pinned through later getters",
			);
			first[Symbol.dispose]();
		}
	}
	{
		const first = c.tx_create(409)!,
			second = c.tx_create(419)!;
		const pending = c.pointerInoutAsync([first, second], 4);
		check(
			rejects(() => first[Symbol.dispose]()) && rejects(() => second[Symbol.dispose]()),
			"async pointer buffers pin every input",
		);
		const value = await pending;
		check(
			value.rows[0] === first && value.rows[1] === second,
			"async pointer results retain input identity",
		);
		first[Symbol.dispose]();
		second[Symbol.dispose]();
	}
	{
		const before = c.tx_destroyed(),
			started = c.tx_caller_started();
		const worker = new Worker(createWorkerUrl("./record-worker.ts", import.meta.url));
		const admitted = new Promise<void>((resolve) => {
			worker.port.onmessage = () => resolve();
		});
		worker.port.start();
		await worker.ready;
		worker.port.postMessage("pointer");
		await admitted;
		while (c.tx_caller_started() === started)
			await new Promise((resolve) => {
				setTimeout(resolve, 1);
			});
		await worker.terminate();
		check(
			c.tx_destroyed() === before + 2,
			"undelivered pointer outputs clamp invalid counts and release distinct resources",
		);
	}
}
