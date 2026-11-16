function projected(pattern, subject) {
	const match = pattern.exec(subject);
	return match
		? [
				match[0].length,
				match.index,
				match.groups ? match.groups.tag.length : match[1].length,
				pattern.lastIndex,
			]
		: null;
}
function named(pattern, subject) {
	const match = pattern.exec(subject);
	if (match === null) return null;
	return match.groups.tag;
}
function unknown(pattern, subject) {
	const match = pattern.exec(subject);
	if (match === null) return null;
	return match.groups.missing;
}
function protoName(pattern, subject) {
	const match = pattern.exec(subject);
	if (match === null) return null;
	return match.groups.__proto__;
}
function namedChain(pattern, subject) {
	const match = pattern.exec(subject);
	if (match === null) return -1;
	return match.groups.tag.trim().slice(1).length;
}
function index(pattern, subject) {
	const match = pattern.exec(subject);
	return match.index;
}
function escapedGroups(pattern, subject) {
	const match = pattern.exec(subject);
	if (match === null) return null;
	return match.groups;
}
function escapedResult(pattern, subject) {
	return pattern.exec(subject);
}
function caught(run) {
	try {
		return run();
	} catch (error) {
		return error.name;
	}
}
const output = {};
output.named = projected(new RegExp("(?<tag>ab)\\k<tag>", "gu"), "zzabab");
output.unnamed = projected(new RegExp("(ab)\\1", "gu"), "zzabab");
output.wide = projected(new RegExp("(?<tag>Σ😀)\\k<tag>", "gu"), "😀Σ😀Σ😀");
output.lone = projected(new RegExp("(?<tag>\\uD800)\\k<tag>", "g"), "Σ\ud800\ud800");
output.miss = projected(new RegExp("(?<tag>ab)\\k<tag>", "gu"), "zzacac");
const sticky = new RegExp("(?<tag>ab)\\k<tag>", "uy");
sticky.lastIndex = 2;
output.sticky = projected(sticky, "zzabab");
output.stickyMiss = projected(new RegExp("(?<tag>ab)\\k<tag>", "uy"), "zzabab");
const optional = named(new RegExp("(?<tag>a)?b", "u"), "b");
output.optional = [typeof optional, optional];
output.duplicate = named(new RegExp("(?:(?<tag>a)|(?<tag>b))", "u"), "b");
const missing = unknown(new RegExp("(?<tag>a)", "u"), "a");
output.unknown = [typeof missing, missing];
output.absent = caught(() => named(new RegExp("(a)", "u"), "a"));
output.null = caught(() => index(new RegExp("a", "u"), "b"));
const reentrant = new RegExp("(?<tag>a)", "g");
reentrant.lastIndex = {
	valueOf() {
		reentrant.compile("(?<other>b)", "g");
		return 0;
	},
};
const replaced = named(reentrant, "b");
output.reentrant = [typeof replaced, replaced];
const retainedPattern = new RegExp("(?<tag>[a-z]+)", "gu");
const first = named(retainedPattern, "Σalpha beta");
const second = named(retainedPattern, "Σalpha beta");
const garbage = Array.from({ length: 1000 }, (_, i) => ({ value: i }));
output.retained = [first, second, garbage.length];
const groups = escapedGroups(new RegExp("(?<tag>a)", "u"), "a");
output.groups = [groups.tag, Object.getPrototypeOf(groups) === null, Object.keys(groups)];
const result = escapedResult(new RegExp("(?<tag>a)", "du"), "Σa");
output.result = [result[0], result.index, result.groups.tag, result.indices.groups.tag];
const calls = [];
const custom = {
	lastIndex: 0,
	exec() {
		calls.push("exec");
		return {
			0: "abab",
			index: 2,
			get groups() {
				calls.push("groups");
				return { tag: "ab" };
			},
		};
	},
};
output.custom = projected(custom, "ignored");
output.order = calls;
output.protoName = protoName(new RegExp("(?<tag>a)|(?<__proto__>b)", "u"), "b");
output.chain = namedChain(new RegExp("(?<tag> +abc +)", "u"), "Σ abc ");
console.log(JSON.stringify(output));
