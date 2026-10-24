const TOKEN =
	/\/\/.*$|\/\*.*?(?:\*\/|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:0x[\da-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?n?)\b|\b[A-Za-z_]\w*\b/gi;
const KEYWORDS = new Set(
	"async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield sizeof typedef struct enum extern inline restrict".split(
		" ",
	),
);
const TYPES = new Set(
	"f64 f32 i8 i16 i32 i64 u8 u16 u32 u64 bool char double float int long short unsigned signed nullptr MalValue MalVm MalEnv".split(
		" ",
	),
);

function paintLine(text: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	let offset = 0;
	for (const match of text.matchAll(TOKEN)) {
		fragment.append(document.createTextNode(text.slice(offset, match.index)));
		const token = match[0];
		const kind =
			token.startsWith("//") || token.startsWith("/*")
				? "comment"
				: /["'`]/.test(token[0]!)
					? "string"
					: /^\d/.test(token)
						? "number"
						: KEYWORDS.has(token)
							? "keyword"
							: TYPES.has(token)
								? "type"
								: undefined;
		if (kind === undefined) fragment.append(document.createTextNode(token));
		else {
			const span = document.createElement("span");
			span.className = `syntax-${kind}`;
			span.textContent = token;
			fragment.append(span);
		}
		offset = match.index + token.length;
	}
	fragment.append(document.createTextNode(text.slice(offset)));
	return fragment;
}

export class ExplorerCodeView {
	readonly input: HTMLTextAreaElement;
	readonly #paint: HTMLElement;
	readonly #gutter: HTMLElement;
	readonly #lineHeight: number;
	#lines = [""];
	#baseLine = 1;
	#highlights: ReadonlyArray<{ startLine: number; endLine: number }> = [];
	#programmaticScroll?: number;
	#lastScrollTop = 0;
	#frame?: number;
	onSelect?: (line: number, column: number) => void;
	onScroll?: (firstLine: number, lastLine: number) => void;
	onEdit?: () => void;

	constructor(root: HTMLElement) {
		this.input = root.querySelector("textarea")!;
		this.#paint = root.querySelector(".code-paint")!;
		this.#gutter = root.querySelector(".code-gutter")!;
		this.#lineHeight = parseFloat(getComputedStyle(this.input).lineHeight);
		this.input.addEventListener("input", () => {
			this.#lines = this.input.value.split("\n");
			this.#highlights = [];
			this.onEdit?.();
			this.paint();
		});
		this.input.addEventListener("scroll", () => {
			this.paint();
			const programmatic = this.#programmaticScroll === this.input.scrollTop;
			this.#programmaticScroll = undefined;
			const moved = this.#lastScrollTop !== this.input.scrollTop;
			this.#lastScrollTop = this.input.scrollTop;
			if (!programmatic && moved) this.onScroll?.(this.firstLine, this.lastLine);
		});
		const select = () => {
			this.#programmaticScroll = this.input.scrollTop;
			const prefix = this.input.value.slice(0, this.input.selectionStart);
			const lines = prefix.split("\n");
			this.onSelect?.(this.#baseLine + lines.length - 1, lines.at(-1)!.length + 1);
		};
		this.input.addEventListener("click", select);
		this.input.addEventListener("keyup", select);
		new ResizeObserver(() => this.paint()).observe(root);
	}

	get text(): string {
		return this.input.value;
	}
	get firstLine(): number {
		return this.#baseLine + Math.floor(this.input.scrollTop / this.#lineHeight);
	}
	get lastLine(): number {
		return Math.min(
			this.#baseLine + this.#lines.length - 1,
			this.firstLine + Math.ceil(this.input.clientHeight / this.#lineHeight) - 1,
		);
	}

	setText(text: string, baseLine = 1): void {
		this.input.value = text;
		this.#lines = text.split("\n");
		this.#baseLine = baseLine;
		this.#highlights = [];
		this.input.scrollTop = this.input.scrollLeft = 0;
		this.#programmaticScroll = 0;
		this.paint();
	}

	highlight(ranges: ReadonlyArray<{ startLine: number; endLine: number }>): void {
		this.#highlights = ranges;
		this.paint();
	}

	reveal(line: number): void {
		if (line >= this.firstLine + 2 && line <= this.lastLine - 2) return;
		this.input.scrollTop = Math.max(0, (line - this.#baseLine - 3) * this.#lineHeight);
		this.#programmaticScroll = this.input.scrollTop;
		this.paint();
	}

	paint(): void {
		if (this.#frame !== undefined) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = undefined;
			const start = Math.max(0, this.firstLine - this.#baseLine - 2);
			const end = Math.min(this.#lines.length, this.lastLine - this.#baseLine + 4);
			const code = document.createDocumentFragment();
			const gutter = document.createDocumentFragment();
			for (let index = start; index < end; index++) {
				const line = index + this.#baseLine;
				const active = this.#highlights.some(
					(range) => line >= range.startLine && line <= range.endLine,
				);
				const row = document.createElement("span");
				row.className = `code-row${active ? " is-linked" : ""}`;
				row.dataset.line = String(line);
				const content = document.createElement("span");
				content.className = "code-text";
				content.style.transform = `translateX(${-this.input.scrollLeft}px)`;
				content.append(paintLine(this.#lines[index] ?? ""));
				row.append(content);
				code.append(row);
				const number = document.createElement("span");
				number.className = `gutter-row${active ? " is-linked" : ""}`;
				number.textContent = String(line);
				gutter.append(number);
			}
			const transform = `translateY(${start * this.#lineHeight - this.input.scrollTop}px)`;
			this.#paint.style.transform = transform;
			this.#gutter.style.transform = transform;
			this.#paint.replaceChildren(code);
			this.#gutter.replaceChildren(gutter);
		});
	}
}
