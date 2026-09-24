import { connect } from "node:net";

const socket = connect(65535, "localhost");
socket.on("error", () => console.log("done"));
socket.on("connect", () => {
	socket.destroy();
	console.log("done");
});
