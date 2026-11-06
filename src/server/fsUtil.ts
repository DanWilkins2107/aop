// Small file system checks shared by server modules.

import { statSync } from "node:fs";

/** Whether `path` exists and is a folder. Never throws. */
export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
