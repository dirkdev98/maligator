/* oxlint-disable no-console -- The fixture reports successful native behavior. */
import {
	release_open,
	release_busy,
	release_value,
	release_same,
	release_close,
	release_watch,
	release_always_open,
	release_always_close,
	release_always_read,
	release_live,
	RELEASE_OK,
	RELEASE_BUSY,
} from "maligator:ffi/release";

function check(value: boolean, message: string): void {
	if (!value) throw new Error(message);
}
function rejects(
	operation: () => unknown,
	kind: new (message?: string) => Error,
	message?: string,
): void {
	let caught = false;
	try {
		operation();
	} catch (error) {
		caught =
			error instanceof kind && (message === undefined || error.message.includes(message));
	}
	check(caught, "expected cleanup or closed-handle failure");
}

check(release_close(null) === RELEASE_OK, "nullable cleanup");
const direct = release_open(7)!;
const alias = release_same(direct)!;
release_busy(direct, true);
check(release_close(direct) === RELEASE_BUSY, "direct cleanup preserves status");
check(
	release_value(alias) === 7 && release_same(direct) === direct,
	"failed cleanup preserves identity",
);
release_busy(alias, false);
check(release_close(alias) === RELEASE_OK, "direct cleanup retries");
rejects(() => release_value(direct), TypeError);

const disposed = release_open(11)!;
release_busy(disposed, true);
rejects(() => disposed[Symbol.dispose](), Error, "release_close");
check(release_value(disposed) === 11, "failed disposal remains usable");
release_busy(disposed, false);
disposed[Symbol.dispose]();
disposed[Symbol.dispose]();
rejects(() => release_value(disposed), TypeError);

for (const viaDispose of [false, true]) {
	const resource = release_open(13)!;
	let calls = 0;
	release_watch(resource, (lent) => {
		check(lent === resource, "closing callbacks keep pointer identity");
		rejects(() => resource[Symbol.dispose](), TypeError);
		rejects(() => release_close(resource), TypeError);
		rejects(() => release_value(resource), TypeError);
		calls++;
		throw new Error("cleanup callback failed");
	});
	const close = () => (viaDispose ? resource[Symbol.dispose]() : release_close(resource));
	release_busy(resource, true);
	rejects(close, Error, "cleanup callback failed");
	check(
		calls === 1 && release_value(resource) === 13,
		"failure restores handle after callback throw",
	);
	release_busy(resource, false);
	rejects(close, Error, "cleanup callback failed");
	check(calls === 2, "callback remains installed after failed cleanup");
	rejects(() => release_value(resource), TypeError);
}

const always = release_always_open()!;
check(
	release_always_close(always) === 7,
	"unconditional cleanup preserves nonzero status",
);
rejects(() => release_always_read(always), TypeError);
const alwaysDisposed = release_always_open()!;
alwaysDisposed[Symbol.dispose]();
rejects(() => release_always_read(alwaysDisposed), TypeError);
check(release_live() === 0, "all resources released");
console.log("conditional cleanup passed");
