function work() {
	let checksum = 0;
	for (let index = 0; index < 2_000_000; index++) checksum = (checksum + index) | 0;
	globalThis.profileChecksum = checksum;
	if (!globalThis.profileReady) {
		globalThis.profileReady = true;
		console.log("profile-ready");
	}
	setTimeout(work, 1);
}
work();
