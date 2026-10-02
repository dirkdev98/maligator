const crypto = process.getBuiltinModule("crypto");
if (crypto !== process.getBuiltinModule("node:crypto"))
	throw new Error("builtin identity");
const vectors = [
	["sha1", 0, "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
	["sha1", 111, "ac877859d427d9192054eea8feb3b8a403ef83a5"],
	["sha1", 112, "689993727ba37386bb032495e9dbdfb4dd1ba744"],
	["sha1", 127, "89d95fa32ed44a7c610b7ee38517ddf57e0bb975"],
	["sha1", 128, "ad5b3fdbcb526778c2839d2f151ea753995e26a0"],
	["sha1", 129, "d96debf1bdcbc896e6c134ea76e8141f40d78536"],
	["sha1", 1024, "8eca554631df9ead14510e1a70ae48c70f9b9384"],
	["sha256", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
	["sha256", 111, "6374f73208854473827f6f6a3f43b1f53eaa3b82c21c1a6d69a2110b2a79baad"],
	["sha256", 112, "f54353008a2553262ecdc4a34749563ba0950e8b0fc8652780b0a614b99683c1"],
	["sha256", 127, "c57e9278af78fa3cab38667bef4ce29d783787a2f731d4e12200270f0c32320a"],
	["sha256", 128, "6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e"],
	["sha256", 129, "c12cb024a2e5551cca0e08fce8f1c5e314555cc3fef6329ee994a3db752166ae"],
	["sha256", 1024, "2edc986847e209b4016e141a6dc8716d3207350f416969382d431539bf292e4a"],
	[
		"sha384",
		0,
		"38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b",
	],
	[
		"sha384",
		111,
		"3c37955051cb5c3026f94d551d5b5e2ac38d572ae4e07172085fed81f8466b8f90dc23a8ffcdea0b8d8e58e8fdacc80a",
	],
	[
		"sha384",
		112,
		"187d4e07cb306103c69967bf544d0dfbe9042577599c73c330abc0cb64c61236d5ed565ee19119d8c31779a38f791fcd",
	],
	[
		"sha384",
		127,
		"9bd06b1763c2cf7aef40e795dc65bc96d59c41b537f3ad72ebdefd485476b5717c1aeb37c327fe9c1831b12b9efd08ae",
	],
	[
		"sha384",
		128,
		"edb12730a366098b3b2beac75a3bef1b0969b15c48e2163c23d96994f8d1bef760c7e27f3c464d3829f56c0d53808b0b",
	],
	[
		"sha384",
		129,
		"39b6f5a7b0e781dbc419f72e49b30eaac10f2c98c4403bc610da31067fd1b48f324138c8615d2b496d08d73d5e865326",
	],
	[
		"sha384",
		1024,
		"a31bea5896ef0e418f18014ef9fde89f6f33a177dc97190bc39dedd94e5476342a0d277c92bc19ca0542fca227d12c4c",
	],
	[
		"sha512",
		0,
		"cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
	],
	[
		"sha512",
		111,
		"fa9121c7b32b9e01733d034cfc78cbf67f926c7ed83e82200ef86818196921760b4beff48404df811b953828274461673c68d04e297b0eb7b2b4d60fc6b566a2",
	],
	[
		"sha512",
		112,
		"c01d080efd492776a1c43bd23dd99d0a2e626d481e16782e75d54c2503b5dc32bd05f0f1ba33e568b88fd2d970929b719ecbb152f58f130a407c8830604b70ca",
	],
	[
		"sha512",
		127,
		"828613968b501dc00a97e08c73b118aa8876c26b8aac93df128502ab360f91bab50a51e088769a5c1eff4782ace147dce3642554199876374291f5d921629502",
	],
	[
		"sha512",
		128,
		"b73d1929aa615934e61a871596b3f3b33359f42b8175602e89f7e06e5f658a243667807ed300314b95cacdd579f3e33abdfbe351909519a846d465c59582f321",
	],
	[
		"sha512",
		129,
		"4f681e0bd53cda4b5a2041cc8a06f2eabde44fb16c951fbd5b87702f07aeab611565b19c47fde30587177ebb852e3971bbd8d3fd30da18d71037dfbd98420429",
	],
	[
		"sha512",
		1024,
		"74b22492e3b9a86a9c93c23a69f821ebafa429302c1f4054b4bc37356a4bae056d9ccbc6f24093a25704faaa72bd21a5f337ca9ec92f32369d24e6b9fae954d8",
	],
];
let checked = 0;
for (const [algorithm, length, expected] of vectors) {
	const value = "a".repeat(length);
	const bytes = Buffer.from(value);
	const framed = Buffer.concat([Buffer.from([9]), bytes, Buffer.from([9])]).subarray(
		1,
		length + 1,
	);
	const state = crypto.createHash(algorithm.toUpperCase());
	state.update(bytes.subarray(0, 17));
	state.update(bytes.subarray(17));
	if (state.digest("hex") !== expected)
		throw new Error("streamed " + algorithm + " " + length);
	if (crypto.hash(algorithm, value) !== expected)
		throw new Error("string " + algorithm + " " + length);
	if (crypto.hash(algorithm, framed, "buffer").toString("hex") !== expected)
		throw new Error("view " + algorithm + " " + length);
	checked += 3;
}
console.log("UPM CRYPTO PASS " + checked);
