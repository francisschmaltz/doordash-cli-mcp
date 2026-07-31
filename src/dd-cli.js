import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI_PATH = path.resolve(SOURCE_DIR, "..", "dd-cli");
const DEFAULT_TIMEOUT_MS = 120_000;
const CLI_INTENT = "cli-usage";
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 4_096;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export class DoorDashCliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DoorDashCliError";
    this.details = details;
  }
}

export function resolveCliPath(cliPath = process.env.DD_CLI_PATH) {
  return path.resolve(cliPath || DEFAULT_CLI_PATH);
}

export function validateArguments(args) {
  if (!Array.isArray(args)) {
    throw new DoorDashCliError("DoorDash CLI arguments must be an array.");
  }

  if (args.length > MAX_ARGUMENTS) {
    throw new DoorDashCliError(`DoorDash CLI accepts at most ${MAX_ARGUMENTS} arguments per tool call.`);
  }

  for (const arg of args) {
    if (typeof arg !== "string" || arg.length === 0) {
      throw new DoorDashCliError("Every DoorDash CLI argument must be a non-empty string.");
    }
    if (arg.length > MAX_ARGUMENT_LENGTH || arg.includes("\0")) {
      throw new DoorDashCliError("A DoorDash CLI argument is invalid or too long.");
    }
  }

  if (args[0] === "login") {
    throw new DoorDashCliError(
      "Login cannot run through MCP. Run `./dd-cli login` directly on the Mac first."
    );
  }
}

export function assertPurchaseAllowed(args, allowPurchases = false) {
  const isOrderSubmit = args[0] === "order" && args[1] === "submit";
  if (!isOrderSubmit || allowPurchases) {
    return;
  }

  throw new DoorDashCliError(
    "Blocked `order submit`. Use the typed checkout tool with a purchase-enabled bearer token."
  );
}

export function assertGenericCommandAllowed(args) {
  if (args[0] === "payment-method") {
    throw new DoorDashCliError(
      "Payment methods are blocked in doordash_run. Use doordash_list_payment_methods with a purchase-enabled bearer token."
    );
  }

  if (args[0] === "order" && args[1] === "submit") {
    throw new DoorDashCliError(
      "Order submission is blocked in doordash_run. Use doordash_order_submit with a purchase-enabled bearer token."
    );
  }

  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version")) {
    throw new DoorDashCliError("Help and version commands are not exposed through MCP.");
  }
}

export function buildCliArguments(args) {
  return [
    "--json-output",
    ...args,
    "--intent",
    CLI_INTENT
  ];
}

function parseOutput(stdout) {
  const text = stdout.trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFromEnvelope(envelope) {
  const structuredMessage =
    envelope?.structuredContent?.error_message ||
    envelope?.structuredContent?.message ||
    envelope?.structuredContent?.error;
  if (structuredMessage) {
    return String(structuredMessage);
  }

  const textContent = envelope?.content?.find((entry) => entry?.type === "text")?.text;
  if (textContent) {
    try {
      const parsed = JSON.parse(textContent);
      return String(parsed.error_message || parsed.message || parsed.error || textContent);
    } catch {
      return textContent;
    }
  }

  return "DoorDash CLI returned an error.";
}

export function extractCliStructuredContent(execution) {
  const envelope = execution?.data;
  if (
    envelope &&
    typeof envelope === "object" &&
    !Array.isArray(envelope) &&
    ("structuredContent" in envelope || "content" in envelope || "isError" in envelope)
  ) {
    if (envelope.isError) {
      throw new DoorDashCliError(errorMessageFromEnvelope(envelope), {
        exitCode: execution.exitCode,
        signal: execution.signal,
        data: envelope.structuredContent ?? null,
        stderr: execution.stderr
      });
    }

    if (envelope.structuredContent !== undefined) {
      return envelope.structuredContent;
    }
  }

  return envelope;
}

export function runDoorDashCli(args, options = {}) {
  validateArguments(args);
  assertPurchaseAllowed(args, options.allowPurchases ?? false);

  const cliPath = resolveCliPath(options.cliPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cliArgs = buildCliArguments(args);

  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, cliArgs, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const capture = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new DoorDashCliError("DoorDash CLI output exceeded 5 MB.")));
        return;
      }

      if (target === "stdout") {
        stdout += chunk.toString("utf8");
      } else {
        stderr += chunk.toString("utf8");
      }
    };

    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));

    child.on("error", (error) => {
      finish(() => {
        reject(new DoorDashCliError(`Could not start DoorDash CLI: ${error.message}`, { cliPath }));
      });
    });

    child.on("close", (code, signal) => {
      finish(() => {
        const result = {
          ok: code === 0,
          exitCode: code,
          signal,
          data: parseOutput(stdout),
          stderr: stderr.trim() || null
        };

        if (code === 0) {
          resolve(result);
          return;
        }

        const message = stderr.trim() || stdout.trim() || `DoorDash CLI exited with code ${code}.`;
        reject(new DoorDashCliError(message, result));
      });
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => {
        reject(new DoorDashCliError(`DoorDash CLI timed out after ${timeoutMs} ms.`, { cliPath }));
      });
    }, timeoutMs);
  });
}
