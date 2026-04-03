import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Built-in / global TypeScript types we do NOT want to show as "jump" links
// ---------------------------------------------------------------------------
const BUILTIN_TYPES = new Set([
	"Array",
	"Promise",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"WeakRef",
	"Record",
	"Partial",
	"Required",
	"Readonly",
	"Pick",
	"Omit",
	"Extract",
	"Exclude",
	"ReturnType",
	"InstanceType",
	"Parameters",
	"ConstructorParameters",
	"NonNullable",
	"Awaited",
	"Uppercase",
	"Lowercase",
	"Capitalize",
	"Uncapitalize",
	"TemplateStringsArray",
	"PropertyKey",
	"ClassDecorator",
	"Object",
	"String",
	"Number",
	"Boolean",
	"Symbol",
	"BigInt",
	"Function",
	"RegExp",
	"Date",
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"ArrayBuffer",
	"SharedArrayBuffer",
	"DataView",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
	"Generator",
	"AsyncGenerator",
	"Iterator",
	"AsyncIterator",
	"Iterable",
	"AsyncIterable",
	"IterableIterator",
	"AsyncIterableIterator",
	"ReadonlyArray",
	"ReadonlyMap",
	"ReadonlySet",
	"PromiseLike",
	"Thenable",
	"EventTarget",
	"Event",
	"CustomEvent",
	"AbortSignal",
	"AbortController",
	"URL",
	"URLSearchParams",
	"FormData",
	"Headers",
	"Request",
	"Response",
	"ReadableStream",
	"WritableStream",
	"TransformStream",
	"Blob",
	"File",
	"FileList",
	"FileReader",
	"Worker",
	"MessageEvent",
	"MessageChannel",
	"MessagePort",
	"Window",
	"Document",
	"Element",
	"HTMLElement",
	"SVGElement",
	"Node",
	"NodeList",
	"Attr",
	"Console",
	"MutationObserver",
	"IntersectionObserver",
	"ResizeObserver",
	"Storage",
	"Navigator",
	"Location",
	"History",
	"XMLHttpRequest",
	"WebSocket",
	"EventSource",
	"Performance",
	"PerformanceObserver",
	"Proxy",
	"Reflect",
	"JSON",
	"Math",
	"Intl",
	"React", // avoid treating the React namespace as a user type
]);

