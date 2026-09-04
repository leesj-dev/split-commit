import { existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { WorkingTreeChange } from "../types.js";

export interface ProjectContext {
  root: string;
  configPath: string | null;
  compilerOptions: ts.CompilerOptions;
  oldHost: ts.ModuleResolutionHost;
  newHost: ts.ModuleResolutionHost;
  configChanged: boolean;
}

function absolute(root: string, filePath: string): string {
  return path.resolve(root, filePath);
}

function makeOldHost(
  root: string,
  changes: WorkingTreeChange[],
): ts.ModuleResolutionHost {
  const oldFiles = new Map<string, string>();
  const hiddenFromOldTree = new Set<string>();

  for (const change of changes) {
    if (change.oldPath && change.oldContent !== undefined) {
      oldFiles.set(absolute(root, change.oldPath), change.oldContent);
    }
    if (change.status === "added" && change.newPath) {
      hiddenFromOldTree.add(absolute(root, change.newPath));
    }
    if (change.status === "renamed" && change.newPath) {
      hiddenFromOldTree.add(absolute(root, change.newPath));
    }
  }

  const normalize = (fileName: string): string => path.resolve(fileName);
  return {
    fileExists(fileName) {
      const resolved = normalize(fileName);
      if (oldFiles.has(resolved)) return true;
      if (hiddenFromOldTree.has(resolved)) return false;
      return ts.sys.fileExists(resolved);
    },
    readFile(fileName) {
      const resolved = normalize(fileName);
      if (oldFiles.has(resolved)) return oldFiles.get(resolved);
      if (hiddenFromOldTree.has(resolved)) return undefined;
      return ts.sys.readFile(resolved);
    },
    directoryExists(directoryName) {
      const resolved = normalize(directoryName);
      if ([...oldFiles.keys()].some((fileName) => fileName.startsWith(`${resolved}${path.sep}`))) {
        return true;
      }
      return ts.sys.directoryExists?.(resolved) ?? existsSync(resolved);
    },
    getCurrentDirectory: () => root,
    ...(ts.sys.realpath ? { realpath: ts.sys.realpath } : {}),
    getDirectories: ts.sys.getDirectories,
  };
}

function loadCompilerOptions(root: string): {
  configPath: string | null;
  compilerOptions: ts.CompilerOptions;
} {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return {
      configPath: null,
      compilerOptions: {
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
    };
  }

  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configPath));
  const errors = parsed.errors.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("\n"),
    );
  }
  return { configPath, compilerOptions: parsed.options };
}

export function loadProject(
  root: string,
  changes: WorkingTreeChange[],
): ProjectContext {
  const { configPath, compilerOptions } = loadCompilerOptions(root);
  const configRelativePath = configPath
    ? path.relative(root, configPath).split(path.sep).join("/")
    : null;
  const configChanged = changes.some((change) => {
    const changedPaths = [change.oldPath, change.newPath].filter(
      (filePath): filePath is string => Boolean(filePath),
    );
    return changedPaths.some(
      (filePath) =>
        filePath === configRelativePath ||
        /(?:^|\/)(?:ts|js)config(?:\.[^/]+)?\.json$/i.test(filePath),
    );
  });

  return {
    root,
    configPath,
    compilerOptions,
    oldHost: makeOldHost(root, changes),
    newHost: ts.sys,
    configChanged,
  };
}
