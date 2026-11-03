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
	check(caught instanceof RangeError, `array conversion error: ${String(caught)}`);
}

export async function checkArrays(): Promise<void> {
	for (const invoke of [c.tx_grid, c.gridAsync]) {
		const before = c.tx_destroyed();
		await rangeFailure(() => invoke(1, 0));
		check(c.tx_destroyed() === before + 2, "failed grids release cross-row aliases once");
		const value = await invoke(0, 0);
		check(
			value.result.rows[0][0].first === value.result.tail &&
				value.result.rows[0][1].first === value.alias &&
				value.result.rows[1][1].empty === value.alias &&
				value.result.rows[0][0].empty === null &&
				c.tx_grid_sum(value.result) === 477,
			"nested arrays preserve nulls, aliases and input usability",
		);
		value.result.tail![Symbol.dispose]();
		value.alias![Symbol.dispose]();
		check(c.tx_destroyed() === before + 4, "successful grids commit independent owners");
		for (const borrowed of [false, true]) {
			const prior = borrowed ? c.tx_borrow(211) : c.tx_create(211);
			const destroyed = c.tx_destroyed();
			await rangeFailure(() => invoke(1, 1));
			check(
				c.tx_destroyed() === destroyed + 1 && c.tx_read(prior!) === 211,
				"failed grid adoption preserves a prior alias",
			);
			prior![Symbol.dispose]();
			check(
				c.tx_destroyed() === destroyed + 1 + (borrowed ? 0 : 1),
				"failed grid adoption preserves prior ownership",
			);
			c.tx_clear();
		}
	}
	{
		const before = c.tx_destroyed();
		const selected = c.tx_choice_grid();
		check(
			selected.choices[0].first === selected.choices[1].second &&
				c.tx_choice_sum(selected.choices[1]) === 158,
			"selected union arrays preserve canonical aliases",
		);
		selected.choices[0].first![Symbol.dispose]();
		const output = c.tx_grid_out();
		check(
			output.rows[0].first === output.rows[1].second,
			"fixed output arrays join one transaction",
		);
		output.rows[0].first![Symbol.dispose]();
		check(c.tx_destroyed() === before + 2, "selected and output arrays dispose once");
	}
	for (const invoke of [c.tx_policy_grid, c.policyGridAsync]) {
		const before = c.tx_special_destroyed();
		await rangeFailure(() => invoke(1));
		check(
			c.tx_special_destroyed() === before + 1,
			"failure uses the first row's owning policy",
		);
		const value = await invoke(0);
		check(
			value.result.rows[0].second === value.result.rows[1].first,
			"later rows share the first owning view",
		);
		value.result.rows[0].second![Symbol.dispose]();
		check(
			c.tx_special_destroyed() === before + 2,
			"success uses the first row's owning policy",
		);
	}
	for (const invoke of [c.tx_policy_capacity, c.policyCapacityAsync]) {
		const before = c.tx_special_destroyed();
		await rangeFailure(() => invoke());
		check(
			c.tx_special_destroyed() === before + 1,
			"capacity validation failure preserves the first row's cleanup policy",
		);
	}
	for (const invoke of [c.tx_fresh_capacity, c.freshCapacityAsync]) {
		const before = c.tx_destroyed();
		const special = c.tx_special_destroyed();
		const prior = c.tx_recycled()!;
		let closing: Promise<void> | undefined;
		await rangeFailure(() =>
			invoke(() => {
				closing = c.destroyResourceAsync(prior);
			}),
		);
		await closing;
		check(
			c.tx_destroyed() === before + 2 && c.tx_special_destroyed() === special + 1,
			"raw cleanup sees later indexed freshness without changing the owning policy",
		);
	}
	for (const invoke of [c.tx_fresh_grid, c.freshGridAsync]) {
		for (const bad of [0, 1]) {
			const before = c.tx_destroyed();
			const special = c.tx_special_destroyed();
			const prior = c.tx_recycled()!;
			let closing: Promise<void> | undefined;
			const close = () => {
				closing = c.destroyResourceAsync(prior);
			};
			if (bad !== 0) await rangeFailure(() => invoke(bad, close));
			else {
				const value = await invoke(bad, close);
				check(
					value.result !== prior &&
						value.result === value.grid.rows[0].owned &&
						value.result === value.grid.rows[1].fresh &&
						value.result![Symbol.toStringTag] === "TxBase" &&
						c.tx_special_read(value.grid.rows[0].owned!) === 193,
					"later indexed freshness preserves the first canonical type and owner",
				);
				value.grid.rows[0].owned![Symbol.dispose]();
			}
			await closing;
			check(
				c.tx_destroyed() === before + 2 && c.tx_special_destroyed() === special + 1,
				"fresh grid lifetimes use the first owning destructor on success and failure",
			);
		}
	}
	{
		const before = c.tx_destroyed();
		let loan: c.TxGrid | undefined;
		check(
			c.tx_grid_visit((value) => {
				loan = value;
				return c.tx_grid_sum(value);
			}) === 507,
			"callback array fields remain usable during their invocation",
		);
		let expired = false;
		try {
			c.tx_grid_sum(loan!);
		} catch (error) {
			expired = error instanceof TypeError;
		}
		check(
			expired && c.tx_destroyed() === before + 2,
			"callback array loans expire without taking ownership",
		);
	}
	const failNextCell = (
		globalThis as typeof globalThis & { __mal_fail_next_cell_allocation?: () => void }
	).__mal_fail_next_cell_allocation;
	if (failNextCell !== undefined) {
		const before = c.tx_destroyed();
		let failed = false;
		try {
			Reflect.apply(c.tx_grid_arm, undefined, [failNextCell]);
		} catch (error) {
			failed = error instanceof Error;
		}
		check(
			failed && c.tx_destroyed() === before + 2,
			"array allocation failure releases unconverted resources",
		);
	}
	for (const mode of ["grid", "policy"]) {
		const before = c.tx_destroyed();
		const special = c.tx_special_destroyed();
		const started = c.tx_grid_started();
		const worker = new Worker(createWorkerUrl("./record-worker.ts", import.meta.url));
		const admitted = new Promise<void>((resolve) => {
			worker.port.onmessage = () => resolve();
		});
		worker.port.start();
		await worker.ready;
		worker.port.postMessage(mode);
		await admitted;
		while (c.tx_grid_started() === started)
			await new Promise((resolve) => {
				setTimeout(resolve, 1);
			});
		await worker.terminate();
		check(
			c.tx_destroyed() === before + (mode === "grid" ? 2 : 1),
			"abandoned arrays release each native resource once",
		);
		check(
			c.tx_special_destroyed() === special + (mode === "policy" ? 1 : 0),
			"native array cleanup preserves row-order ownership",
		);
	}
}