// Guard against re-entrant calls (we call executeHoverProvider from inside provideHover)
let isProviding = false;

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
	// ── Command ──────────────────────────────────────────────────────────────
	const goToTypeCmd = vscode.commands.registerCommand(
		"tsClickableTypes.goToTypeDefinition",
		async (args: {
			uri: string;
			line: number;
			character: number;
			typeName: string;
		}) => {
			const uri = vscode.Uri.parse(args.uri);
			const position = new vscode.Position(args.line, args.character);

			// Strategy 1 – executeTypeDefinitionProvider at the hovered position
			try {
				const locations = await vscode.commands.executeCommand<
					(vscode.Location | vscode.LocationLink)[]
				>("vscode.executeTypeDefinitionProvider", uri, position);

				if (locations && locations.length > 0) {
					const loc = locations[0] as any;
					const targetUri: vscode.Uri = loc.uri ?? loc.targetUri;
					const targetRange: vscode.Range =
						loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
					await vscode.window.showTextDocument(targetUri, {
						selection: targetRange,
						preview: false,
					});
					return;
				}
			} catch (_) {
				// fall through to next strategy
			}

			// Strategy 2 – workspace symbol search by name
			try {
				const symbols = await vscode.commands.executeCommand<
					vscode.SymbolInformation[]
				>("vscode.executeWorkspaceSymbolProvider", args.typeName);

				if (symbols && symbols.length > 0) {
					const typeKinds = [
						vscode.SymbolKind.Interface,
						vscode.SymbolKind.Class,
						vscode.SymbolKind.Enum,
						vscode.SymbolKind.TypeParameter,
						vscode.SymbolKind.Struct,
					];
					const best =
						symbols.find(
							(s) => s.name === args.typeName && typeKinds.includes(s.kind),
						) ??
						symbols.find((s) => s.name === args.typeName) ??
						symbols[0];

					await vscode.window.showTextDocument(best.location.uri, {
						selection: best.location.range,
						preview: false,
					});
					return;
				}
			} catch (_) {
				// fall through
			}

			vscode.window.showInformationMessage(
				`Could not find definition for type: ${args.typeName}`,
			);
		},
	);

	// ── Hover provider ────────────────────────────────────────────────────────
	const hoverProvider = vscode.languages.registerHoverProvider(
		[
			{ language: "typescript" },
			{ language: "typescriptreact" },
			{ language: "javascript" },
			{ language: "javascriptreact" },
		],
		{
			async provideHover(
				document: vscode.TextDocument,
				position: vscode.Position,
			): Promise<vscode.Hover | undefined> {
				// Prevent infinite recursion
				if (isProviding) {
					return undefined;
				}
				isProviding = true;

				try {
					const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
						"vscode.executeHoverProvider",
						document.uri,
						position,
					);

					if (!hovers || hovers.length === 0) {
						return undefined;
					}

					// Rebuild hover contents so we can set isTrusted = true
					let combinedText = "";
					const rebuiltContents: vscode.MarkdownString[] = [];

					for (const hover of hovers) {
						for (const content of hover.contents) {
							const md = contentToMarkdownString(content);
							if (md) {
								md.isTrusted = true;
								rebuiltContents.push(md);
								combinedText += md.value + "\n";
							}
						}
					}

					// Extract user-defined type names from hover text
					const typeNames = extractTypeNames(combinedText);
					if (typeNames.length === 0) {
						return undefined;
					}

					// Build the "Jump to type" links row
					const baseArgs = {
						uri: document.uri.toString(),
						line: position.line,
						character: position.character,
					};

					const linkParts = typeNames.map((name) => {
						const encoded = encodeURIComponent(
							JSON.stringify({ ...baseArgs, typeName: name }),
						);
						return `[${name}](command:tsClickableTypes.goToTypeDefinition?${encoded} "Jump to ${name}")`;
					});

					const linksRow = new vscode.MarkdownString(
						`🔗 **Go to type:** ${linkParts.join("&ensp;·&ensp;")}`,
					);
					linksRow.isTrusted = true;
					linksRow.supportHtml = false;

					return new vscode.Hover(linksRow);
				} finally {
					isProviding = false;
				}
			},
		},
	);

	context.subscriptions.push(goToTypeCmd, hoverProvider);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MarkedString = { language: string; value: string } | string;

function contentToMarkdownString(
	content: vscode.MarkdownString | MarkedString,
): vscode.MarkdownString | null {
	if (content instanceof vscode.MarkdownString) {
		// Return a fresh copy so we can mutate isTrusted safely
		const copy = new vscode.MarkdownString(content.value);
		copy.isTrusted = content.isTrusted;
		copy.supportHtml = content.supportHtml;
		return copy;
	}
	if (typeof content === "string") {
		return new vscode.MarkdownString(content);
	}
	if (
		typeof content === "object" &&
		"value" in content &&
		"language" in content
	) {
		const md = new vscode.MarkdownString();
		md.appendCodeblock(
			(content as { value: string; language: string }).value,
			(content as { value: string; language: string }).language,
		);
		return md;
	}
	return null;
}

function extractTypeNames(hoverText: string): string[] {
	const found = new Set<string>();

	// Scan inside fenced code blocks  ``` ... ```
	const fenced = /```[\w]*\n([\s\S]*?)\n```/g;
	let m: RegExpExecArray | null;
	while ((m = fenced.exec(hoverText)) !== null) {
		scanForPascalCaseTypes(m[1], found);
	}

	// Also scan bare inline code  `...`
	const inline = /`([^`\n]+)`/g;
	while ((m = inline.exec(hoverText)) !== null) {
		scanForPascalCaseTypes(m[1], found);
	}

	return Array.from(found);
}

function scanForPascalCaseTypes(code: string, found: Set<string>) {
	// PascalCase identifiers are almost always user-defined types
	const pascal = /\b([A-Z][a-zA-Z0-9_]*)\b/g;
	let m: RegExpExecArray | null;
	while ((m = pascal.exec(code)) !== null) {
		const name = m[1];
		if (!BUILTIN_TYPES.has(name)) {
			found.add(name);
		}
	}
}

export function deactivate() {}
