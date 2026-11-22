import * as path from "node:path";
import vm from "node:vm";

const cases = {
	async eval() {
		const namespace = await eval('import("node:path")');
		console.log(namespace === path, namespace.basename("/sample/file"));
	},
	async function() {
		const load = Function("specifier", "return import(specifier)");
		const [prefixed, bare] = await Promise.all([
			load("node:querystring"),
			load("querystring"),
		]);
		console.log(
			prefixed === bare,
			Object.prototype.toString.call(bare),
			Object.keys(bare).join(","),
			bare.stringify({ sample: "value" }),
		);
	},
	async vm() {
		const namespace = await vm.runInThisContext('import("path")', {
			importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
		});
		console.log(namespace === path);
	},
	async first() {
		const namespace = await eval('import("node:path/win32")');
		const { win32 } = await import("./eval-dynamic-import-static.mjs");
		console.log(
			namespace === win32,
			namespace !== path,
			namespace.default === path.win32,
		);
	},
	async source() {
		const namespace = await eval('import("node:test")');
		console.log(
			namespace.default === process.getBuiltinModule("node:test"),
			namespace.test === namespace.default,
			typeof namespace.describe,
		);
	},
	async missing() {
		const promise = eval('import("maligator-eval-missing-fixture")');
		console.log(promise instanceof Promise);
		try {
			await promise;
		} catch (error) {
			console.log(error.name, error.code, error.message);
		}
	},
	async attributes() {
		try {
			await eval('import("node:path", { with: { type: "json" } })');
		} catch (error) {
			console.log(error.name, error.code);
		}
	},
	async shadow() {
		const realm = new ShadowRealm();
		const load = realm.evaluate(`
			(resolve, reject) => {
				Promise.all([import("node:path"), import("path")]).then(
					([prefixed, bare]) => resolve(prefixed === bare ? bare.basename("/sample/file") : "different"),
					error => reject(error.name + " " + error.code)
				);
			}
		`);
		console.log(await new Promise((resolve, reject) => load(resolve, reject)));
	},
};

await cases[process.env.MAL_EVAL_IMPORT_CASE]();
