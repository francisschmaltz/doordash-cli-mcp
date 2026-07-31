const DEFAULT_CAPACITY = 100;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;

export class ActivityLog {
  #capacity;
  #entries = [];
  #maxPayloadBytes;
  #nextId = 1;

  constructor({ capacity = DEFAULT_CAPACITY, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
    this.#capacity = capacity;
    this.#maxPayloadBytes = maxPayloadBytes;
  }

  start(args) {
    return {
      id: this.#nextId++,
      command: [...args],
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now()
    };
  }

  succeed(pending, result) {
    return this.#append(pending, "success", result);
  }

  fail(pending, result) {
    return this.#append(pending, "error", result);
  }

  list(limit = this.#capacity) {
    const safeLimit = Math.max(1, Math.min(this.#capacity, limit));
    return this.#entries.slice(-safeLimit).reverse();
  }

  get size() {
    return this.#entries.length;
  }

  #append(pending, status, result) {
    const finishedAtMs = Date.now();
    const entry = {
      id: pending.id,
      command: pending.command,
      status,
      startedAt: pending.startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - pending.startedAtMs,
      result: this.#snapshot(result)
    };

    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) {
      this.#entries.splice(0, this.#entries.length - this.#capacity);
    }

    return entry;
  }

  #snapshot(value) {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") <= this.#maxPayloadBytes) {
      return JSON.parse(json);
    }

    return {
      truncated: true,
      originalBytes: Buffer.byteLength(json, "utf8"),
      preview: json.slice(0, this.#maxPayloadBytes)
    };
  }
}
