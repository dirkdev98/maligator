import * as c from "maligator:ffi/transactions";
import { createWorkerUrl, Worker } from "maligator:workers";

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
	check(caught instanceof RangeError, `table conversion error: ${String(caught)}`);
}

export async function checkTables(): Promise<void> {
	for (const invoke of [c.tx_table, c.tableAsync]) {
		for (const mode of [1, 4]) {
			const destroyed = c.tx_destroyed(),
				freed = c.tx_tables_freed();
			await rangeFailure(() => invoke(mode, null));
			check(
				c.tx_destroyed() === destroyed + (mode === 1 ? 2 : 0) &&
					c.tx_tables_freed() === freed + 1,
				"failed counted results release valid elements and their outer allocation",
			);
		}
		{
			const destroyed = c.tx_destroyed(),
				freed = c.tx_tables_freed();
			const nil = await invoke(2, null);
			const empty = await invoke(3, null);
			check(
				nil.result === null &&
					empty.result?.length === 0 &&
					c.tx_destroyed() === destroyed &&
					c.tx_tables_freed() === freed + 1,
				"null tables ignore their count and empty tables release only their allocation",
			);
		}
		{
			const destroyed = c.tx_destroyed(),
				freed = c.tx_tables_freed();
			const value = await invoke(0, null);
			check(
				value.result?.length === 2 &&
					value.result[0]!.first === value.result[1]!.second &&
					value.result[0]!.second === value.result[1]!.first &&
					value.result[0]!.empty === null &&
					c.tx_read(value.result[0]!.first!) === 223 &&
					c.tx_read(value.result[1]!.first!) === 227 &&
					c.tx_tables_freed() === freed + 1,
				"table snapshots preserve aliases after releasing outer storage",
			);
			value.result[0]!.first![Symbol.dispose]();
			value.result[0]!.second![Symbol.dispose]();
			check(
				c.tx_destroyed() === destroyed + 2,
				"table ownership commits once per distinct resource",
			);
		}
		{
			const prior = c.tx_borrow(239)!;
			const destroyed = c.tx_destroyed();
			await rangeFailure(() => invoke(1, prior));
			check(
				c.tx_destroyed() === destroyed + 1 && c.tx_read(prior) === 239,
				"failed counted adoption preserves an existing alias",
			);
			prior[Symbol.dispose]();
			check(
				c.tx_destroyed() === destroyed + 1,
				"failed counted adoption preserves borrowed ownership",
			);
			c.tx_clear();
		}
		{
			const destroyed = c.tx_destroyed(),
				freed = c.tx_tables_freed();
			c.tx_watch((bad) => {
				if (bad !== 0) throw new RangeError("table release failed");
			});
			await rangeFailure(() => invoke(5, null));
			c.tx_watch(null);
			check(
				c.tx_destroyed() === destroyed + 2 && c.tx_tables_freed() === freed + 1,
				"outer release failure rolls back staged element ownership",
			);
		}
	}
	for (const make of [c.tx_table_const, c.tableConstAsync]) {
		const value = await make();
		check(
			value?.[0]!.first === value?.[1]!.second && c.tx_read(value![0]!.first!) === 223,
			"const record tables share transactional conversion",
		);
		value![0]!.first![Symbol.dispose]();
		value![0]!.second![Symbol.dispose]();
	}
	for (const make of [c.tx_table_out, c.tableOutAsync]) {
		const { rows } = await make();
		check(rows?.[0]!.first === rows?.[1]!.second, "out tables preserve element aliases");
		rows![0]!.first![Symbol.dispose]();
		rows![0]!.second![Symbol.dispose]();
	}
	for (const make of [c.tx_table_choice, c.tableChoiceAsync]) {
		const value = await make();
		check(
			value?.[0]!.first === value?.[1]!.second && c.tx_choice_sum(value![0]!) === 158,
			"selected union tables preserve their owned member",
		);
		value![0]!.first![Symbol.dispose]();
	}
	for (const make of [c.tx_table_grid, c.tableGridAsync]) {
		const value = await make();
		check(
			value?.length === 1 && value[0]![0].first === value[0]![1].second,
			"counted tables preserve fixed inner dimensions and ownership",
		);
		value[0]![0].first![Symbol.dispose]();
		value[0]![0].second![Symbol.dispose]();
	}
	for (const make of [c.tx_static_table, c.staticTableAsync]) {
		const freed = c.tx_tables_freed();
		const value = await make();
		check(
			value?.[0]!.first === value?.[1]!.second && c.tx_tables_freed() === freed,
			"library-owned tables transfer elements without releasing table storage",
		);
		value![0]!.first![Symbol.dispose]();
		value![0]!.second![Symbol.dispose]();
	}
	for (const make of [c.tx_table_policy, c.tablePolicyAsync]) {
		const before = c.tx_special_destroyed();
		const value = await make();
		check(value?.[0]!.second === value?.[1]!.first, "counted policies follow row order");
		value![0]!.second![Symbol.dispose]();
		check(
			c.tx_special_destroyed() === before + 1,
			"counted aliases retain the first owning destructor",
		);
	}
	for (const make of [c.tx_fresh_table, c.freshTableAsync]) {
		const destroyed = c.tx_destroyed(),
			special = c.tx_special_destroyed();
		const prior = c.tx_recycled()!;
		let closing: Promise<void> | undefined;
		const value = await make(() => {
			closing = c.destroyResourceAsync(prior);
		});
		await closing;
		check(
			value.result !== prior &&
				value.result === value.rows?.[0]!.owned &&
				value.result === value.rows?.[1]!.fresh &&
				value.result![Symbol.toStringTag] === "TxBase",
			"counted freshness keeps first canonical metadata",
		);
		value.rows[0].owned![Symbol.dispose]();
		check(
			c.tx_destroyed() === destroyed + 2 && c.tx_special_destroyed() === special + 1,
			"counted freshness keeps first owning policy",
		);
	}
	const failNextCell = (
		globalThis as typeof globalThis & { __mal_fail_next_cell_allocation?: () => void }
	).__mal_fail_next_cell_allocation;
	if (failNextCell !== undefined) {
		const destroyed = c.tx_destroyed(),
			freed = c.tx_tables_freed();
		let failed = false;
		try {
			Reflect.apply(c.tx_table_arm, undefined, [failNextCell]);
		} catch (error) {
			failed = error instanceof Error;
		}
		check(
			failed && c.tx_destroyed() === destroyed + 2 && c.tx_tables_freed() === freed + 1,
			"counted array allocation failure releases unconverted elements and storage",
		);
	}
	{
		const destroyed = c.tx_destroyed(),
			freed = c.tx_tables_freed();
		const worker = new Worker(createWorkerUrl("./record-worker.ts", import.meta.url));
		const admitted = new Promise<void>((resolve) => {
			worker.port.onmessage = () => resolve();
		});
		worker.port.start();
		await worker.ready;
		worker.port.postMessage("table");
		await admitted;
		while (c.tx_table_started() === 0)
			await new Promise((resolve) => {
				setTimeout(resolve, 1);
			});
		await worker.terminate();
		check(
			c.tx_destroyed() === destroyed + 2 && c.tx_tables_freed() === freed + 1,
			"abandoned counted tables release resources and outer storage without a VM",
		);
	}
}
