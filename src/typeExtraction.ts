// ---------------------------------------------------------------------------
// Built-in / global TypeScript types we do NOT want to show as "jump" links
// ---------------------------------------------------------------------------
export const BUILTIN_TYPES = new Set([
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

// ---------------------------------------------------------------------------
// Module-scoped regex constants — hoisted to avoid per-call recompilation.
// All use the `g` flag; callers must reset lastIndex = 0 before each use.
// ---------------------------------------------------------------------------

// Excludes the declared symbol name (e.g. "X" from "type X = ..." or "const X: ...").
// Covers all declaration keywords so hovering on a declaration doesn't self-link.
const SYMBOL_PATTERN = /(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Z][a-zA-Z0-9_]*)/g;

// Matches fenced code blocks in hover markdown.
const FENCED_BLOCK = /```[\w]*\n([\s\S]*?)\n```/g;

// Matches inline code spans in hover markdown.
const INLINE_CODE = /`([^`\n]+)`/g;

// Matches PascalCase identifiers — requires at least one lowercase letter to
// exclude ALL_CAPS constants (e.g. MAX_RETRY, API_KEY) which are not types.
const PASCAL_CASE = /\b([A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*)\b/g;

// ---------------------------------------------------------------------------
// Type name extraction from hover markdown text
// ---------------------------------------------------------------------------
export function extractTypeNames(
	hoverText: string,
	additionalExclusions?: ReadonlySet<string>,
): string[] {
	const found = new Set<string>();

	// Exclude the declared symbol name (e.g. "X" from "const X: ...")
	// since it's the variable/function name, not a type reference.
	const symbolNames = new Set<string>();
	SYMBOL_PATTERN.lastIndex = 0;
	let s: RegExpExecArray | null;
	while ((s = SYMBOL_PATTERN.exec(hoverText)) !== null) {
		symbolNames.add(s[1]);
	}

	// Scan fenced code blocks
	FENCED_BLOCK.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FENCED_BLOCK.exec(hoverText)) !== null) {
		scanForPascalCaseTypes(m[1], found, symbolNames, additionalExclusions);
	}

	// Scan inline code spans
	INLINE_CODE.lastIndex = 0;
	while ((m = INLINE_CODE.exec(hoverText)) !== null) {
		scanForPascalCaseTypes(m[1], found, symbolNames, additionalExclusions);
	}

	return Array.from(found);
}

export function scanForPascalCaseTypes(
	code: string,
	found: Set<string>,
	exclude: Set<string>,
	additionalExclusions?: ReadonlySet<string>,
): void {
	PASCAL_CASE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = PASCAL_CASE.exec(code)) !== null) {
		const name = m[1];
		if (!BUILTIN_TYPES.has(name) && !exclude.has(name) && !additionalExclusions?.has(name)) {
			found.add(name);
		}
	}
}

export function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Pure position search — extracted so it can be unit-tested without VS Code
// ---------------------------------------------------------------------------

export interface LinePosition {
	line: number;
	character: number;
}

/**
 * Finds the position of a type name in a set of lines near a hover location.
 * Searches the hovered line first (preferring the match closest to the hover
 * character), then falls back to surrounding lines within searchRange.
 * Returns null if the type name is not found.
 */
export function findTypeNameInLines(
	lines: string[],
	hoverLine: number,
	hoverCharacter: number,
	typeName: string,
	searchRange = 5,
): LinePosition | null {
	const regex = new RegExp(`\\b${escapeRegExp(typeName)}\\b`, 'g');
	const startLine = Math.max(0, hoverLine - searchRange);
	const endLine = Math.min(lines.length - 1, hoverLine + searchRange);

	// Search hovered line first, preferring match closest to hover character
	let bestMatch: LinePosition | null = null;
	let bestDistance = Infinity;
	let m: RegExpExecArray | null;

	regex.lastIndex = 0;
	while ((m = regex.exec(lines[hoverLine] ?? '')) !== null) {
		const dist = Math.abs(m.index - hoverCharacter);
		if (dist < bestDistance) {
			bestDistance = dist;
			bestMatch = { line: hoverLine, character: m.index };
		}
	}
	if (bestMatch) {
		return bestMatch;
	}

	// Fall back to surrounding lines
	for (let line = startLine; line <= endLine; line++) {
		if (line === hoverLine) {
			continue;
		}
		regex.lastIndex = 0;
		const match = regex.exec(lines[line] ?? '');
		if (match) {
			return { line, character: match.index };
		}
	}

	return null;
}
