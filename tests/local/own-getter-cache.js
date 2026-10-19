// Own accessors in dictionary receivers read repeatedly from one site while they change.

let calls = 0;

function createInstance(namespace) {
	let override = null;
	function instance() {
		return instance.enabled ? `${namespace} on` : `${namespace} off`;
	}
	instance.namespace = namespace;
	instance.extend = () => namespace;
	Object.defineProperty(instance, "enabled", {
		enumerable: true,
		configurable: true,
		get: () => {
			calls++;
			return override ?? namespace.length % 2 === 0;
		},
		set: (value) => {
			override = value;
		},
	});
	return instance;
}

function readEnabled(target) {
	return target.enabled;
}

const lines = [];
const instances = ["ab", "abc", "abcd"].map(createInstance);
let enabled = 0;
for (let round = 0; round < 50; round++)
	for (const instance of instances) if (readEnabled(instance)) enabled++;
lines.push(`steady ${enabled} calls ${calls}`);
lines.push(instances.map((instance) => instance()).join(", "));

instances[1].enabled = true;
lines.push(`override ${instances.map(readEnabled).join(" ")}`);

Object.defineProperty(instances[0], "enabled", {
	get() {
		calls++;
		return `redefined ${this.namespace}`;
	},
	configurable: true,
});
lines.push(`redefined ${readEnabled(instances[0])}`);

Object.defineProperty(instances[0], "enabled", { value: "data", configurable: true });
lines.push(`data ${readEnabled(instances[0])}`);

delete instances[2].enabled;
lines.push(`deleted ${readEnabled(instances[2])}`);
Object.setPrototypeOf(instances[2], { enabled: "inherited" });
lines.push(`inherited ${readEnabled(instances[2])}`);

Object.defineProperty(instances[1], "enabled", { set() {}, get: undefined });
lines.push(`set-only ${readEnabled(instances[1])}`);

const dictionary = {};
for (let index = 0; index < 40; index++) dictionary[`field${index}`] = index;
delete dictionary.field0;
Object.defineProperty(dictionary, "enabled", {
	get() {
		calls++;
		if (this.field1 < 0) throw new RangeError(`negative ${this.field1}`);
		return this.field1 + this.field2;
	},
	configurable: true,
});
let total = 0;
for (let round = 0; round < 20; round++) total += readEnabled(dictionary);
lines.push(`dictionary ${total}`);
dictionary.field1 = -1;
try {
	readEnabled(dictionary);
} catch (error) {
	lines.push(`threw ${error.name}: ${error.message}`);
}

const array = [1, 2, 3];
Object.defineProperty(array, "enabled", { get: () => array.length });
lines.push(`array ${readEnabled(array)} ${readEnabled({ enabled: "plain" })}`);
lines.push(`calls ${calls}`);
console.log(lines.join("\n"));
