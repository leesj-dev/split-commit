import { existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { WorkingTreeChange } from "../types.js";

export interface ProjectContext {
  root: string;
  configPath: string | null;
  oldCompilerOptions: ts.CompilerOptions;
  newCompilerOptions: ts.CompilerOptions;
  oldHost: ts.ModuleResolutionHost;
  newHost: ts.ModuleResolutionHost;
}

function absolute(root: string, filePath: string): string {
  return path.resolve(root, filePath);
}

function makeOldHost(
  root: string,
  changes: WorkingTreeChange[],
): ts.ModuleResolutionHost & ts.ParseConfigHost {
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
    readDirectory(rootDirectory, extensions, excludes, includes, depth) {
      const current = ts.sys.readDirectory(
        rootDirectory,
        extensions,
        excludes,
        includes,
        depth,
      );
      const visible = new Set(
        current
          .map((fileName) => normalize(fileName))
          .filter((fileName) => !hiddenFromOldTree.has(fileName)),
      );
      for (const fileName of oldFiles.keys()) {
        if (fileName.startsWith(`${normalize(rootDirectory)}${path.sep}`)) {
          visible.add(fileName);
        }
      }
      return [...visible];
    },
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    ...(ts.sys.realpath ? { realpath: ts.sys.realpath } : {}),
    getDirectories: ts.sys.getDirectories,
  };
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

function parseCompilerOptions(
  configPath: string | null,
  host: ts.ParseConfigHost,
): ts.CompilerOptions {
  if (!configPath || !host.fileExists(configPath)) return DEFAULT_COMPILER_OPTIONS;
  const loaded = ts.readConfigFile(configPath, host.readFile);
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    host,
    path.dirname(configPath),
  );
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
  return parsed.options;
}

function findConfigPath(
  root: string,
  changes: WorkingTreeChange[],
  oldHost: ts.ModuleResolutionHost,
): string | null {
  const current = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (current) return current;
  const previous = ts.findConfigFile(root, oldHost.fileExists, "tsconfig.json");
  if (previous) return previous;
  const changedConfig = changes.find(
    (change) =>
      (change.oldPath ?? change.newPath)?.split(path.sep).join("/") ===
      "tsconfig.json",
  );
  return changedConfig ? path.join(root, "tsconfig.json") : null;
}

function loadCompilerOptions(
  root: string,
  changes: WorkingTreeChange[],
  oldHost: ts.ModuleResolutionHost & ts.ParseConfigHost,
): {
  configPath: string | null;
  oldCompilerOptions: ts.CompilerOptions;
  newCompilerOptions: ts.CompilerOptions;
} {
  const configPath = findConfigPath(root, changes, oldHost);
  return {
    configPath,
    oldCompilerOptions: parseCompilerOptions(configPath, oldHost),
    newCompilerOptions: parseCompilerOptions(configPath, ts.sys),
  };
}

export function loadProject(
  root: string,
  changes: WorkingTreeChange[],
): ProjectContext {
  const oldHost = makeOldHost(root, changes);
  const { configPath, oldCompilerOptions, newCompilerOptions } =
    loadCompilerOptions(root, changes, oldHost);

  return {
    root,
    configPath,
    oldCompilerOptions,
    newCompilerOptions,
    oldHost,
    newHost: ts.sys,
  };
}
