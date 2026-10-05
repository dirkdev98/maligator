import { describe, expect, it } from "vitest";
import { scheduleTestJobs } from "../src/testing/scheduler.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("test job scheduling", () => {
	it("bounds admitted jobs and returns results in selection order after out-of-order completion", async () => {
		const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
		const thirdStarted = deferred<void>();
		const started: Array<number> = [];
		const running = scheduleTestJobs([0, 1, 2], 2, async (index) => {
			started.push(index);
			if (index === 2) thirdStarted.resolve();
			return gates[index]!.promise;
		});
		expect(started).toEqual([0, 1]);
		gates[1]!.resolve("second");
		await thirdStarted.promise;
		expect(started).toEqual([0, 1, 2]);
		gates[2]!.resolve("third");
		gates[0]!.resolve("first");
		expect([...(await running)]).toEqual([
			[0, "first"],
			[1, "second"],
			[2, "third"],
		]);
	});

	it("stops admitting work on bail but joins jobs already started", async () => {
		const first = deferred<void>();
		const second = deferred<void>();
		let stop = false;
		const started: Array<number> = [];
		const running = scheduleTestJobs(
			[0, 1, 2],
			2,
			async (index) => {
				started.push(index);
				await (index === 0 ? first : second).promise;
				return index;
			},
			() => !stop,
		);
		stop = true;
		first.resolve();
		second.resolve();
		expect([...(await running)]).toEqual([
			[0, 0],
			[1, 1],
		]);
		expect(started).toEqual([0, 1]);
	});

	it("does not abandon accepted work when another job rejects", async () => {
		const gate = deferred<void>();
		let joined = false;
		const running = scheduleTestJobs([0, 1], 2, async (index) => {
			if (index === 0) throw new Error("first failed");
			await gate.promise;
			joined = true;
		});
		const failed = expect(running).rejects.toThrow("first failed");
		expect(joined).toBe(false);
		gate.resolve();
		await failed;
		expect(joined).toBe(true);
	});
});
