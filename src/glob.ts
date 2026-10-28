export function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

function globToRegExp(glob: string): RegExp {
  let expression = "^";
  const normalized = glob.replaceAll("\\", "/");
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const next = normalized[index + 1];
    if (character === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegExp(character ?? "");
    }
  }
  return new RegExp(`${expression}$`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
