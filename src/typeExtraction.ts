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
// Type name extraction from hover markdown text
// ---------------------------------------------------------------------------
export function extractTypeNames(hoverText: string): string[] {
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

export function scanForPascalCaseTypes(
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

export function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
