import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

function portablePath(path: string): string {
  return path.split(sep).join("/").normalize("NFC");
}

export function pathWorkspaceId(root: string, home: string): string {
  const absoluteRoot = resolve(root);
  const absoluteHome = resolve(home);
  const relativeRoot = relative(absoluteHome, absoluteRoot);
  const isHomeRelative =
    !isAbsolute(relativeRoot) &&
    relativeRoot !== ".." &&
    !relativeRoot.startsWith(`..${sep}`);
  const identity = isHomeRelative
    ? `home:${portablePath(relativeRoot || ".")}`
    : `absolute:${portablePath(absoluteRoot)}`;
  return `path:${createHash("sha256").update(identity).digest("hex")}`;
}
