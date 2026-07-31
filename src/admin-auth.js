import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const COOKIE_NAME = "dd_admin_session";
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function secretsMatch(actual, expected) {
  return timingSafeEqual(digest(actual), digest(expected));
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ""));
  return match?.[1]?.trim() || null;
}

function sessionCookie(value, maxAgeSeconds, secure = false) {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export function createAdminAuth({
  accessToken,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  now = () => Date.now(),
  createSessionId = () => randomBytes(32).toString("base64url")
}) {
  if (typeof accessToken !== "string" || accessToken.length < 16) {
    throw new Error("ADMIN_ACCESS_TOKEN must contain at least 16 characters.");
  }
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs < 1_000) {
    throw new Error("Admin session TTL must be at least 1000ms.");
  }

  const sessions = new Map();

  function pruneSessions() {
    const currentTime = now();
    for (const [sessionId, expiresAt] of sessions) {
      if (expiresAt <= currentTime) {
        sessions.delete(sessionId);
      }
    }
  }

  function sessionIdFor(req) {
    const sessionId = cookieValue(req.headers.cookie, COOKIE_NAME);
    if (!sessionId) {
      return null;
    }
    const expiresAt = sessions.get(sessionId);
    if (!expiresAt || expiresAt <= now()) {
      sessions.delete(sessionId);
      return null;
    }
    return sessionId;
  }

  function hasBearerAccess(req) {
    const token = bearerToken(req.headers.authorization);
    return token ? secretsMatch(token, accessToken) : false;
  }

  function isAuthenticated(req) {
    return hasBearerAccess(req) || Boolean(sessionIdFor(req));
  }

  function login(req, res) {
    const secret = req.body?.secret;
    if (typeof secret !== "string" || !secretsMatch(secret, accessToken)) {
      res.status(401).json({ error: "Invalid admin secret." });
      return;
    }

    pruneSessions();
    const sessionId = createSessionId();
    sessions.set(sessionId, now() + sessionTtlMs);
    res.setHeader(
      "Set-Cookie",
      sessionCookie(
        sessionId,
        Math.floor(sessionTtlMs / 1_000),
        Boolean(req.secure)
      )
    );
    res.status(204).end();
  }

  function requireAdmin(req, res, next) {
    if (isAuthenticated(req)) {
      next();
      return;
    }

    if (
      req.method === "GET" &&
      !req.path.startsWith("/api/") &&
      req.path !== "/activity" &&
      req.accepts("html")
    ) {
      res.redirect(303, "/login");
      return;
    }

    res.status(401).json({ error: "Admin authentication required." });
  }

  function redirectAuthenticated(req, res, next) {
    if (isAuthenticated(req)) {
      res.redirect(303, "/");
      return;
    }
    next();
  }

  function logout(req, res) {
    const sessionId = sessionIdFor(req);
    if (sessionId) {
      sessions.delete(sessionId);
    }
    res.setHeader(
      "Set-Cookie",
      sessionCookie("", 0, Boolean(req.secure))
    );
    res.status(204).end();
  }

  return {
    isAuthenticated,
    login,
    logout,
    redirectAuthenticated,
    requireAdmin
  };
}
