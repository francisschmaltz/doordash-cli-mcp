import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VERSION = "0.2.5";
const RELEASES = {
  "darwin-arm64": "7ba0bcc3371126b3046c4085ddcf4807f21e9e2ed1e51e1580c9e1beab208b8b",
  "linux-amd64": "caef8f3450b11c6e8c0ffca16e335b7fa74a6d0bc673e34ddd2239528c96629d"
};

function parseOptions(args) {
  const options = {
    platform: `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`,
    destination: path.resolve("doordash-cli"),
    link: path.resolve("dd-cli")
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index].replace(/^--/, "");
    if (!Object.hasOwn(options, key) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`Unknown or incomplete installer option: ${args[index]}`);
    }
    options[key] = args[++index];
  }
  options.destination = path.resolve(options.destination);
  options.link = path.resolve(options.link);
  if (!RELEASES[options.platform]) {
    throw new Error("DoorDash CLI v0.2.5 supports darwin-arm64 and linux-amd64.");
  }
  const host = `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  if (options.platform !== host) {
    throw new Error(`Run this installer on ${options.platform}; the host is ${host}.`);
  }
  return options;
}

async function findExecutable(directory, executableName) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.name === executableName && (entry.isFile() || entry.isSymbolicLink())) {
      return candidate;
    }
    if (entry.isDirectory() && entry.name !== "_internal") {
      const nested = await findExecutable(candidate, executableName);
      if (nested) return nested;
    }
  }
  return null;
}

async function install(options) {
  const executableName = `dd-cli-v${VERSION}-${options.platform}`;
  const archiveName = `${executableName}.tar.gz`;
  const url = `https://github.com/doordash-oss/doordash-cli/releases/download/v${VERSION}/${archiveName}`;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "doordash-cli-release-"));
  let staged;
  let backup;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`CLI download failed: HTTP ${response.status}.`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== RELEASES[options.platform]) {
      throw new Error("CLI archive checksum mismatch; existing installation was preserved.");
    }
    const archivePath = path.join(temporary, archiveName);
    await writeFile(archivePath, archive);
    const entries = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" }).split("\n");
    if (entries.some((entry) => path.posix.isAbsolute(entry) || entry.split("/").includes(".."))) {
      throw new Error("CLI archive contains an unsafe path.");
    }
    await mkdir(path.dirname(options.destination), { recursive: true });
    staged = await mkdtemp(path.join(path.dirname(options.destination), ".doordash-cli-install-"));
    await chmod(staged, 0o755);
    execFileSync("tar", ["-xzf", archivePath, "-C", staged]);
    const executable = await findExecutable(staged, executableName);
    if (!executable) throw new Error(`CLI archive is missing ${executableName}.`);
    await chmod(executable, 0o755);
    await access(executable, constants.X_OK);
    const version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 30_000 });
    if (!version.includes(VERSION)) throw new Error("Downloaded CLI returned an unexpected version.");
    const relativeExecutable = path.relative(staged, executable);
    try {
      await lstat(options.destination);
      backup = `${staged}.previous`;
      await rename(options.destination, backup);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(staged, options.destination);
    staged = null;
    await mkdir(path.dirname(options.link), { recursive: true });
    const target = path.relative(path.dirname(options.link), path.join(options.destination, relativeExecutable));
    const nextLink = `${options.link}.next-${process.pid}`;
    await symlink(target, nextLink);
    await rename(nextLink, options.link);
    if (backup) await rm(backup, { recursive: true, force: true });
    backup = null;
    console.log(`Installed checksum-verified DoorDash CLI v${VERSION} (${options.platform}) at ${options.link}.`);
  } catch (error) {
    if (backup) {
      await rm(options.destination, { recursive: true, force: true });
      await rename(backup, options.destination);
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (staged) await rm(staged, { recursive: true, force: true });
  }
}

if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/install-cli.js [--platform darwin-arm64|linux-amd64] [--destination DIR] [--link PATH]");
} else {
  try {
    await install(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
