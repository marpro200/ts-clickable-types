import { describe, it, expect } from 'vitest';
import { extractTypeNames, scanForPascalCaseTypes, escapeRegExp, BUILTIN_TYPES, findTypeNameInLines } from './typeExtraction';

// Helper to wrap code in a fenced block (mimics TS hover output)
function fenced(code: string): string {
	return '```typescript\n' + code + '\n```';
}

describe('extractTypeNames', () => {
	it('extracts a simple user-defined type from a fenced block', () => {
		const hover = fenced('const x: MyType');
		expect(extractTypeNames(hover)).toEqual(['MyType']);
	});

	it('extracts multiple types', () => {
		const hover = fenced('const x: Foo | Bar');
		const result = extractTypeNames(hover);
		expect(result).toContain('Foo');
		expect(result).toContain('Bar');
		expect(result).toHaveLength(2);
	});

	it('filters out built-in types', () => {
		const hover = fenced('const x: Map<string, Promise<MyType>>');
		expect(extractTypeNames(hover)).toEqual(['MyType']);
	});

	it('returns empty array when only built-in types are present', () => {
		const hover = fenced('const x: Array<string>');
		expect(extractTypeNames(hover)).toEqual([]);
	});

	it('returns empty array for plain text without code blocks', () => {
		expect(extractTypeNames('Just some text with MyType')).toEqual([]);
	});

	it('returns empty array for empty input', () => {
		expect(extractTypeNames('')).toEqual([]);
	});

	it('excludes the declared variable name', () => {
		const hover = fenced('const MyConfig: SomeType');
		const result = extractTypeNames(hover);
		expect(result).toEqual(['SomeType']);
		expect(result).not.toContain('MyConfig');
	});

	it('excludes declared function name', () => {
		const hover = fenced('function FetchData(): ResultType');
		const result = extractTypeNames(hover);
		expect(result).toEqual(['ResultType']);
		expect(result).not.toContain('FetchData');
	});

	it('excludes declared class name', () => {
		const hover = fenced('class MyService extends BaseService');
		const result = extractTypeNames(hover);
		expect(result).toEqual(['BaseService']);
		expect(result).not.toContain('MyService');
	});

	it('excludes declared type alias name', () => {
		const hover = fenced('type UserRecord = Record<string, UserProfile>');
		const result = extractTypeNames(hover);
		expect(result).toEqual(['UserProfile']);
		expect(result).not.toContain('UserRecord');
	});

	it('excludes declared interface name', () => {
		const hover = fenced('interface ApiResponse extends BaseResponse');
		const result = extractTypeNames(hover);
		expect(result).toEqual(['BaseResponse']);
		expect(result).not.toContain('ApiResponse');
	});

	it('excludes declared enum name', () => {
		const hover = fenced('enum Status');
		expect(extractTypeNames(hover)).toEqual([]);
	});

	it('does not produce links for SCREAMING_CASE constants', () => {
		expect(extractTypeNames(fenced('const MAX_RETRY = 3'))).toEqual([]);
		expect(extractTypeNames(fenced('const API_KEY: string'))).toEqual([]);
		expect(extractTypeNames(fenced('const SCREAMING_CASE = true'))).toEqual([]);
	});

	// --- Generic types ---

	it('extracts type from a simple generic', () => {
		const hover = fenced('const x: ApiResponse<UserData>');
		const result = extractTypeNames(hover);
		expect(result).toContain('ApiResponse');
		expect(result).toContain('UserData');
	});

	it('extracts types from nested generics', () => {
		const hover = fenced('const x: Wrapper<Inner<DeepType>>');
		const result = extractTypeNames(hover);
		expect(result).toContain('Wrapper');
		expect(result).toContain('Inner');
		expect(result).toContain('DeepType');
	});

	it('extracts user types from generics mixed with built-ins', () => {
		const hover = fenced('const x: Promise<Array<MyItem>>');
		expect(extractTypeNames(hover)).toEqual(['MyItem']);
	});

	it('extracts types from a generic with multiple type parameters', () => {
		const hover = fenced('const x: Map<KeyType, ValueType>');
		const result = extractTypeNames(hover);
		expect(result).toContain('KeyType');
		expect(result).toContain('ValueType');
		// Map itself is built-in
		expect(result).not.toContain('Map');
	});

	it('extracts types from generic array shorthand', () => {
		const hover = fenced('const x: MyItem[]');
		expect(extractTypeNames(hover)).toEqual(['MyItem']);
	});

	it('handles Record with user-defined value type', () => {
		const hover = fenced('const cache: Record<string, CacheEntry>');
		const result = extractTypeNames(hover);
		expect(result).toEqual(['CacheEntry']);
	});

	it('extracts from generic function return type', () => {
		const hover = fenced('function load(): Promise<Config>');
		const result = extractTypeNames(hover);
		expect(result).toEqual(['Config']);
	});

	it('handles intersection types in generics', () => {
		const hover = fenced('const x: Wrapper<Foo & Bar>');
		const result = extractTypeNames(hover);
		expect(result).toContain('Wrapper');
		expect(result).toContain('Foo');
		expect(result).toContain('Bar');
	});

	it('handles union types in generics', () => {
		const hover = fenced('const x: Result<Success | Failure>');
		const result = extractTypeNames(hover);
		expect(result).toContain('Result');
		expect(result).toContain('Success');
		expect(result).toContain('Failure');
	});

	// --- Inline code spans ---

	it('extracts types from inline code spans', () => {
		const hover = 'The type is `MyWidget`';
		expect(extractTypeNames(hover)).toEqual(['MyWidget']);
	});

	it('extracts generics from inline code', () => {
		const hover = 'Returns `Container<Item>`';
		const result = extractTypeNames(hover);
		expect(result).toContain('Container');
		expect(result).toContain('Item');
	});

	// --- Additional exclusions ---

	it('respects additional exclusions passed by the caller', () => {
		const hover = fenced('const x: Foo | Bar | Baz');
		const result = extractTypeNames(hover, new Set(['Foo', 'Bar']));
		expect(result).toEqual(['Baz']);
	});

	it('additional exclusions do not affect the built-in list', () => {
		const hover = fenced('const x: MyType | Array<string>');
		const result = extractTypeNames(hover, new Set(['MyType']));
		expect(result).toEqual([]);
	});

	// --- Deduplication ---

	it('deduplicates repeated type names', () => {
		const hover = fenced('const x: Pair<MyType, MyType>');
		expect(extractTypeNames(hover)).toEqual(['Pair', 'MyType']);
	});

	// --- Edge cases ---

	it('does not extract lowercase identifiers', () => {
		const hover = fenced('const x: mytype');
		expect(extractTypeNames(hover)).toEqual([]);
	});

	it('handles complex real-world hover text', () => {
		const hover = [
			'```typescript',
			'(property) data: ApiResponse<UserProfile[]>',
			'```',
			'',
			'Fetches the user profile from the server.',
		].join('\n');
		const result = extractTypeNames(hover);
		expect(result).toContain('ApiResponse');
		expect(result).toContain('UserProfile');
		expect(result).not.toContain('Fetches');
	});
});

