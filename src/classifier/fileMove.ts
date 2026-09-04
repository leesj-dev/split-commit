import type { Classification, ConfirmedMove } from "../types.js";

export function classifyFileMove(move: ConfirmedMove): Classification {
  return {
    side: "mechanical",
    kind: "file-move",
    path: `${move.oldPath} → ${move.newPath}`,
    reason: move.reason,
    details: move.details,
    confidence: "high",
  };
}
