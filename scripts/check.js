import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

for (const directory of ["src", "public", "scripts"]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      execFileSync(process.execPath, ["--check", path.join(directory, entry.name)], { stdio: "inherit" });
    }
  }
}
