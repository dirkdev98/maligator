// Leak-lane fixture: exercise every allocation the Argon2 path hands across the
// worker boundary — copied inputs, the tag buffer, the posted result, and the
// per-call async state — plus the synchronous path and the entropy helpers.
// Driven by tests/native/leak.test.ts under MAL_GC_AT_EXIT.

import { argon2, argon2Sync, randomBytes, randomInt, randomUUID } from "node:crypto";

const parameters = (fill) => ({
	message: Buffer.alloc(32, fill),
	nonce: Buffer.alloc(16, 0x02),
	secret: Buffer.alloc(8, 0x03),
	associatedData: Buffer.alloc(12, 0x04),
	parallelism: 1,
	tagLength: 32,
	memory: 64,
	passes: 1,
});

for (let i = 0; i < 4; i++) argon2Sync("argon2id", parameters(i));

let outstanding = 0;
for (let i = 0; i < 8; i++) {
	outstanding++;
	argon2("argon2id", parameters(0x40 + i), (error, tag) => {
		outstanding--;
		if (error !== null || tag.length !== 32) throw new Error("argon2 job failed");
	});
}

// A refused job frees the same allocations down a different path. The host
// resource policy rejects before the job is queued, so this throws rather than
// calling back; either way nothing may be left behind.
try {
	argon2("argon2id", { ...parameters(1), memory: 4294967295 }, () => {
		outstanding--;
	});
	outstanding++;
} catch {
	// Refused before queueing; no callback is owed.
}

for (let i = 0; i < 4; i++) {
	outstanding++;
	randomBytes(64, () => outstanding--);
	outstanding++;
	randomInt(0, 1000, () => outstanding--);
}

randomUUID();
randomUUID({ disableEntropyCache: true });
randomBytes(1024);
argon2Sync("argon2id", { ...parameters(9), tagLength: 64 });

process.on("exit", () => {
	if (outstanding !== 0) throw new Error("callbacks outstanding: " + outstanding);
});
