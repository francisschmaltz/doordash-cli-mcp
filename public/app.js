const POLL_INTERVAL_MS = 2_000;
const DEFAULT_ACTIVITY_CAPACITY = 100;

const elements = {
  activityCount: document.querySelector("#activity-count"),
  activityList: document.querySelector("#activity-list"),
  autoRefresh: document.querySelector("#auto-refresh"),
  copyToken: document.querySelector("#copy-token"),
  dismissToken: document.querySelector("#dismiss-token"),
  emptyState: document.querySelector("#empty-state"),
  lastRefresh: document.querySelector("#last-refresh"),
  mcpEndpoint: document.querySelector("#mcp-endpoint"),
  purchaseStatus: document.querySelector("#purchase-status"),
  refresh: document.querySelector("#refresh"),
  search: document.querySelector("#search"),
  securityError: document.querySelector("#security-error"),
  serverStatus: document.querySelector("#server-status"),
  statusAnnouncement: document.querySelector("#status-announcement"),
  statusFilter: document.querySelector("#status-filter"),
  tokenCount: document.querySelector("#token-count"),
  tokenEmpty: document.querySelector("#token-empty"),
  tokenForm: document.querySelector("#token-form"),
  tokenList: document.querySelector("#token-list"),
  tokenName: document.querySelector("#token-name"),
  tokenSecret: document.querySelector("#token-secret"),
  tokenSecretValue: document.querySelector("#token-secret-value"),
  uptime: document.querySelector("#uptime")
};

const activityRecords = new Map();
const tokenRecords = new Map();
const pendingTokenActions = new Map();

