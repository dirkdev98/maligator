let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function caught(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

function collect() {
	if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
}

ok("constructor is installed", typeof ShadowRealm === "function");
ok("constructor requires new", caught(() => ShadowRealm()) instanceof TypeError);

const realm = new ShadowRealm();
ok("instance", realm instanceof ShadowRealm);
ok("instance prototype", Object.getPrototypeOf(realm) === ShadowRealm.prototype);
collect();

ok("number evaluate", realm.evaluate("40 + 2") === 42);
ok("string evaluate", realm.evaluate("'primitive'") === "primitive");
ok("null evaluate", realm.evaluate("null") === null);

globalThis.shadowRealmState = "outer";
ok(
	"isolated global starts clean",
	realm.evaluate(
		"var clean = typeof globalThis.shadowRealmState === 'undefined'; globalThis.shadowRealmState = 17; clean",
	) === true,
);
ok("isolated global persists", realm.evaluate("globalThis.shadowRealmState") === 17);
ok("outer global is unchanged", globalThis.shadowRealmState === "outer");

const wrapped = realm.evaluate(
	"globalThis.echo = function echo(value) { return value; }; globalThis.echo.secret = 99; globalThis.echo",
);
ok("wrapped callable", typeof wrapped === "function" && wrapped(8) === 8);
ok("wrapper prototype", Object.getPrototypeOf(wrapped) === Function.prototype);
ok("wrapper is not constructable", caught(() => new wrapped()) instanceof TypeError);
ok("wrapper hides target properties", wrapped.secret === undefined);
wrapped.outerOnly = 23;
ok(
	"wrapper properties do not reach target",
	wrapped.outerOnly === 23 && realm.evaluate("globalThis.echo.outerOnly") === undefined,
);
ok("wrapper identity is fresh", realm.evaluate("globalThis.echo") !== wrapped);
collect();

const callCallback = realm.evaluate("(callback, value) => callback(value)");
const outerCallback = (value) => value + 5;
ok("callable argument wrapping", callCallback(outerCallback, 6) === 11);

const makeTriple = realm.evaluate("() => function triple(value) { return value * 3; }");
const triple = makeTriple();
ok(
	"callable result wrapping",
	typeof triple === "function" &&
		Object.getPrototypeOf(triple) === Function.prototype &&
		triple(7) === 21,
);
collect();

ok(
	"object result becomes caller TypeError",
	caught(() => realm.evaluate("({ answer: 42 })")) instanceof TypeError,
);
ok(
	"runtime throw becomes caller TypeError",
	caught(() => realm.evaluate("throw new Error('inner failure')")) instanceof TypeError,
);
ok(
	"initial syntax error is caller SyntaxError",
	caught(() => realm.evaluate("let broken =")) instanceof SyntaxError,
);
ok("nested ShadowRealm", realm.evaluate("new ShadowRealm().evaluate('20 + 22')") === 42);
ok(
	"Symbol.for crosses realm",
	realm.evaluate("Symbol.for('maligator-shadow-realm')") ===
		Symbol.for("maligator-shadow-realm"),
);
collect();

ok("checks ran", passed > 0);
console.log("shadow-realm PASS");
