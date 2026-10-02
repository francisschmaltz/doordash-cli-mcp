import { createHash } from "node:crypto";

import {
  DoorDashCliError,
  extractCliStructuredContent,
  runDoorDashCli
} from "./dd-cli.js";
import { contracts, projectWithContract } from "./response-contract.js";

export const RENEWAL_INSTRUCTIONS =
  "Ask the user to run dd-cli export-token on a computer with a browser and provide its access token. Call doordash_auth with access_token to continue here without a restart. Inspect any cart or order write already attempted before continuing; never resubmit a recorded order attempt.";

export function accessTokenExpiry(accessToken) {
  try {
    const claims = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")
    );
    const milliseconds = Number(claims.exp) * 1_000;
    return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 8.64e15
      ? milliseconds
      : null;
  } catch {
    return null;
  }
}

export function redactCredential(value, accessToken) {
  if (typeof value === "string") {
    return accessToken ? value.split(accessToken).join("[REDACTED]") : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCredential(entry, accessToken));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(access_?token|refresh_?token|authorization)$/i.test(key)
          ? "[REDACTED]"
          : redactCredential(entry, accessToken)
      ])
    );
  }
  return value;
}

function fingerprint(accessToken) {
  return createHash("sha256").update(accessToken).digest("hex");
}

function authenticationFailure(error) {
  const details = error?.details || {};
  const data = details.data?.structuredContent || details.data || {};
  const status = Number(details.status || details.statusCode || data.status_code || data.error?.status);
  const code = String(details.code || data.error?.code || data.error_reason || data.code || "").toUpperCase();
  if (status === 403 || ["FORBIDDEN", "PERMISSION_DENIED", "INSUFFICIENT_SCOPE"].includes(code)) {
    return false;
  }
  return status === 401 ||
    ["UNAUTHORIZED", "INVALID_TOKEN", "TOKEN_EXPIRED", "MISSING_CREDENTIALS", "NOT_AUTHENTICATED", "DOORDASH_AUTH_REQUIRED"].includes(code) ||
    /missing credentials|not logged in|not signed in|token (?:has )?expired|expired (?:access )?token|invalid (?:access )?token|sign in with dd-cli login|run dd-cli login|refresh the DD_CLI_ACCESS_TOKEN/i.test(error?.message || "");
}

function authRequired(commandStarted = false) {
  return new DoorDashCliError(`DoorDash sign-in is missing, expired, or invalid. ${RENEWAL_INSTRUCTIONS}`, {
    code: "DOORDASH_AUTH_REQUIRED",
    commandStarted,
    requiresCredentialRenewal: true
  });
}

export class DoorDashCredentialManager {
  #store;
  #runCli;
  #timeoutMs;
  #clock;
  #rejectedCredential = null;

  constructor({ securityStore, runCli = runDoorDashCli, timeoutMs = 120_000, clock = () => Date.now() }) {
    this.#store = securityStore;
    this.#runCli = runCli;
    this.#timeoutMs = timeoutMs;
    this.#clock = clock;
  }

  async initialize(accessToken = process.env.DD_CLI_ACCESS_TOKEN) {
    if (await this.#store.getCredential()) return;
    if (accessToken?.trim()) {
      const token = this.#validateInput(accessToken);
      await this.#store.bootstrapCredential({ accessToken: token, expiresAt: accessTokenExpiry(token) });
    }
  }

  #validateInput(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 65_536 || /[\r\n\0]/.test(value)) {
      throw new DoorDashCliError("Provide one nonempty access token from dd-cli export-token.", {
        code: "INVALID_CREDENTIAL_INPUT"
      });
    }
    return value.trim();
  }

  async #credential() {
    const credential = await this.#store.getCredential();
    if (!credential ||
      (credential.expiresAt && credential.expiresAt <= this.#clock()) ||
      this.#rejectedCredential === fingerprint(credential.accessToken)) {
      throw authRequired();
    }
    return credential;
  }

  async #validate(accessToken) {
    const expiresAt = accessTokenExpiry(accessToken);
    if (expiresAt && expiresAt <= this.#clock()) {
      throw authRequired();
    }
    const execution = await this.#runCli(["address", "list"], {
      accessToken,
      timeoutMs: this.#timeoutMs,
      allowPurchases: false
    });
    projectWithContract(contracts.addresses, extractCliStructuredContent(execution));
    return expiresAt;
  }

  async status() {
    const stored = await this.#store.getCredential();
    if (!stored) {
      return { configured: false, authenticated: false, message: RENEWAL_INSTRUCTIONS };
    }
    try {
      const credential = await this.#credential();
      await this.#validate(credential.accessToken);
      return {
        configured: true,
        authenticated: true,
        ...(credential.expiresAt ? { expires_at: new Date(credential.expiresAt).toISOString() } : {}),
        message: "DoorDash authentication is ready."
      };
    } catch (error) {
      const needsRenewal = authenticationFailure(error);
      return {
        configured: true,
        authenticated: false,
        ...(stored.expiresAt ? { expires_at: new Date(stored.expiresAt).toISOString() } : {}),
        message: needsRenewal
          ? RENEWAL_INSTRUCTIONS
          : "DoorDash authentication could not be verified. The saved credential was retained; check service availability before replacing it."
      };
    }
  }

  async replace(accessToken, { beforeCommit = async () => {} } = {}) {
    const token = this.#validateInput(accessToken);
    let expiresAt;
    try {
      expiresAt = await this.#validate(token);
    } catch {
      throw new DoorDashCliError(
        "The replacement token could not be validated. The saved credential was not changed. Export a fresh access token and try doordash_auth again, or check DoorDash service availability.",
        { code: "CREDENTIAL_VALIDATION_FAILED" }
      );
    }
    await beforeCommit();
    await this.#store.setCredential({ accessToken: token, expiresAt });
    this.#rejectedCredential = null;
    return {
      configured: true,
      authenticated: true,
      ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
      message: "DoorDash credential updated. Continue the workflow; inspect any write already attempted before retrying."
    };
  }

  async run(args, options = {}) {
    const credential = await this.#credential();
    try {
      const execution = await this.#runCli(args, { ...options, accessToken: credential.accessToken });
      // A successful process exit can still carry an upstream MCP error envelope.
      const data = extractCliStructuredContent(execution);
      if (data?.success === false && authenticationFailure(new DoorDashCliError(
        data.error_message || data.message || "DoorDash returned an authentication error.",
        { data }
      ))) {
        throw authRequired(true);
      }
      return redactCredential(execution, credential.accessToken);
    } catch (error) {
      if (authenticationFailure(error)) {
        this.#rejectedCredential = fingerprint(credential.accessToken);
        throw authRequired(true);
      }
      const safeError = new DoorDashCliError(
        redactCredential(error instanceof Error ? error.message : String(error), credential.accessToken),
        redactCredential(error?.details || {}, credential.accessToken)
      );
      throw safeError;
    }
  }
}
