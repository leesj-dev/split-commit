import { execFileSync } from "node:child_process";

export function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}
