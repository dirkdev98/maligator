import { argon2 } from "node:crypto";

argon2(
	"argon2id",
	{
		message: Buffer.alloc(32, 1),
		nonce: Buffer.alloc(16, 2),
		parallelism: 2,
		tagLength: 32,
		memory: 64,
		passes: 3,
	},
	(error) => {
		if (error) throw error;
		console.log("done");
	},
);

let checksum = 0;
for (let index = 0; index < 1_000_000; index++) checksum += index & 7;
if (checksum !== 3_500_000) throw new Error("unexpected checksum");
