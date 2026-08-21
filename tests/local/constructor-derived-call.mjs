let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error(`constructor-derived-call failure: ${name}`);
	checks++;
}

class Service {
	run(value) {
		this.last = value;
		return value + 100;
	}
}

function invokeService(value) {
	try {
		return new Service().run(value);
	} catch (error) {
		return error.message;
	}
}

ok("prototype method", invokeService(5) === 105);
Service.prototype.run = function replacement(value) {
	return value + 200;
};
ok("prototype replacement fallback", invokeService(5) === 205);
let accessorReads = 0;
Object.defineProperty(Service.prototype, "run", {
	configurable: true,
	get() {
		accessorReads++;
		throw new Error("prototype accessor throw");
	},
});
ok(
	"prototype accessor fallback",
	invokeService(5) === "prototype accessor throw" && accessorReads === 1,
);

let capturedReceiver;
function makeCapturedService(offset) {
	return class {
		run(value) {
			capturedReceiver = this;
			this.last = value;
			return value + offset;
		}
	};
}
let CapturedService = makeCapturedService(700);
function invokeCapturedService(value) {
	return new CapturedService().run(value);
}
ok(
	"captured prototype method",
	invokeCapturedService(5) === 705 && capturedReceiver.last === 5,
);
CapturedService = makeCapturedService(800);
ok(
	"same-index closure replacement",
	invokeCapturedService(5) === 805 && capturedReceiver.last === 5,
);

let ReboundService = class {
	run(value) {
		return value + 900;
	}
};
function invokeReboundService(value) {
	return new ReboundService().run(value);
}
ok("constructor binding hit", invokeReboundService(5) === 905);
ReboundService = class {
	run(value) {
		return value + 1000;
	}
};
ok("constructor binding replacement", invokeReboundService(5) === 1005);

class ReturningService {
	constructor() {
		return {
			run(value) {
				return value + 300;
			},
		};
	}

	run(value) {
		return value + 400;
	}
}
ok("explicit object substitution", new ReturningService().run(5) === 305);

class BaseService {
	run(value) {
		return value + 500;
	}
}
class DerivedService extends BaseService {}
ok("derived construction", new DerivedService().run(5) === 505);

const ProxiedService = new Proxy(BaseService, {
	construct() {
		return {
			run(value) {
				return value + 600;
			},
		};
	},
});
ok("proxy construction", new ProxiedService().run(5) === 605);
ok("check count", checks === 10);

console.log("constructor-derived-call PASS");
