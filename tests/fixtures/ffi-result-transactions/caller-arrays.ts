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
	check(caught instanceof RangeError, `caller array error: ${String(caught)}`);
}
function row(value: c.TxResource): c.TxFields {
	return { first: value, second: value, empty: null };
}
export async function checkCallerArrays(): Promise<void> {
	for (const invoke of [c.tx_caller_table, c.callerTableAsync]) {
		for (const mode of [2, 3, 4]) {
			const before = c.tx_destroyed();
			await rangeFailure(() => invoke(4n, mode));
			check(
				c.tx_destroyed() === before + 2,
				"invalid caller counts and late conversion errors release bounded initialized resources once",
			);
		}
		const before = c.tx_destroyed();
		check(
			(await invoke(0n, 0)).rows.length === 0 &&
				(await invoke(4n, 5)).rows.length === 0 &&
				c.tx_destroyed() === before,
			"empty caller buffers return empty arrays without resources",
		);
		for (const mode of [0, 1]) {
			const value = await invoke(4n, mode);
			check(
				value.rows.length === (mode === 0 ? 2 : 1) &&
					value.rows[0]!.first === value.alias &&
					value.rows[0]!.second === value.alias &&
					c.tx_read(value.alias!) === 269,
				"caller outputs preserve their written prefix and companion aliases",
			);
			value.alias![Symbol.dispose]();
			if (mode === 0) value.rows[1]!.second![Symbol.dispose]();
		}
		check(
			c.tx_destroyed() === before + 3,
			"caller output ownership commits once per distinct resource",
		);
	}
	for (const invoke of [c.tx_caller_policy, c.callerPolicyAsync]) {
		const before = c.tx_special_destroyed();
		await rangeFailure(() => invoke(4n, 1));
		check(
			c.tx_special_destroyed() === before + 1,
			"bounded raw caller cleanup preserves row-order policy",
		);
		const value = await invoke(4n, 0);
		check(
			value.rows[0]!.second === value.rows[1]!.first,
			"caller row aliases share a handle",
		);
		value.rows[0]!.second![Symbol.dispose]();
		check(
			c.tx_special_destroyed() === before + 2,
			"caller row aliases retain the first owning destructor",
		);
	}
	for (const invoke of [c.tx_caller_grid, c.callerGridAsync]) {
		const value = await invoke(2n);
		check(
			value.rows.length === 1 && value.rows[0]![0].first === value.rows[0]![1].second,
			"caller arrays preserve owned fixed inner rows",
		);
		value.rows[0]![0].first![Symbol.dispose]();
		value.rows[0]![0].second![Symbol.dispose]();
	}
	for (const invoke of [c.tx_caller_tagged, c.callerTaggedAsync]) {
		const value = await invoke(4n);
		const first = value.rows[0]!,
			last = value.rows[2]!;
		check(
			first.kind === 2 && last.kind === 1 && first.payload.second === last.payload.first,
			"caller arrays preserve mixed active tagged payloads",
		);
		first.payload.second![Symbol.dispose]();
		last.payload.second![Symbol.dispose]();
	}
	for (const invoke of [c.tx_caller_fresh, c.callerFreshAsync]) {
		for (const bad of [0, 1]) {
			const before = c.tx_destroyed(),
				special = c.tx_special_destroyed();
			const prior = c.tx_recycled()!;
			let closing: Promise<void> | undefined;
			const close = () => {
				closing = c.destroyResourceAsync(prior);
			};
			if (bad !== 0) await rangeFailure(() => invoke(4n, close, bad));
			else {
				const value = await invoke(4n, close, bad);
				check(
					value.result !== prior &&
						value.result === value.rows[0]!.owned &&
						value.result === value.rows[1]!.fresh &&
						value.result![Symbol.toStringTag] === "TxBase",
					"caller freshness preserves first canonical metadata",
				);
				value.rows[0]!.owned![Symbol.dispose]();
			}
			await closing;
			check(
				c.tx_destroyed() === before + 2 && c.tx_special_destroyed() === special + 1,
				"caller freshness keeps first ownership through bounded rollback",
			);
		}
	}
	for (const invoke of [c.tx_caller_inout, c.callerInoutAsync]) {
		{
			const first = c.tx_create(293)!,
				tail = c.tx_borrow(307)!;
			const before = c.tx_destroyed();
			const value = await invoke([row(first), row(tail)], 1);
			check(
				value.rows.length === 1 && value.alias === first,
				"inout outputs return only their written prefix",
			);
			first[Symbol.dispose]();
			tail[Symbol.dispose]();
			check(
				c.tx_destroyed() === before + 1,
				"inout tails preserve their original borrowed ownership",
			);
			c.tx_clear();
		}
		{
			const first = c.tx_create(311)!,
				second = c.tx_create(313)!;
			const before = c.tx_destroyed();
			await rangeFailure(() => invoke([row(first), row(second)], 2));
			check(
				c.tx_destroyed() === before &&
					c.tx_read(first) === 311 &&
					c.tx_read(second) === 313,
				"invalid inout counts preserve existing resources",
			);
			first[Symbol.dispose]();
			second[Symbol.dispose]();
		}
		{
			const first = c.tx_create(317)!,
				second = c.tx_create(331)!;
			const entries = c.tx_caller_entries();
			let pinned = false;
			const later = {
				get first(): never {
					pinned = rejects(() => first[Symbol.dispose]());
					throw new RangeError("later input getter");
				},
				second,
				empty: null,
			};
			await rangeFailure(() => invoke([row(first), later], 0));
			check(
				pinned && c.tx_caller_entries() === entries && c.tx_read(first) === 317,
				"earlier inout handles stay pinned through later getters and failed conversion",
			);
			first[Symbol.dispose]();
			second[Symbol.dispose]();
		}
	}
	{
		const first = c.tx_create(337)!,
			second = c.tx_create(347)!;
		const pending = c.callerInoutAsync([row(first), row(second)], 4);
		check(
			rejects(() => first[Symbol.dispose]()) && rejects(() => second[Symbol.dispose]()),
			"inout handles remain pinned while the worker uses their buffer",
		);
		const value = await pending;
		check(
			value.rows[0]!.first === first && value.rows[1]!.first === second,
			"worker inout results preserve input identities",
		);
		first[Symbol.dispose]();
		second[Symbol.dispose]();
	}
	const failNextCell = (
		globalThis as typeof globalThis & { __mal_fail_next_cell_allocation?: () => void }
	).__mal_fail_next_cell_allocation;
	if (failNextCell !== undefined) {
		const before = c.tx_destroyed();
		let failed = false;
		try {
			Reflect.apply(c.tx_caller_arm, undefined, [4n, failNextCell]);
		} catch (error) {
			failed = error instanceof Error;
		}
		check(
			failed && c.tx_destroyed() === before + 2,
			"caller output allocation failure releases unconverted resources",
		);
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
		worker.port.postMessage("caller");
		await admitted;
		while (c.tx_caller_started() === started)
			await new Promise((resolve) => {
				setTimeout(resolve, 1);
			});
		await worker.terminate();
		check(
			c.tx_destroyed() === before + 2,
			"native abandonment clamps invalid counts before walking caller storage",
		);
	}
}
