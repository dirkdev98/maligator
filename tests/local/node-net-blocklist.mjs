import assert from "node:assert/strict";
import { BlockList } from "node:net";

const selection = process.env.MAL_TEST_BLOCKLIST_CASE;
if (selection === "subnets") {
	const rules = new BlockList();
	for (const [address, prefix, family] of [
		["127.0.0.1", 8, "ipv4"],
		["169.254.7.3", 16, "ipv4"],
		["fe80::1", 10, "ipv6"],
		["fc00::1", 7, "ipv6"],
	])
		rules.addSubnet(address, prefix, family);
	for (const [address, family, expected] of [
		["127.255.255.255", "ipv4", true],
		["128.0.0.0", "ipv4", false],
		["169.254.0.0", "ipv4", true],
		["169.255.0.0", "ipv4", false],
		["::ffff:127.0.0.1", "ipv6", true],
		["fe80::7%eth0", "ipv6", true],
		["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ipv6", true],
		["fec0::1", "ipv6", false],
		["fdff::1", "ipv6", true],
		["fe00::1", "ipv6", false],
	])
		assert.equal(rules.check(address, family), expected, address);
	const all = new BlockList();
	all.addSubnet("::", 0, "ipv6");
	assert.equal(all.check("192.0.2.1"), true);
	assert.equal(all.check("2001:db8::1", "ipv6"), true);
} else if (selection === "ranges") {
	const rules = new BlockList();
	rules.addAddress("192.0.2.7");
	rules.addAddress("2001:db8::7", "IPv6");
	rules.addRange("198.51.100.10", "198.51.100.20");
	rules.addRange("2001:db8:1::10", "2001:db8:1::20", "ipv6");
	for (const [address, family, expected] of [
		["::ffff:192.0.2.7", "ipv6", true],
		["192.0.2.8", "ipv4", false],
		["2001:0db8:0000::7", "ipv6", true],
		["198.51.100.9", "ipv4", false],
		["198.51.100.10", "ipv4", true],
		["198.51.100.20", "ipv4", true],
		["198.51.100.21", "ipv4", false],
		["2001:db8:1::f", "ipv6", false],
		["2001:db8:1::10", "ipv6", true],
		["2001:db8:1::20", "ipv6", true],
		["2001:db8:1::21", "ipv6", false],
	])
		assert.equal(rules.check(address, family), expected, address);
	const mapped = new BlockList();
	mapped.addSubnet("::ffff:203.0.113.4", 120, "ipv6");
	assert.equal(mapped.check("203.0.113.255"), true);
	assert.equal(mapped.check("203.0.114.0"), false);
} else if (selection === "rules") {
	class LocalBlockList extends BlockList {}
	const rules = new LocalBlockList();
	const add = BlockList.prototype.addAddress;
	add.call(rules, "192.0.2.7");
	add.call(rules, "192.0.2.7");
	rules.addSubnet("2001:0db8::1", 32, "ipv6");
	const expected = ["Address: IPv4 192.0.2.7", "Subnet: IPv6 2001:db8::1/32"];
	assert.deepEqual(rules.rules.sort(), expected.sort());
	rules.rules.length = 0;
	if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
	assert.equal(rules.check("192.0.2.7"), true);
	assert.equal(rules.check("2001:db8:7::1", "ipv6"), true);
	assert.equal(BlockList.isBlockList(rules), true);
	const inherited = Object.create(rules);
	assert.equal(BlockList.isBlockList(inherited), true);
	inherited.addAddress("198.51.100.7");
	assert.equal(rules.check("198.51.100.7"), true);
	assert.equal(BlockList.isBlockList({}), false);
} else if (selection === "validation") {
	const rules = new BlockList();
	for (const [method, args, code] of [
		["addAddress", ["bad"], "ERR_INVALID_ADDRESS"],
		["addAddress", [123], "ERR_INVALID_ARG_TYPE"],
		["addAddress", ["::1"], "ERR_INVALID_ADDRESS"],
		["addAddress", ["192.0.2.1", "wrong"], "ERR_INVALID_ARG_VALUE"],
		["addSubnet", ["192.0.2.1", 33], "ERR_OUT_OF_RANGE"],
		["addSubnet", ["192.0.2.1", 2.5], "ERR_OUT_OF_RANGE"],
		["addSubnet", ["192.0.2.1", "8"], "ERR_INVALID_ARG_TYPE"],
		["addRange", ["192.0.2.2", "192.0.2.1"], "ERR_INVALID_ARG_VALUE"],
		["check", [123], "ERR_INVALID_ARG_TYPE"],
		["check", ["192.0.2.1", null], "ERR_INVALID_ARG_TYPE"],
	])
		assert.throws(() => rules[method](...args), { code });
	assert.equal(rules.check("invalid"), false);
	assert.equal(rules.check("::1"), false);
	assert.equal(rules.check("192.0.2.1", "wrong"), false);
	assert.throws(() => BlockList());
	assert.throws(() => BlockList.prototype.addAddress.call({}, "192.0.2.1"));
} else throw new Error("Missing BlockList selection");

console.log("BLOCKLIST PASS");
