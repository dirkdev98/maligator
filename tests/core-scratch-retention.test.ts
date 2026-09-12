import { deepStrictEqual, equal, notEqual, throws } from "node:assert";
import { describe, it } from "vitest";
import { CoreAnalysisScratchPool } from "../src/compiler/core/core-analysis-scratch.ts";

describe("Core scratch retention under growing functions", () => {
	it("replaces the smallest idle buffer and reuses the larger release", () => {
		const pool = new CoreAnalysisScratchPool(1024);
		const small = [pool.leaseInt32(4), pool.leaseInt32(8), pool.leaseInt32(12)];
		for (const lease of small) lease.release();
		const large = pool.leaseInt32(64);
		large.release();
		deepStrictEqual(pool.statistics(), {
			retainedBytes: (8 + 12 + 64) * 4,
			int32Buffers: 3,
			uint8Buffers: 0,
		});
		const reused = pool.leaseInt32(64);
		equal(reused.values, large.values);
		const concurrent = pool.leaseInt32(64);
		notEqual(concurrent.values, reused.values);
		concurrent.release();
		reused.release();
		throws(() => reused.release(), /already released/);
	});

	it("does not evict usable buffers when a replacement exceeds the byte budget", () => {
		const pool = new CoreAnalysisScratchPool(32);
		const small = [pool.leaseUint8(4), pool.leaseUint8(8), pool.leaseUint8(12)];
		for (const lease of small) lease.release();
		pool.leaseUint8(32).release();
		equal(pool.statistics().retainedBytes, 24);
		const reused = pool.leaseUint8(4);
		equal(reused.values, small[0]!.values);
		reused.release();
	});

	it("keeps zero-retention pools empty and validates requests", () => {
		const pool = new CoreAnalysisScratchPool(0);
		pool.leaseInt32(16).release();
		pool.leaseUint8(16).release();
		equal(pool.statistics().retainedBytes, 0);
		throws(() => pool.leaseInt32(-1), /non-negative integer/);
		throws(() => pool.leaseUint8(0.5), /non-negative integer/);
	});
});
