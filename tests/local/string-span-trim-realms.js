const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc;
const other = $262.createRealm().global;
const rows = [];
function trim(value) {
	const token = value.trim();
	collectGarbage?.();
	return [token.length, token.charAt(0), `value:${token}`];
}
function start(value) {
	const token = value.trimStart();
	collectGarbage?.();
	return [token.length, token.at(-1), `value:${token}`];
}
function end(value) {
	const token = value.trimEnd();
	collectGarbage?.();
	return [token.length, token.codePointAt(0), `value:${token}`];
}
function left(value) {
	const token = value.trimLeft(Symbol("ignored"), 1n, {}, null);
	collectGarbage?.();
	return [token.length, token.charAt(0), `value:${token}`];
}
function right(value) {
	const token = value.trimRight(Symbol("ignored"), 1n, {}, null);
	collectGarbage?.();
	return [token.length, token.at(-1), `value:${token}`];
}
for (const [method, inspect] of [
	["trim", trim],
	["trimStart", start],
	["trimEnd", end],
	["trimLeft", left],
	["trimRight", right],
]) {
	const original = String.prototype[method];
	String.prototype[method] = other.String.prototype[method];
	rows.push(inspect("\ufeff😀\u2029"));
	const boxed = new String(" 12 "),
		events = [];
	boxed.toString = function () {
		events.push("receiver");
		collectGarbage?.();
		return " 12 ";
	};
	rows.push(inspect(boxed), events);
	boxed.toString = function () {
		collectGarbage?.();
		return Symbol("bad receiver");
	};
	try {
		inspect(boxed);
	} catch (error) {
		rows.push(error instanceof other.TypeError, error instanceof TypeError);
	}
	boxed.toString = function () {
		collectGarbage?.();
		throw new RangeError("local receiver");
	};
	try {
		inspect(boxed);
	} catch (error) {
		rows.push(error instanceof other.RangeError, error instanceof RangeError);
	}
	boxed.toString = function () {
		String.prototype[method] = () => "override";
		collectGarbage?.();
		return " 12 ";
	};
	rows.push(inspect(boxed), inspect(" 12 "));
	String.prototype[method] = original;
}
console.log(JSON.stringify(rows));
