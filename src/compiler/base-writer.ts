export class BaseWriter {
	private contents: Array<string> = [];
	private currentIndent: number = 0;

	indent() {
		this.currentIndent++;
		return this;
	}

	dedent() {
		this.currentIndent = Math.max(0, this.currentIndent - 1);

		return this;
	}

	block(header: string, body: () => void) {
		this.writeWithIdent(header).indent();
		body();
		return this.dedent();
	}

	write(str: string | Array<string>) {
		this.writeWithIdent(str);

		return this;
	}

	writeRaw(str: string | Array<string>) {
		if (typeof str === "string") {
			this.contents.push(str);
		} else {
			this.contents.push(...str);
		}

		return this;
	}

	private formatIdent() {
		return "  ".repeat(this.currentIndent);
	}

	private writeWithIdent(str: string | Array<string>) {
		if (typeof str === "string") {
			this.contents.push(this.formatIdent() + str);
		} else {
			for (const s of str) {
				this.contents.push(this.formatIdent() + s);
			}
		}

		return this;
	}

	toString() {
		return this.contents.join("\n");
	}
}
