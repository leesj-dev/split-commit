import { stageBuiltPatch } from "../git/temporaryIndex.js";
import type { SplitPlan } from "./types.js";

export function stageSplitPart(plan: SplitPlan, part: "a" | "b"): void {
  if (part === "b" && plan.a.patch.length > 0) {
    throw new Error(
      "Commit A candidates remain; run stage-a, commit A, then rerun stage-b",
    );
  }
  stageBuiltPatch(plan.root, plan.baseCommit, plan[part]);
}
