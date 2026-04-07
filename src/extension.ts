import * as vscode from 'vscode';
import { extractTypeNames, escapeRegExp } from './typeExtraction';

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
