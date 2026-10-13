const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const foreign = $262.createRealm().global,
	rows = [];
function start(source, target, filler) {
	const part = source.slice(1, -1);
	return part.padStart(target, filler);
}
function end(source, target, filler) {
	const part = source.slice(1, -1);
	return part.padEnd(target, filler);
}
globalThis.padStartRegion = start;
globalThis.padEndRegion = end;
for (const name of ["padStart", "padEnd"]) {
	const saved = String.prototype[name];
	String.prototype[name] = foreign.String.prototype[name];
	try {
		const invoke =
			name === "padStart" ? globalThis.padStartRegion : globalThis.padEndRegion;
		rows.push(
			invoke("xaby", 7, "😀"),
			invoke("xaby", 0, Symbol("ignored")),
			invoke("xaby", Infinity, ""),
		);
		for (const [target, filler, Expected] of [
			[Infinity, "_", foreign.RangeError],
			[1n, "_", foreign.TypeError],
			[5, Symbol("bad"), foreign.TypeError],
		]) {
			try {
				invoke("xaby", target, filler);
				throw new Error("missing foreign error");
			} catch (e) {
				if (!(e instanceof Expected)) throw e;
				rows.push(e instanceof Expected, e instanceof TypeError, e instanceof RangeError);
			}
		}
		try {
			invoke("xaby", Infinity, {
				toString() {
					String.prototype[name] = () => "changed";
					collectGarbage();
					return "_";
				},
			});
			throw new Error("missing captured error");
		} catch (e) {
			if (!(e instanceof foreign.RangeError)) throw e;
			rows.push("captured");
		}
		String.prototype[name] = foreign.String.prototype[name];
		const marker = { original: true };
		try {
			invoke("xaby", 5, {
				toString() {
					collectGarbage();
					throw marker;
				},
			});
			throw new Error("missing original");
		} catch (e) {
			if (e !== marker) throw e;
			rows.push("original");
		}
	} finally {
		String.prototype[name] = saved;
	}
}
console.log(JSON.stringify(rows));
