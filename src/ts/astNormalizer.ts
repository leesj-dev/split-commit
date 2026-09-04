import path from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export function isSourcePath(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function scriptKindFor(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseSource(filePath: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
}

function commentFingerprint(content: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    content,
  );
  const comments: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia ||
      token === ts.SyntaxKind.ShebangTrivia ||
      token === ts.SyntaxKind.ConflictMarkerTrivia
    ) {
      comments.push(scanner.getTokenText().replace(/\r\n/g, "\n"));
    }
  }
  return comments.join("\u0000");
}

export interface FingerprintOptions {
  moduleReplacements?: ReadonlyMap<number, string>;
  canonicalizeAllModuleSpecifiers?: boolean;
  includeComments?: boolean;
}

function moduleSpecifierPositions(sourceFile: ts.SourceFile): Set<number> {
  const positions = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      positions.add(node.moduleSpecifier.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return positions;
}

export function semanticFingerprint(
  filePath: string,
  content: string,
  options: FingerprintOptions = {},
): string {
  const sourceFile = parseSource(filePath, content);
  const modulePositions = options.canonicalizeAllModuleSpecifiers
    ? moduleSpecifierPositions(sourceFile)
    : new Set<number>();
  const tokens: string[] = [];

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    const start = node.getStart(sourceFile);
    const replacement = options.moduleReplacements?.get(start);
    if (replacement !== undefined) {
      tokens.push(`module:${replacement}`);
      return;
    }
    if (modulePositions.has(start) && ts.isStringLiteralLike(node)) {
      tokens.push("module:<specifier>");
      return;
    }

    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      if (
        ts.isIdentifier(node) ||
        ts.isStringLiteralLike(node) ||
        ts.isNumericLiteral(node) ||
        ts.isBigIntLiteral(node) ||
        ts.isRegularExpressionLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        tokens.push(`${node.kind}:${node.getText(sourceFile)}`);
      } else {
        tokens.push(String(node.kind));
      }
      return;
    }
    tokens.push(`(${node.kind}`);
    for (const child of children) visit(child);
    tokens.push(")");
  };
  visit(sourceFile);

  if (options.includeComments !== false) {
    tokens.push(`comments:${commentFingerprint(content)}`);
  }
  return tokens.join("|");
}

export interface StaticModuleReference {
  kind: "import" | "export";
  specifier: string;
  specifierStart: number;
  line: number;
  sideEffectOnly: boolean;
  structuralKey: string;
}

function subtreeFingerprint(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  moduleStart: number,
): string {
  const result: string[] = [];
  const visit = (child: ts.Node): void => {
    const start = child.getStart(sourceFile);
    if (start === moduleStart && ts.isStringLiteralLike(child)) {
      result.push("module:<specifier>");
      return;
    }
    const children = child.getChildren(sourceFile);
    if (children.length === 0) {
      result.push(
        ts.isIdentifier(child) || ts.isStringLiteralLike(child)
          ? `${child.kind}:${child.getText(sourceFile)}`
          : String(child.kind),
      );
      return;
    }
    result.push(`(${child.kind}`);
    for (const nested of children) visit(nested);
    result.push(")");
  };
  visit(node);
  return result.join("|");
}

export function extractStaticModuleReferences(
  filePath: string,
  content: string,
): StaticModuleReference[] {
  const sourceFile = parseSource(filePath, content);
  const references: StaticModuleReference[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const start = statement.moduleSpecifier.getStart(sourceFile);
      references.push({
        kind: "import",
        specifier: statement.moduleSpecifier.text,
        specifierStart: start,
        line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
        sideEffectOnly: !statement.importClause,
        structuralKey: subtreeFingerprint(sourceFile, statement, start),
      });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const start = statement.moduleSpecifier.getStart(sourceFile);
      references.push({
        kind: "export",
        specifier: statement.moduleSpecifier.text,
        specifierStart: start,
        line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
        sideEffectOnly: false,
        structuralKey: subtreeFingerprint(sourceFile, statement, start),
      });
    }
  }
  return references;
}

export function findPathSensitiveConstructs(
  filePath: string,
  content: string,
): string[] {
  const sourceFile = parseSource(filePath, content);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === "__dirname" || node.text === "__filename")) {
      found.add(node.text);
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      found.add("import.meta");
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) found.add("dynamic import()");
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        found.add("require()");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...found];
}
