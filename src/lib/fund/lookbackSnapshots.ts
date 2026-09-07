import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  addSnapshot,
  removeSnapshot,
  snapshotListOf,
  type LookbackSnapshot,
} from "./lookbackSnapshotLogic";

export type { LookbackSnapshot };
export { defaultSnapshotName } from "./lookbackSnapshotLogic";

export function lookbackSnapshotsPath(): string {
  if (process.env.LOOKBACK_SNAPSHOTS_PATH) return process.env.LOOKBACK_SNAPSHOTS_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", "lookback-snapshots.json");
}

export function readLookbackSnapshots(): LookbackSnapshot[] {
  const file = lookbackSnapshotsPath();
  if (!existsSync(file)) return [];
  try {
    return snapshotListOf(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

function writeAll(list: readonly LookbackSnapshot[]): LookbackSnapshot[] {
  const file = lookbackSnapshotsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  return [...list];
}

export function saveLookbackSnapshot(raw: unknown, now = new Date()): LookbackSnapshot[] {
  return writeAll(addSnapshot(readLookbackSnapshots(), raw, now));
}

export function deleteLookbackSnapshot(id: string): LookbackSnapshot[] {
  return writeAll(removeSnapshot(readLookbackSnapshots(), id));
}