describe('scanForPascalCaseTypes', () => {
	it('adds PascalCase identifiers to the set', () => {
		const found = new Set<string>();
		scanForPascalCaseTypes('Foo and Bar', found, new Set());
		expect(found).toEqual(new Set(['Foo', 'Bar']));
	});

	it('ignores ALL_CAPS identifiers', () => {
		const found = new Set<string>();
		scanForPascalCaseTypes('MAX_RETRY API_KEY SCREAMING', found, new Set());
		expect(found.size).toBe(0);
	});

	it('skips built-in types', () => {
		const found = new Set<string>();
		scanForPascalCaseTypes('Array<MyType>', found, new Set());
		expect(found).toEqual(new Set(['MyType']));
	});

	it('skips excluded names', () => {
		const found = new Set<string>();
		scanForPascalCaseTypes('Foo Bar', found, new Set(['Foo']));
		expect(found).toEqual(new Set(['Bar']));
	});

	it('handles empty string', () => {
		const found = new Set<string>();
		scanForPascalCaseTypes('', found, new Set());
		expect(found.size).toBe(0);
	});
});

describe('findTypeNameInLines', () => {
	it('finds a type on the hovered line', () => {
		const lines = ['const x: MyType = value'];
		expect(findTypeNameInLines(lines, 0, 9, 'MyType')).toEqual({ line: 0, character: 9 });
	});

	it('returns null when type is not present — generic parameter not in source', () => {
		// Reproduces the ApiResponse<User> bug: hovering "response" on the call
		// site where User only appears in the hover text, not the source line.
		const lines = [
			'const response = await service.createUser({',
			"  email: 'alice@example.com',",
			'  role: UserRole.Admin,',
			'})',
		];
		// "User" does not appear as a standalone word near line 0
		expect(findTypeNameInLines(lines, 0, 6, 'User')).toBeNull();
	});

	it('respects word boundaries — does not match User inside createUser or UserRole', () => {
		const lines = ['const x = service.createUser({ role: UserRole.Admin })'];
		expect(findTypeNameInLines(lines, 0, 0, 'User')).toBeNull();
	});

	it('prefers the match closest to the hover character', () => {
		const lines = ['MyType foo MyType bar MyType'];
		//               0      6   11     17  22
		// hovering at character 13 — middle MyType (11) is closest
		expect(findTypeNameInLines(lines, 0, 13, 'MyType')).toEqual({ line: 0, character: 11 });
	});

	it('falls back to a surrounding line when not found on hovered line', () => {
		const lines = [
			'function load() {',
			'  return data',
			'}',
		];
		expect(findTypeNameInLines(lines, 1, 2, 'Config')).toBeNull();

		const linesWithType = [
			'const x: Config = {}',
			'return x',
		];
		expect(findTypeNameInLines(linesWithType, 1, 7, 'Config')).toEqual({ line: 0, character: 9 });
	});

	it('does not search beyond searchRange', () => {
		const lines = [
			'MyType is here',   // line 0
			'',                 // line 1
			'',                 // line 2
			'',                 // line 3
			'',                 // line 4
			'',                 // line 5
			'hover here',       // line 6
		];
		// line 0 is exactly 6 lines above hover line 6 — outside default searchRange of 5
		expect(findTypeNameInLines(lines, 6, 0, 'MyType')).toBeNull();
	});

	it('handles an empty lines array gracefully', () => {
		expect(findTypeNameInLines([], 0, 0, 'MyType')).toBeNull();
	});
});

describe('escapeRegExp', () => {
	it('escapes special regex characters', () => {
		expect(escapeRegExp('foo.bar')).toBe('foo\\.bar');
		expect(escapeRegExp('a+b')).toBe('a\\+b');
		expect(escapeRegExp('(test)')).toBe('\\(test\\)');
		expect(escapeRegExp('a[0]')).toBe('a\\[0\\]');
	});

	it('leaves normal strings unchanged', () => {
		expect(escapeRegExp('MyType')).toBe('MyType');
	});
});

describe('BUILTIN_TYPES', () => {
	it('contains core types', () => {
		expect(BUILTIN_TYPES.has('Array')).toBe(true);
		expect(BUILTIN_TYPES.has('Promise')).toBe(true);
		expect(BUILTIN_TYPES.has('Record')).toBe(true);
		expect(BUILTIN_TYPES.has('Map')).toBe(true);
	});

	it('does not contain user types', () => {
		expect(BUILTIN_TYPES.has('MyType')).toBe(false);
		expect(BUILTIN_TYPES.has('UserProfile')).toBe(false);
	});
});
