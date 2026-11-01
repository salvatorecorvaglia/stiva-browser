import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const files = execFileSync("git", ["ls-files", "-z", "*.md"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
let failed = false;
for (const file of files) {
  const markdown = readFileSync(file, "utf8");
  for (const match of markdown.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split("#")[0];
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//")) continue;
    const destination = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!existsSync(destination)) {
      console.error(`${file}: missing link target ${target}`);
      failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
else console.log(`Checked relative links in ${files.length} Markdown files.`);
