// Postbuild: stamp dist/version.json so any host answers "which build is this?"
// (release runbook R2). Verify a release with:
//   curl -s https://map.soliogamereserve.org/version.json
// The stamp lives OUTSIDE index.html so the app bundle stays byte-identical
// across rebuilds of the same commit (deterministic-build property).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

const info = {
  sha: git("rev-parse", "--short", "HEAD"),
  branch: git("branch", "--show-current") || "detached",
  commitDate: git("log", "-1", "--format=%cI"),
  builtAt: new Date().toISOString(),
};
writeFileSync("dist/version.json", JSON.stringify(info) + "\n");
console.log(`version.json: ${info.sha} (${info.branch}, committed ${info.commitDate})`);
