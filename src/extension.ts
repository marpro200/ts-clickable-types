import * as vscode from 'vscode';
import { extractTypeNames, findTypeNameInLines } from './typeExtraction';

const LANGUAGES = [
	{ language: 'typescript' },
	{ language: 'typescriptreact' },
	{ language: 'javascript' },
	{ language: 'javascriptreact' },
];

const COMMAND_ID = 'tsClickableTypes.goToTypeDefinition';

// Blocks recursion when our hover provider triggers `executeHoverProvider`,
// which would otherwise call us again for the same position.
let providingDepth = 0;

let outputChannel: vscode.OutputChannel | undefined;

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('TS Clickable Types');
	context.subscriptions.push(
		outputChannel,
		vscode.commands.registerCommand(COMMAND_ID, goToTypeDefinition),
		vscode.languages.registerHoverProvider(LANGUAGES, { provideHover }),
	);
}

export function deactivate() {
	outputChannel = undefined;
	providingDepth = 0;
}

// ---------------------------------------------------------------------------
// Hover Provider
// ---------------------------------------------------------------------------
async function provideHover(
	document: vscode.TextDocument,
	position: vscode.Position,
	token: vscode.CancellationToken,
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

		if (token.isCancellationRequested) {
			return undefined;
		}

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

		const config = vscode.workspace.getConfiguration('tsClickableTypes');
		const userExclusions = new Set(config.get<string[]>('excludeTypes', []));
		const typeNames = extractTypeNames(combinedText, userExclusions);
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

	const ALLOWED_SCHEMES = new Set(['file', 'vscode-vfs', 'untitled']);
	if (!ALLOWED_SCHEMES.has(uri.scheme)) {
		return;
	}

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

		// If the type name isn't in the source near the hover position (e.g. it's
		// a generic parameter only visible in the hover text), fall through to the
		// workspace symbol search rather than resolving the wrong type at hoverPosition.
		if (!typePos) {
			return false;
		}

		const locations = await vscode.commands.executeCommand<
			(vscode.Location | vscode.LocationLink)[]
		>('vscode.executeTypeDefinitionProvider', uri, typePos);

		if (locations && locations.length > 0) {
			const loc = locations[0];
			const targetUri = 'targetUri' in loc ? loc.targetUri : loc.uri;
			const targetRange =
				'targetUri' in loc
					? loc.targetSelectionRange ?? loc.targetRange
					: loc.range;
			await vscode.window.showTextDocument(targetUri, {
				selection: targetRange,
				preview: false,
			});
			return true;
		}
	} catch (err) {
		outputChannel?.appendLine(`[tryTypeDefinitionProvider] ${err}`);
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
	} catch (err) {
		outputChannel?.appendLine(`[tryWorkspaceSymbolSearch] ${err}`);
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
	const lines = Array.from(
		{ length: document.lineCount },
		(_, i) => document.lineAt(i).text,
	);
	const result = findTypeNameInLines(lines, hoverPosition.line, hoverPosition.character, typeName);
	return result ? new vscode.Position(result.line, result.character) : null;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function toMarkdownString(
	content: vscode.MarkdownString | vscode.MarkedString,
): vscode.MarkdownString | null {
	if (content instanceof vscode.MarkdownString) {
		return content;
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
