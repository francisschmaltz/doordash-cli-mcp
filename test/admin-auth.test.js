import assert from "node:assert/strict";
import test from "node:test";

import { createAdminAuth } from "../src/admin-auth.js";

const ACCESS_TOKEN = "correct-horse-battery-staple";

function request({
  authorization,
  body,
  cookie,
  html = false,
  method = "GET",
  path = "/api/status",
  secure = false
} = {}) {
  return {
    accepts: (type) => (html && type === "html" ? "html" : false),
    body,
    headers: {
      authorization,
      cookie
    },
    method,
    path,
    secure
  };
}

function response() {
  return {
    body: null,
    ended: false,
    headers: new Map(),
    redirectLocation: null,
    statusCode: 200,
    end() {
      this.ended = true;
      return this;
    },
    json(body) {
      this.body = body;
      this.ended = true;
      return this;
    },
    redirect(status, location) {
      this.statusCode = status;
      this.redirectLocation = location;
      this.ended = true;
      return this;
    },
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    }
  };
}

test("requires a substantial admin access token", () => {
  assert.throws(
    () => createAdminAuth({ accessToken: "too-short" }),
    /at least 16 characters/
  );
});

test("exchanges the admin secret for a revocable session cookie", () => {
  let currentTime = 1_000;
  const auth = createAdminAuth({
    accessToken: ACCESS_TOKEN,
    createSessionId: () => "test-session-id",
    now: () => currentTime,
    sessionTtlMs: 60_000
  });

  const rejected = response();
  auth.login(
    request({
      body: { secret: "wrong-secret" },
      method: "POST",
      path: "/api/admin/session"
    }),
    rejected
  );
  assert.equal(rejected.statusCode, 401);
  assert.deepEqual(rejected.body, { error: "Invalid admin secret." });

  const accepted = response();
  auth.login(
    request({
      body: { secret: ACCESS_TOKEN },
      method: "POST",
      path: "/api/admin/session"
    }),
    accepted
  );
  assert.equal(accepted.statusCode, 204);
  const setCookie = accepted.headers.get("set-cookie");
  assert.match(setCookie, /^dd_admin_session=test-session-id;/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, new RegExp(ACCESS_TOKEN));

  const cookie = setCookie.split(";")[0];
  let admitted = false;
  auth.requireAdmin(request({ cookie }), response(), () => {
    admitted = true;
  });
  assert.equal(admitted, true);

  const logoutResponse = response();
  auth.logout(request({ cookie }), logoutResponse);
  assert.equal(logoutResponse.statusCode, 204);
  assert.match(logoutResponse.headers.get("set-cookie"), /Max-Age=0/);

  const afterLogout = response();
  auth.requireAdmin(request({ cookie }), afterLogout, () => {});
  assert.equal(afterLogout.statusCode, 401);

  auth.login(
    request({
      body: { secret: ACCESS_TOKEN },
      method: "POST",
      path: "/api/admin/session"
    }),
    response()
  );
  currentTime += 60_001;
  const expired = response();
  auth.requireAdmin(
    request({ cookie: "dd_admin_session=test-session-id" }),
    expired,
    () => {}
  );
  assert.equal(expired.statusCode, 401);
});

test("accepts the admin access token as a bearer token", () => {
  const auth = createAdminAuth({ accessToken: ACCESS_TOKEN });
  let admitted = false;
  auth.requireAdmin(
    request({ authorization: `Bearer ${ACCESS_TOKEN}` }),
    response(),
    () => {
      admitted = true;
    }
  );
  assert.equal(admitted, true);
});

test("redirects browser navigation to login but keeps APIs JSON", () => {
  const auth = createAdminAuth({ accessToken: ACCESS_TOKEN });

  const pageResponse = response();
  auth.requireAdmin(
    request({ html: true, path: "/" }),
    pageResponse,
    () => {}
  );
  assert.equal(pageResponse.statusCode, 303);
  assert.equal(pageResponse.redirectLocation, "/login");

  const apiResponse = response();
  auth.requireAdmin(
    request({ html: true, path: "/api/status" }),
    apiResponse,
    () => {}
  );
  assert.equal(apiResponse.statusCode, 401);
  assert.deepEqual(apiResponse.body, {
    error: "Admin authentication required."
  });
});
