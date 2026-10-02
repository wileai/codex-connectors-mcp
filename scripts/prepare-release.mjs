import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Release metadata is data, never interpolated into a shell command.
const tag = process.env.RELEASE_TAG ?? "";
const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?)$/.exec(tag);
if (!match) throw new Error("Release tag must be vMAJOR.MINOR.PATCH, optionally with a SemVer prerelease suffix.");
const prerelease = process.env.RELEASE_PRERELEASE === "true";
if (prerelease !== Boolean(match[2])) throw new Error("GitHub prerelease status must match the tag's prerelease suffix.");
execFileSync("npm", ["version", match[1], "--no-git-tag-version", "--allow-same-version", "--ignore-scripts"], { stdio: "inherit" });
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `dist_tag=${prerelease ? "next" : "latest"}\n`);
console.log(`Prepared ${match[1]} for npm's ${prerelease ? "next" : "latest"} tag.`);