let activityCapacity = DEFAULT_ACTIVITY_CAPACITY;
let activityLoadState = "loading";
let connectionState = "checking";
let entries = [];
let lastCompleteRefreshAt = null;
let pollTimer = null;
let refreshAgain = false;
let refreshPromise = null;
let tokenCopyResetTimer = null;
let tokenLoadState = "loading";
let tokens = [];

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) {
    return `${milliseconds} ms`;
  }
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function formatUptime(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatDate(value) {
  if (!value) {
    return "Never used";
  }
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatRefreshTime(value) {
  return value.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatCommand(command) {
  return ["dd-cli", ...command]
    .map((part) => (/[\s;"']/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function setText(element, value) {
  const text = String(value);
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

function announceStatus(message) {
  setText(elements.statusAnnouncement, message);
}

function setStatus(element, label, variant) {
  element.className = `status status-${variant}`;
  const text = element.querySelector(".status-text");
  setText(text, label);
}

function setConnectionState(nextState) {
  if (connectionState === nextState) {
    return;
  }

  const previousState = connectionState;
  connectionState = nextState;
  document.body.dataset.connectionState = nextState;

  if (nextState === "online") {
    setStatus(elements.serverStatus, "Online", "success");
    announceStatus(previousState === "checking" ? "Server online." : "Server connection restored.");
    return;
  }

  if (nextState === "degraded") {
    setStatus(elements.serverStatus, "Degraded", "warning");
    announceStatus("Some server data could not be refreshed.");
    return;
  }

  if (nextState === "offline") {
    setStatus(elements.serverStatus, "Offline", "danger");
    announceStatus("Server offline. Previously loaded data may be stale.");
    return;
  }

  setStatus(elements.serverStatus, "Checking", "neutral");
}

function setSecurityError(error) {
  elements.securityError.hidden = !error;
  setText(elements.securityError, error ? String(error.message || error) : "");
}

function activityKey(entry) {
  return `${entry.id}:${entry.finishedAt}`;
}

function filteredEntries() {
  const query = elements.search.value.trim().toLowerCase();
  const status = elements.statusFilter.value;

  return entries.filter((entry) => {
    if (status !== "all" && entry.status !== status) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = `${entry.command.join(" ")} ${JSON.stringify(entry.result)}`.toLowerCase();
    return haystack.includes(query);
  });
}

function placeRecords(container, records) {
  let cursor = container.firstElementChild;

  for (const record of records) {
    if (record.root === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      container.insertBefore(record.root, cursor);
    }
  }

  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
}

async function copyActivityOutput(record) {
  record.copyAttempt += 1;
  const attempt = record.copyAttempt;
  window.clearTimeout(record.copyResetTimer);
  record.feedback.hidden = true;
  record.copy.disabled = true;

  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard access is unavailable.");
    }
    await navigator.clipboard.writeText(record.output.textContent);
    if (attempt !== record.copyAttempt) {
      return;
    }
    setText(record.copy, "Copied");
    record.copyResetTimer = window.setTimeout(() => {
      if (attempt === record.copyAttempt && record.copy.isConnected) {
        setText(record.copy, "Copy");
      }
    }, 1_200);
  } catch {
    if (attempt !== record.copyAttempt) {
      return;
    }
    setText(record.copy, "Copy failed");
    setText(
      record.feedback,
      "Couldn’t copy this output. Select it and copy it manually."
    );
    record.feedback.hidden = false;
  } finally {
    if (attempt === record.copyAttempt && record.copy.isConnected) {
      record.copy.disabled = false;
    }
  }
}

function createActivityRecord(entry) {
  const root = document.createElement("article");
  root.className = "activity-entry";

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.className = "activity-summary";

  const command = document.createElement("span");
  command.className = "command";

  const meta = document.createElement("span");
  meta.className = "activity-meta";

  const status = document.createElement("span");
  status.className = "status-label";

  const duration = document.createElement("span");
  const time = document.createElement("time");

  meta.append(status, duration, time);
  summary.append(command, meta);

  const outputWrap = document.createElement("div");
  outputWrap.className = "output-wrap";

  const output = document.createElement("pre");
  output.className = "output";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";
  copy.textContent = "Copy";

  const feedback = document.createElement("p");
  feedback.className = "copy-feedback";
  feedback.setAttribute("role", "alert");
  feedback.hidden = true;

  outputWrap.append(output, copy, feedback);
  details.append(summary, outputWrap);
  root.append(details);

  const record = {
    command,
    copy,
    copyAttempt: 0,
    copyResetTimer: null,
    details,
    duration,
    feedback,
    output,
    root,
    status,
    time
  };

  copy.addEventListener("click", () => {
    void copyActivityOutput(record);
  });

  updateActivityRecord(record, entry);
  return record;
}

function updateActivityRecord(record, entry) {
  const key = activityKey(entry);
  const commandText = formatCommand(entry.command);
  const outputText = JSON.stringify(entry.result, null, 2) ?? "null";

  record.root.dataset.entryId = key;
  record.root.dataset.status = entry.status;
  setText(record.command, commandText);
  record.command.title = commandText;
  setText(record.status, entry.status);
  setText(record.duration, formatDuration(entry.durationMs));
  record.time.dateTime = entry.finishedAt;
  setText(
    record.time,
    new Date(entry.finishedAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit"
    })
  );
  setText(record.output, outputText);
  record.copy.setAttribute("aria-label", `Copy output for ${commandText}`);
}

function renderEntries() {
  const completeKeys = new Set(entries.map(activityKey));
  let removedFocusedEntry = false;

  for (const [key, record] of activityRecords) {
    if (!completeKeys.has(key)) {
      removedFocusedEntry ||= record.root.contains(document.activeElement);
      window.clearTimeout(record.copyResetTimer);
      record.root.remove();
      activityRecords.delete(key);
    }
  }

  const visibleEntries = filteredEntries();
  const visibleRecords = visibleEntries.map((entry) => {
    const key = activityKey(entry);
    let record = activityRecords.get(key);
    if (!record) {
      record = createActivityRecord(entry);
      activityRecords.set(key, record);
    } else {
      updateActivityRecord(record, entry);
    }
    return record;
  });

  placeRecords(elements.activityList, visibleRecords);

  if (removedFocusedEntry) {
    elements.search.focus({ preventScroll: true });
  }

  elements.emptyState.hidden = visibleEntries.length > 0;
  if (visibleEntries.length > 0) {
    return;
  }

  const emptyTitle = elements.emptyState.querySelector("strong");
  const emptyDescription = elements.emptyState.querySelector("span");
  const hasFilters =
    elements.search.value.trim() || elements.statusFilter.value !== "all";

  if (activityLoadState === "loading") {
    setText(emptyTitle, "Loading activity");
    setText(emptyDescription, "Recent MCP calls will appear here.");
    return;
  }

  if (activityLoadState === "unavailable") {
    setText(emptyTitle, "Activity unavailable");
    setText(emptyDescription, "Reconnect to the server and refresh this page.");
    return;
  }

  setText(emptyTitle, hasFilters ? "No matching commands" : "No command history");
  setText(
    emptyDescription,
    hasFilters ? "Try a less specific filter." : "Calls made through MCP will appear here."
  );
}

function createTokenRecord(token) {
  const root = document.createElement("article");
  root.className = "token-row";

  const identity = document.createElement("div");
  identity.className = "token-identity";

  const name = document.createElement("strong");
  const prefix = document.createElement("code");
  const metadata = document.createElement("span");
  identity.append(name, prefix, metadata);

  const controls = document.createElement("div");
  controls.className = "token-controls";

  const permission = document.createElement("label");
  permission.className = "permission-toggle";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";

  const permissionText = document.createElement("span");
  permissionText.textContent = "Allow purchasing and card details";
  permission.append(checkbox, permissionText);

  const revoke = document.createElement("button");
  revoke.type = "button";
  revoke.className = "button button-danger";
  revoke.textContent = "Revoke";

  controls.append(permission, revoke);
  root.append(identity, controls);

  const record = {
    checkbox,
    current: token,
    metadata,
    name,
    prefix,
    revoke,
    root
  };

  checkbox.addEventListener("change", () => {
    void updateTokenPermission(record, checkbox.checked);
  });

  revoke.addEventListener("click", () => {
    void revokeToken(record);
  });

  updateTokenRecord(record, token);
  return record;
}

function updateTokenRecord(record, token) {
  const key = String(token.id);
  const pending = pendingTokenActions.get(key);

  record.current = token;
  record.root.dataset.tokenId = key;
  setText(record.name, token.name);
  setText(record.prefix, token.prefix);
  setText(
    record.metadata,
    `Created ${formatDate(token.createdAt)} · ${formatDate(token.lastUsedAt)}`
  );
  record.checkbox.setAttribute(
    "aria-label",
    `Allow purchasing and card details for ${token.name}`
  );
  record.checkbox.checked =
    pending?.type === "permission" ? pending.desired : token.allowPurchases;
  record.checkbox.disabled = Boolean(pending);
  record.revoke.disabled = Boolean(pending);
  setText(record.revoke, pending?.type === "revoke" ? "Revoking…" : "Revoke");

  if (pending) {
    record.root.setAttribute("aria-busy", "true");
  } else {
    record.root.removeAttribute("aria-busy");
  }
}

function renderTokens() {
  const completeKeys = new Set(tokens.map((token) => String(token.id)));

  for (const [key, record] of tokenRecords) {
    if (!completeKeys.has(key)) {
      record.root.remove();
      tokenRecords.delete(key);
    }
  }

  const records = tokens.map((token) => {
    const key = String(token.id);
    let record = tokenRecords.get(key);
    if (!record) {
      record = createTokenRecord(token);
      tokenRecords.set(key, record);
    } else {
      updateTokenRecord(record, token);
    }
    return record;
  });

  placeRecords(elements.tokenList, records);
  setText(elements.tokenCount, tokens.length);
  elements.tokenEmpty.hidden = tokens.length > 0;

  if (tokens.length > 0) {
    return;
  }

  if (tokenLoadState === "loading") {
    setText(elements.tokenEmpty, "Loading token data…");
    return;
  }

  if (tokenLoadState === "unavailable") {
    setText(elements.tokenEmpty, "Token data is unavailable while the server is offline.");
    return;
  }

  setText(elements.tokenEmpty, "No active tokens. Create one to connect an MCP client.");
}

async function fetchJson(url, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...options.headers
  };
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error || `${response.status} ${response.statusText}`);
    error.httpStatus = response.status;
    throw error;
  }

  return body;
}

function applyStatus(status) {
  activityCapacity = status.activityCapacity || DEFAULT_ACTIVITY_CAPACITY;
  setText(elements.uptime, formatUptime(status.uptimeSeconds));
  setText(
    elements.activityCount,
    `${status.activityCount} / ${activityCapacity}`
  );

  if (status.purchaseTokenCount > 0) {
    setStatus(
      elements.purchaseStatus,
      `${status.purchaseTokenCount} ${
        status.purchaseTokenCount === 1 ? "token can purchase" : "tokens can purchase"
      }`,
      "danger"
    );
  } else {
    setStatus(elements.purchaseStatus, "No purchase access", "neutral");
  }
}

function applyActivity(activity) {
  entries = activity.entries;
  activityLoadState = "loaded";
  setText(elements.activityCount, `${activity.count} / ${activityCapacity}`);
  renderEntries();
}

function applyTokens(tokenResponse) {
  tokens = tokenResponse.tokens;
  tokenLoadState = "loaded";
  renderTokens();
}

async function performRefresh() {
  const results = await Promise.allSettled([
    fetchJson("/api/status"),
    fetchJson("/activity?limit=100"),
    fetchJson("/api/tokens")
  ]);
  const [statusResult, activityResult, tokenResult] = results;
  const fulfilledCount = results.filter((result) => result.status === "fulfilled").length;

  if (statusResult.status === "fulfilled") {
    applyStatus(statusResult.value);
  }

  if (activityResult.status === "fulfilled") {
    applyActivity(activityResult.value);
  } else if (activityLoadState === "loading") {
    activityLoadState = "unavailable";
    renderEntries();
  }

  if (tokenResult.status === "fulfilled") {
    applyTokens(tokenResult.value);
  } else if (tokenLoadState === "loading") {
    tokenLoadState = "unavailable";
    renderTokens();
  }

  if (fulfilledCount === results.length) {
    lastCompleteRefreshAt = new Date();
    setText(elements.lastRefresh, formatRefreshTime(lastCompleteRefreshAt));
    setConnectionState("online");
    return;
  }

  const hasHttpFailure = results.some(
    (result) => result.status === "rejected" && result.reason?.httpStatus
  );
  const freshness = lastCompleteRefreshAt
    ? `Stale · ${formatRefreshTime(lastCompleteRefreshAt)}`
    : fulfilledCount > 0 || hasHttpFailure
      ? "Incomplete"
      : "Unavailable";
  setText(elements.lastRefresh, freshness);

  const nextState = fulfilledCount > 0 || hasHttpFailure ? "degraded" : "offline";
  if (nextState !== connectionState) {
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    console.error("Dashboard refresh failed:", ...failures);
  }
  setConnectionState(nextState);
}

function requestRefresh({ afterCurrent = false } = {}) {
  if (refreshPromise) {
    if (afterCurrent) {
      refreshAgain = true;
    }
    return refreshPromise;
  }

  refreshPromise = (async () => {
    do {
      refreshAgain = false;
      await performRefresh();
    } while (refreshAgain);
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

function clearPollTimer() {
  window.clearTimeout(pollTimer);
  pollTimer = null;
}

function scheduleNextPoll() {
  clearPollTimer();
  if (!elements.autoRefresh.checked) {
    return;
  }

  pollTimer = window.setTimeout(async () => {
    pollTimer = null;
    await requestRefresh();
    scheduleNextPoll();
  }, POLL_INTERVAL_MS);
}

async function runManualRefresh() {
  clearPollTimer();
  elements.refresh.disabled = true;
  elements.refresh.setAttribute("aria-busy", "true");

  try {
    await requestRefresh({ afterCurrent: true });
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.removeAttribute("aria-busy");
    scheduleNextPoll();
  }
}

async function updateTokenPermission(record, allowPurchases) {
  const token = record.current;
  const key = String(token.id);
  pendingTokenActions.set(key, {
    desired: allowPurchases,
    type: "permission"
  });
  setSecurityError(null);
  renderTokens();

  try {
    const response = await fetchJson(`/api/tokens/${encodeURIComponent(token.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ allowPurchases })
    });
    applyTokens(response);
    await requestRefresh({ afterCurrent: true });
  } catch (error) {
    setSecurityError(
      new Error(
        `Purchasing and card details weren’t updated for “${token.name}”. ${error.message}`
      )
    );
    await requestRefresh({ afterCurrent: true });
  } finally {
    pendingTokenActions.delete(key);
    renderTokens();
  }
}

async function revokeToken(record) {
  const token = record.current;
  const key = String(token.id);
  pendingTokenActions.set(key, { type: "revoke" });
  setSecurityError(null);
  renderTokens();

  try {
    await fetchJson(`/api/tokens/${encodeURIComponent(token.id)}`, {
      method: "DELETE"
    });
    tokens = tokens.filter((candidate) => String(candidate.id) !== key);
    pendingTokenActions.delete(key);
    renderTokens();
    elements.tokenName.focus({ preventScroll: true });
    await requestRefresh({ afterCurrent: true });
  } catch (error) {
    setSecurityError(new Error(`“${token.name}” wasn’t revoked. ${error.message}`));
    await requestRefresh({ afterCurrent: true });
  } finally {
    pendingTokenActions.delete(key);
    renderTokens();
  }
}

elements.tokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSecurityError(null);
  const submit = elements.tokenForm.querySelector("button[type='submit']");
  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");

  try {
    const suppliedName = elements.tokenName.value.trim();
    const randomBytes = crypto.getRandomValues(new Uint8Array(3));
    const randomSuffix = Array.from(randomBytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    )
      .join("")
      .toUpperCase();
    const response = await fetchJson("/api/tokens", {
      method: "POST",
      body: JSON.stringify({
        name: suppliedName || `MCP token ${randomSuffix}`,
        allowPurchases: false
      })
    });
    const { token: secret, ...tokenRecord } = response;
    tokens = [tokenRecord, ...tokens.filter((token) => token.id !== tokenRecord.id)];
    tokenLoadState = "loaded";
    renderTokens();
    setText(elements.tokenSecretValue, secret);
    elements.tokenSecret.hidden = false;
    elements.tokenName.value = "";
    elements.copyToken.focus({ preventScroll: true });
    await requestRefresh({ afterCurrent: true });
  } catch (error) {
    setSecurityError(new Error(`The token wasn’t created. ${error.message}`));
  } finally {
    submit.disabled = false;
    submit.removeAttribute("aria-busy");
  }
});

elements.copyToken.addEventListener("click", async () => {
  window.clearTimeout(tokenCopyResetTimer);
  setSecurityError(null);
  elements.copyToken.disabled = true;

  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard access is unavailable.");
    }
    await navigator.clipboard.writeText(elements.tokenSecretValue.textContent);
    setText(elements.copyToken, "Copied");
    tokenCopyResetTimer = window.setTimeout(() => {
      if (elements.copyToken.isConnected) {
        setText(elements.copyToken, "Copy");
      }
    }, 1_200);
  } catch {
    setText(elements.copyToken, "Copy failed");
    setSecurityError(
      new Error("Couldn’t copy the token. Select it and copy it manually.")
    );
  } finally {
    elements.copyToken.disabled = false;
  }
});

elements.dismissToken.addEventListener("click", () => {
  window.clearTimeout(tokenCopyResetTimer);
  setText(elements.copyToken, "Copy");
  setText(elements.tokenSecretValue, "");
  elements.tokenSecret.hidden = true;
  setSecurityError(null);
  elements.tokenName.focus({ preventScroll: true });
});

elements.refresh.addEventListener("click", () => {
  void runManualRefresh();
});

elements.autoRefresh.addEventListener("change", () => {
  clearPollTimer();
  if (!elements.autoRefresh.checked) {
    announceStatus("Live updates paused.");
    return;
  }

  announceStatus("Live updates enabled.");
  void requestRefresh({ afterCurrent: true }).finally(scheduleNextPoll);
});

elements.search.addEventListener("input", renderEntries);
elements.statusFilter.addEventListener("change", renderEntries);

elements.mcpEndpoint.textContent = `${window.location.origin}/mcp`;
setText(elements.lastRefresh, "Loading…");
renderEntries();
renderTokens();
await requestRefresh();
scheduleNextPoll();
