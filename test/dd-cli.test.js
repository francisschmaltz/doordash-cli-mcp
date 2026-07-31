import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DoorDashCliError,
  assertPurchaseAllowed,
  buildCliArguments,
  runDoorDashCli,
  validateArguments
} from "../src/dd-cli.js";

test("rejects login through MCP", () => {
  assert.throws(() => validateArguments(["login"]), /cannot run through MCP/);
});

test("blocks purchase commands by default", () => {
  assert.throws(
    () => assertPurchaseAllowed(["order", "submit"]),
    /Blocked `order submit`/
  );
});

test("allows purchase commands only when explicitly enabled", () => {
  assert.doesNotThrow(() => assertPurchaseAllowed(["order", "submit"], true));
});

test("does not confuse checkout-url with placing an order", () => {
  assert.doesNotThrow(() => assertPurchaseAllowed(["order", "checkout-url"]));
});

test("builds exact service arguments with the fixed intent", () => {
  assert.deepEqual(buildCliArguments(["search", "--query", "sushi"]), [
    "--json-output",
    "search",
    "--query",
    "sushi",
    "--intent",
    "cli-usage"
  ]);
});

test("passes arguments without shell interpretation and parses JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dd-cli-mcp-"));
  const mockCli = path.join(directory, "mock-dd-cli");
  await writeFile(
    mockCli,
    "#!/bin/sh\nprintf '%s\\n' '{\"argv\":['\nfirst=true\nfor arg in \"$@\"; do\n  if [ \"$first\" = true ]; then first=false; else printf ','; fi\n  printf '\"%s\"' \"$arg\"\ndone\nprintf ']}\\n'\n",
    "utf8"
  );
  await chmod(mockCli, 0o755);

  const result = await runDoorDashCli(["search", "--query", "sushi; touch /tmp/nope"], {
    cliPath: mockCli,
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.argv, [
    "--json-output",
    "search",
    "--query",
    "sushi; touch /tmp/nope",
    "--intent",
    "cli-usage"
  ]);
});

test("returns stderr and exit metadata on failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dd-cli-mcp-"));
  const mockCli = path.join(directory, "mock-dd-cli");
  await writeFile(mockCli, "#!/bin/sh\necho 'not logged in' >&2\nexit 7\n", "utf8");
  await chmod(mockCli, 0o755);

  await assert.rejects(
    runDoorDashCli(["search"], { cliPath: mockCli, timeoutMs: 5_000 }),
    (error) =>
      error instanceof DoorDashCliError &&
      error.message === "not logged in" &&
      error.details.exitCode === 7
  );
});

test("renders structured CLI errors instead of object stringification", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dd-cli-mcp-"));
  const mockCli = path.join(directory, "mock-dd-cli");
  await writeFile(
    mockCli,
    "#!/bin/sh\nprintf '%s\\n' '{\"isError\":true,\"structuredContent\":{\"error\":{\"code\":\"BAD_OPTION\",\"message\":\"Choose a size.\"}}}'\nexit 9\n",
    "utf8"
  );
  await chmod(mockCli, 0o755);

  await assert.rejects(
    runDoorDashCli(["cart", "add-items"], {
      cliPath: mockCli,
      timeoutMs: 5_000
    }),
    (error) =>
      error instanceof DoorDashCliError &&
      error.message === "BAD_OPTION: Choose a size." &&
      !error.message.includes("[object Object]") &&
      error.details.exitCode === 9
  );
});
