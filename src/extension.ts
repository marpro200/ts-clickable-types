import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Built-in / global TypeScript types we do NOT want to show as "jump" links
// ---------------------------------------------------------------------------
const BUILTIN_TYPES = new Set([
	// Core utility types
	'Array', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
	'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
	'Extract', 'Exclude', 'ReturnType', 'InstanceType', 'Parameters',
	'ConstructorParameters', 'NonNullable', 'Awaited',
	'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize',
	'TemplateStringsArray', 'PropertyKey', 'ClassDecorator',
	// Primitives & wrappers
	'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
	'Function', 'RegExp', 'Date',
	// Errors
	'Error', 'TypeError', 'RangeError', 'ReferenceError',
	'SyntaxError', 'URIError', 'EvalError',
	// Buffers & typed arrays
	'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
	'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
	'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
	'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
	// Iterables & generators
	'Generator', 'AsyncGenerator', 'Iterator', 'AsyncIterator',
	'Iterable', 'AsyncIterable', 'IterableIterator', 'AsyncIterableIterator',
	'ReadonlyArray', 'ReadonlyMap', 'ReadonlySet',
	'PromiseLike', 'Thenable',
	// DOM & Web APIs
	'EventTarget', 'Event', 'CustomEvent', 'AbortSignal', 'AbortController',
	'URL', 'URLSearchParams', 'FormData', 'Headers', 'Request', 'Response',
	'ReadableStream', 'WritableStream', 'TransformStream',
	'Blob', 'File', 'FileList', 'FileReader',
	'Worker', 'MessageEvent', 'MessageChannel', 'MessagePort',
	'Window', 'Document', 'Element', 'HTMLElement', 'SVGElement',
	'Node', 'NodeList', 'Attr', 'Console',
	'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
	'Storage', 'Navigator', 'Location', 'History',
	'XMLHttpRequest', 'WebSocket', 'EventSource',
	'Performance', 'PerformanceObserver',
	'Proxy', 'Reflect', 'JSON', 'Math', 'Intl',
	// React namespace
	'React',
]);

const LANGUAGES = [
	{ language: 'typescript' },
	{ language: 'typescriptreact' },
	{ language: 'javascript' },
	{ language: 'javascriptreact' },
];

const COMMAND_ID = 'tsClickableTypes.goToTypeDefinition';

// Re-entrancy depth counter — more robust than a boolean flag.
// Allows us to correctly handle overlapping async hover calls.
let providingDepth = 0;

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_ID, goToTypeDefinition),
		vscode.languages.registerHoverProvider(LANGUAGES, { provideHover }),
	);
}

export function deactivate() { }

// ---------------------------------------------------------------------------
// Hover Provider
// ---------------------------------------------------------------------------
async function provideHover(
	document: vscode.TextDocument,
	position: vscode.Position,
): Promise<vscode.Hover | undefined> {
	if (providingDepth > 0) {
		return undefined;
	}

	providingDepth++;
	try {
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider',
			document.uri,
			position,
		);

		if (!hovers || hovers.length === 0) {
			return undefined;
		}

		// Collect all hover text so we can scan for type names
		let combinedText = '';
		for (const hover of hovers) {
			for (const content of hover.contents) {
				const md = toMarkdownString(content);
				if (md) {
					combinedText += md.value + '\n';
				}
			}
		}

		const typeNames = extractTypeNames(combinedText);
		if (typeNames.length === 0) {
			return undefined;
		}

		// Build clickable links for each detected type
		const baseArgs = {
			uri: document.uri.toString(),
			line: position.line,
			character: position.character,
		};

		const links = typeNames.map((name) => {
			const encoded = encodeURIComponent(
				JSON.stringify({ ...baseArgs, typeName: name }),
			);
			return `[${name}](command:${COMMAND_ID}?${encoded} "Jump to ${name}")`;
		});

		const linksRow = new vscode.MarkdownString(
			`🔗 **Go to type:** ${links.join('&ensp;·&ensp;')}`,
		);
		linksRow.isTrusted = true;

		return new vscode.Hover(linksRow);
	} finally {
		providingDepth--;
	}
}

// ---------------------------------------------------------------------------
// Command: Go to Type Definition
// ---------------------------------------------------------------------------
async function goToTypeDefinition(args: {
	uri: string;
	line: number;
	character: number;
	typeName: string;
}): Promise<void> {
	const uri = vscode.Uri.parse(args.uri);
	const hoverPosition = new vscode.Position(args.line, args.character);

	// Strategy 1: Find the type name in the source text near the hover position,
	// then ask the TS language server for its type definition.
	if (await tryTypeDefinitionProvider(uri, hoverPosition, args.typeName)) {
		return;
	}

	// Strategy 2: Fall back to workspace symbol search.
	if (await tryWorkspaceSymbolSearch(args.typeName)) {
		return;
	}

	vscode.window.showInformationMessage(
		`Could not find definition for type: ${args.typeName}`,
	);
}

