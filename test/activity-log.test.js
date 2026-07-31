import assert from "node:assert/strict";
import test from "node:test";

import { ActivityLog } from "../src/activity-log.js";

test("keeps only the newest entries and lists newest first", () => {
  const log = new ActivityLog({ capacity: 2 });

  log.succeed(log.start(["one"]), { value: 1 });
  log.succeed(log.start(["two"]), { value: 2 });
  log.fail(log.start(["three"]), { error: "nope" });

  assert.equal(log.size, 2);
  assert.deepEqual(
    log.list().map((entry) => entry.command[0]),
    ["three", "two"]
  );
  assert.equal(log.list()[0].status, "error");
});

test("truncates oversized logged results", () => {
  const log = new ActivityLog({ maxPayloadBytes: 20 });
  log.succeed(log.start(["large"]), { value: "x".repeat(100) });

  const [entry] = log.list();
  assert.equal(entry.result.truncated, true);
  assert.ok(entry.result.originalBytes > 20);
});