async function tryTypeDefinitionProvider(
	uri: vscode.Uri,
	hoverPosition: vscode.Position,
	typeName: string,
): Promise<boolean> {
	try {
		const document = await vscode.workspace.openTextDocument(uri);
		const typePos = findTypeNamePosition(document, hoverPosition, typeName);
		const lookupPos = typePos ?? hoverPosition;

		const locations = await vscode.commands.executeCommand<
			(vscode.Location | vscode.LocationLink)[]
		>('vscode.executeTypeDefinitionProvider', uri, lookupPos);

		if (locations && locations.length > 0) {
			const loc = locations[0];
			const targetUri = 'uri' in loc ? loc.uri : loc.targetUri;
			const targetRange =
				'range' in loc
					? loc.range
					: loc.targetSelectionRange ?? loc.targetRange;
			await vscode.window.showTextDocument(targetUri, {
				selection: targetRange,
				preview: false,
			});
			return true;
		}
	} catch {
		// fall through
	}
	return false;
}

async function tryWorkspaceSymbolSearch(typeName: string): Promise<boolean> {
	try {
		const symbols = await vscode.commands.executeCommand<
			vscode.SymbolInformation[]
		>('vscode.executeWorkspaceSymbolProvider', typeName);

		if (symbols && symbols.length > 0) {
			const typeKinds = new Set([
				vscode.SymbolKind.Interface,
				vscode.SymbolKind.Class,
				vscode.SymbolKind.Enum,
				vscode.SymbolKind.TypeParameter,
				vscode.SymbolKind.Struct,
			]);

			const best =
				symbols.find((s) => s.name === typeName && typeKinds.has(s.kind)) ??
				symbols.find((s) => s.name === typeName) ??
				symbols[0];

			await vscode.window.showTextDocument(best.location.uri, {
				selection: best.location.range,
				preview: false,
			});
			return true;
		}
	} catch {
		// fall through
	}
	return false;
}

// ---------------------------------------------------------------------------
// Find the position of a type name in the document near the hover position
// ---------------------------------------------------------------------------
function findTypeNamePosition(
	document: vscode.TextDocument,
	hoverPosition: vscode.Position,
	typeName: string,
): vscode.Position | null {
	const searchRange = 5;
	const startLine = Math.max(0, hoverPosition.line - searchRange);
	const endLine = Math.min(document.lineCount - 1, hoverPosition.line + searchRange);

	const regex = new RegExp(`\\b${escapeRegExp(typeName)}\\b`, 'g');

	// Search hovered line first, preferring closest match to hover character
	const hoveredText = document.lineAt(hoverPosition.line).text;
	let bestMatch: vscode.Position | null = null;
	let bestDistance = Infinity;
	let m: RegExpExecArray | null;

	regex.lastIndex = 0;
	while ((m = regex.exec(hoveredText)) !== null) {
		const dist = Math.abs(m.index - hoverPosition.character);
		if (dist < bestDistance) {
			bestDistance = dist;
			bestMatch = new vscode.Position(hoverPosition.line, m.index);
		}
	}
	if (bestMatch) {
		return bestMatch;
	}

	// Fall back to surrounding lines
	for (let line = startLine; line <= endLine; line++) {
		if (line === hoverPosition.line) {
			continue;
		}
		const lineText = document.lineAt(line).text;
		regex.lastIndex = 0;
		const match = regex.exec(lineText);
		if (match) {
			return new vscode.Position(line, match.index);
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Type name extraction from hover markdown text
// ---------------------------------------------------------------------------
function extractTypeNames(hoverText: string): string[] {
	const found = new Set<string>();

	// Exclude the declared symbol name (e.g. "X" from "const X: ...")
	// since it's the variable/function name, not a type reference.
	const symbolNames = new Set<string>();
	const symbolPattern = /(?:const|let|var|function|class)\s+([A-Z][a-zA-Z0-9_]*)/g;
	let s: RegExpExecArray | null;
	while ((s = symbolPattern.exec(hoverText)) !== null) {
		symbolNames.add(s[1]);
	}

	// Scan fenced code blocks
	const fenced = /```[\w]*\n([\s\S]*?)\n```/g;
	let m: RegExpExecArray | null;
	while ((m = fenced.exec(hoverText)) !== null) {
		scanForPascalCaseTypes(m[1], found, symbolNames);
	}

	// Scan inline code spans
	const inline = /`([^`\n]+)`/g;
	while ((m = inline.exec(hoverText)) !== null) {
		scanForPascalCaseTypes(m[1], found, symbolNames);
	}

	return Array.from(found);
}

function scanForPascalCaseTypes(
	code: string,
	found: Set<string>,
	exclude: Set<string>,
): void {
	const pascal = /\b([A-Z][a-zA-Z0-9_]*)\b/g;
	let m: RegExpExecArray | null;
	while ((m = pascal.exec(code)) !== null) {
		const name = m[1];
		if (!BUILTIN_TYPES.has(name) && !exclude.has(name)) {
			found.add(name);
		}
	}
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
type MarkedString = { language: string; value: string } | string;

function toMarkdownString(
	content: vscode.MarkdownString | MarkedString,
): vscode.MarkdownString | null {
	if (content instanceof vscode.MarkdownString) {
		return new vscode.MarkdownString(content.value);
	}
	if (typeof content === 'string') {
		return new vscode.MarkdownString(content);
	}
	if (typeof content === 'object' && 'value' in content && 'language' in content) {
		const md = new vscode.MarkdownString();
		md.appendCodeblock(content.value, content.language);
		return md;
	}
	return null;
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
