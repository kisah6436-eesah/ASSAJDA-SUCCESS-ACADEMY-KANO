"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const DATABASE_PATH = path.resolve(process.env.DATABASE_PATH || path.join(DATA_DIR, "assajda.sqlite"));
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 3 * 1024 * 1024;
const STATIC_FILES = new Set(["/index.html", "/styles.css", "/app.js", "/assets/assajda-logo.png"]);
const GRADES = new Set(["Primary 1", "Primary 2", "Primary 3", "Primary 4", "Primary 5", "Primary 6", "JSS 1", "JSS 2", "JSS 3", "SS 1", "SS 2", "SS 3"]);
const loginFailures = new Map();
const passwordLimits = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
    password_hash TEXT NOT NULL,
    student_id TEXT UNIQUE,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    profile_image BLOB,
    profile_image_type TEXT,
    subject TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_casefold ON users(lower(username));
  CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    grade TEXT NOT NULL,
    joined TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS bulletins (
    id INTEGER PRIMARY KEY,
    grade TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('note', 'exam')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    pdf BLOB,
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS bulletins_grade_created ON bulletins(grade, created_at);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    recipient_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS messages_participants ON messages(sender_id, recipient_id, created_at);
  CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY,
    teacher_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS recommendations_created ON recommendations(created_at);
`);
const userColumns = new Set(database.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
if (!userColumns.has("profile_image")) database.exec("ALTER TABLE users ADD COLUMN profile_image BLOB");
if (!userColumns.has("profile_image_type")) database.exec("ALTER TABLE users ADD COLUMN profile_image_type TEXT");
if (!userColumns.has("subject")) database.exec("ALTER TABLE users ADD COLUMN subject TEXT");
database.exec("UPDATE users SET must_change_password = 0 WHERE role IN ('teacher', 'student')");

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 64, passwordLimits);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, saved) {
  const [, saltHex, hashHex] = String(saved || "").split("$");
  if (!saltHex || !hashHex || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(hashHex)) {
    crypto.scryptSync(password, DUMMY_SALT, 64, passwordLimits);
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, passwordLimits);
  return crypto.timingSafeEqual(actual, expected);
}

const DUMMY_SALT = crypto.randomBytes(16);
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(24).toString("base64url"), DUMMY_SALT);

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, code, message, headers) {
  sendJson(response, status, { error: code, message }, headers);
}

function readJson(request, maxBytes = MAX_JSON_BYTES) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return Promise.reject(Object.assign(new Error("Send request data as JSON."), { status: 415, code: "JSON_REQUIRED" }));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!rejected) {
          rejected = true;
          reject(Object.assign(new Error("Request body is too large."), { status: 413, code: "BODY_TOO_LARGE" }));
        }
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(Object.assign(new Error("Request data must be a JSON object."), { status: 400, code: "INVALID_DATA" }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400, code: "INVALID_JSON" }));
      }
    });
    request.on("error", reject);
  });
}

function cookieMap(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key));
}

function sessionCookie(token, clear = false) {
  const pieces = ["assajda_session=" + (clear ? "" : encodeURIComponent(token)), "Path=/", "HttpOnly", "SameSite=Strict"];
  if (process.env.NODE_ENV === "production") pieces.push("Secure");
  pieces.push("Max-Age=" + (clear ? "0" : String(Math.floor(SESSION_MS / 1000))));
  return pieces.join("; ");
}

function safeUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    studentId: row.student_id || null,
    name: row.student_name || (row.role === "admin" ? "Portal Administrator" : row.username),
    mustChangePassword: Boolean(row.must_change_password),
    hasProfileImage: Boolean(row.has_profile_image)
  };
}

function getSession(request) {
  const token = cookieMap(request).assajda_session;
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const row = database.prepare(`
    SELECT sessions.csrf_token, users.id, users.username, users.role, users.student_id,
      users.must_change_password, users.active, students.name AS student_name,
      users.profile_image IS NOT NULL AS has_profile_image
    FROM sessions JOIN users ON users.id = sessions.user_id
    LEFT JOIN students ON students.id = users.student_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash, Date.now());
  if (!row || !row.active) return null;
  return { tokenHash, csrfToken: row.csrf_token, user: safeUser(row) };
}

function checkSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function requireCsrf(request, session) {
  return checkSameOrigin(request) && request.headers["x-csrf-token"] === session.csrfToken;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  database.prepare("INSERT INTO sessions(token_hash, csrf_token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(tokenHash, csrfToken, userId, now + SESSION_MS, now);
  return { token, csrfToken };
}

function validUsername(value) {
  return /^[a-zA-Z0-9._-]{3,64}$/.test(value);
}

function loginFailureState(key) {
  const current = loginFailures.get(key);
  if (!current || current.until <= Date.now()) {
    loginFailures.delete(key);
    return null;
  }
  return current;
}

function failedLogin(key) {
  const current = loginFailureState(key) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
  current.count += 1;
  loginFailures.set(key, current);
  return current;
}

function clearLoginFailures(key) {
  loginFailures.delete(key);
}

function generateStudentId() {
  const prefix = `ASJ-${new Date().getFullYear()}-`;
  const rows = database.prepare("SELECT id FROM students WHERE id LIKE ?").all(prefix + "%");
  const max = rows.reduce((current, row) => {
    const match = row.id.match(/-(\d+)$/);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return prefix + String(max + 1).padStart(3, "0");
}

function generatedStudentPassword() {
  return "pass";
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/setup") {
    const exists = Boolean(database.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get());
    sendJson(response, 200, { setupRequired: !exists });
    return;
  }

  if (request.method === "POST" && pathname === "/api/setup") {
    if (!checkSameOrigin(request)) {
      sendError(response, 403, "ORIGIN_REJECTED", "Setup requests must come from this school portal.");
      return;
    }
    const payload = await readJson(request, 16 * 1024);
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");
    if (!validUsername(username)) {
      sendError(response, 400, "INVALID_USERNAME", "Username must be 3–64 letters, numbers, dots, underscores, or hyphens.");
      return;
    }
    if (password !== "pass") {
      sendError(response, 400, "INVALID_PASSWORD", "Use the configured initial password.");
      return;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      if (database.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()) {
        database.exec("ROLLBACK");
        sendError(response, 409, "ADMIN_EXISTS", "An administrator account has already been created.");
        return;
      }
      const result = database.prepare("INSERT INTO users(username, role, password_hash) VALUES (?, 'admin', ?)")
        .run(username, hashPassword(password));
      database.exec("COMMIT");
      sendJson(response, 201, { username, userId: Number(result.lastInsertRowid) });
    } catch (error) {
      database.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE constraint failed")) {
        sendError(response, 409, "USERNAME_EXISTS", "That username is already in use.");
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/login") {
    const payload = await readJson(request, 16 * 1024);
    if (!checkSameOrigin(request)) {
      sendError(response, 403, "ORIGIN_REJECTED", "Sign-in requests must come from this school portal.");
      return;
    }
    const role = String(payload.role || "");
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");
    if (!["admin", "teacher", "student"].includes(role) || username.length > 80 || password.length > 256) {
      sendError(response, 400, "INVALID_LOGIN", "Enter a valid account type, username, and password.");
      return;
    }
    const key = `${request.socket.remoteAddress || "unknown"}:${username.toLowerCase()}`;
    const locked = loginFailureState(key);
    if (locked && locked.count >= 5) {
      sendError(response, 429, "LOGIN_RATE_LIMIT", "Too many sign-in attempts. Try again in 15 minutes.", { "Retry-After": String(Math.ceil((locked.until - Date.now()) / 1000)) });
      return;
    }
    const row = database.prepare(`
      SELECT users.id, users.username, users.role, users.student_id, users.password_hash,
        users.must_change_password, users.active, students.name AS student_name,
        users.profile_image IS NOT NULL AS has_profile_image
      FROM users LEFT JOIN students ON students.id = users.student_id
      WHERE lower(users.username) = lower(?) OR lower(users.student_id) = lower(?)
      LIMIT 1
    `).get(username, username);
    const valid = row && row.role === role && row.active && verifyPassword(password, row.password_hash);
    if (!valid) {
      if (!row) verifyPassword(password, DUMMY_PASSWORD_HASH);
      const failures = failedLogin(key);
      if (failures.count >= 5) {
        sendError(response, 429, "LOGIN_RATE_LIMIT", "Too many sign-in attempts. Try again in  10 sec.", { "Retry-After": String(Math.ceil((failures.until - Date.now()) / 1000)) });
      } else {
        sendError(response, 401, "INVALID_CREDENTIALS", "Account type, username, or password is incorrect.");
      }
      return;
    }
    clearLoginFailures(key);
    const created = createSession(row.id);
    sendJson(response, 200, { user: safeUser(row), csrfToken: created.csrfToken }, { "Set-Cookie": sessionCookie(created.token) });
    return;
  }

  const session = getSession(request);
  if (request.method === "GET" && pathname === "/api/session") {
    if (!session) {
      response.setHeader("Set-Cookie", sessionCookie("", true));
      sendJson(response, 200, { user: null, csrfToken: null });
      return;
    }
    sendJson(response, 200, { user: session.user, csrfToken: session.csrfToken });
    return;
  }
  if (!session) {
    sendError(response, 401, "UNAUTHENTICATED", "Sign in to continue.");
    return;
  }
  if (["POST", "PATCH", "DELETE"].includes(request.method) && !requireCsrf(request, session)) {
    sendError(response, 403, "CSRF_REJECTED", "Refresh the page and try again.");
    return;
  }
  if (request.method === "POST" && pathname === "/api/logout") {
    database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.tokenHash);
    sendJson(response, 200, { ok: true }, { "Set-Cookie": sessionCookie("", true) });
    return;
  }
  if (request.method === "POST" && pathname === "/api/password") {
    if (session.user.role !== "admin") {
      sendError(response, 403, "FORBIDDEN", "Teacher and student passwords are managed by the administrator.");
      return;
    }
    const payload = await readJson(request, 16 * 1024);
    const currentPassword = String(payload.currentPassword || "");
    const newPassword = String(payload.newPassword || "");
    const row = database.prepare("SELECT password_hash FROM users WHERE id = ?").get(session.user.id);
    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      sendError(response, 400, "CURRENT_PASSWORD_INVALID", "Current password is incorrect.");
      return;
    }
    if (newPassword !== "pass" && (newPassword.length < 12 || newPassword.length > 256)) {
      sendError(response, 400, "WEAK_PASSWORD", "Use the configured password or a password with at least 12 characters.");
      return;
    }
    database.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
      .run(hashPassword(newPassword), session.user.id);
    database.prepare("DELETE FROM sessions WHERE user_id = ?").run(session.user.id);
    const created = createSession(session.user.id);
    const refreshed = database.prepare(`
      SELECT users.id, users.username, users.role, users.student_id, users.must_change_password, users.active,
        students.name AS student_name, users.profile_image IS NOT NULL AS has_profile_image
      FROM users LEFT JOIN students ON students.id = users.student_id WHERE users.id = ?
    `).get(session.user.id);
    sendJson(response, 200, { user: safeUser(refreshed), csrfToken: created.csrfToken }, { "Set-Cookie": sessionCookie(created.token) });
    return;
  }
  if (session.user.role === "admin" && session.user.mustChangePassword) {
    sendError(response, 403, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password before using the portal.");
    return;
  }

  const profileImageMatch = pathname.match(/^\/api\/profile-images\/(\d+)$/);
  if (profileImageMatch && request.method === "GET") {
    const userId = Number(profileImageMatch[1]);
    const image = database.prepare("SELECT role, profile_image, profile_image_type FROM users WHERE id = ?").get(userId);
    if (!image || !["teacher", "student"].includes(image.role) || !image.profile_image) {
      sendError(response, 404, "PROFILE_IMAGE_NOT_FOUND", "No profile photo was found.");
      return;
    }
    if (session.user.role === "student" && image.role === "student" && userId !== session.user.id) {
      sendError(response, 403, "FORBIDDEN", "Student profile photos are private.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": image.profile_image_type,
      "Content-Length": image.profile_image.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox"
    });
    response.end(image.profile_image);
    return;
  }
  if (profileImageMatch && request.method === "POST") {
    if (session.user.role !== "admin") {
      sendError(response, 403, "FORBIDDEN", "Administrator access is required to upload profile photos.");
      return;
    }
    const userId = Number(profileImageMatch[1]);
    const account = database.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    if (!account || !["teacher", "student"].includes(account.role)) {
      sendError(response, 404, "ACCOUNT_NOT_FOUND", "The teacher or student account was not found.");
      return;
    }
    const payload = await readJson(request, 2 * 1024 * 1024);
    const match = String(payload.image || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) {
      sendError(response, 400, "INVALID_PROFILE_IMAGE", "Upload a JPG, PNG, or WebP image.");
      return;
    }
    const imageType = `image/${match[1]}`;
    const image = Buffer.from(match[2], "base64");
    const validSignature = imageType === "image/jpeg"
      ? image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
      : imageType === "image/png"
        ? image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : image.length >= 12 && image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP";
    if (!image.length || image.length > 1024 * 1024 || !validSignature) {
      sendError(response, 400, "INVALID_PROFILE_IMAGE", "The image must be a valid JPG, PNG, or WebP file no larger than 1 MB.");
      return;
    }
    database.prepare("UPDATE users SET profile_image = ?, profile_image_type = ? WHERE id = ?")
      .run(image, imageType, userId);
    sendJson(response, 200, { ok: true });
    return;
  }
  const resetPasswordMatch = pathname.match(/^\/api\/admin-accounts\/(\d+)\/reset-password$/);
  if (resetPasswordMatch && request.method === "POST") {
    if (session.user.role !== "admin") {
      sendError(response, 403, "FORBIDDEN", "Administrator access is required to reset account passwords.");
      return;
    }
    const userId = Number(resetPasswordMatch[1]);
    const account = database.prepare(`
      SELECT users.id, users.username, users.role, students.name AS student_name
      FROM users LEFT JOIN students ON students.id = users.student_id
      WHERE users.id = ? AND users.role IN ('teacher', 'student')
    `).get(userId);
    if (!account) {
      sendError(response, 404, "ACCOUNT_NOT_FOUND", "The teacher or student account was not found.");
      return;
    }
    const password = "pass";
    database.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
      .run(hashPassword(password), userId);
    database.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    sendJson(response, 200, { username: account.username, role: account.role, password });
    return;
  }

  if (request.method === "GET" && pathname === "/api/students") {
    let rows;
    if (session.user.role === "student") {
      rows = database.prepare(`SELECT students.id, students.name, students.grade, students.joined,
        users.id AS userId, users.profile_image IS NOT NULL AS hasProfileImage
        FROM students JOIN users ON users.student_id = students.id
        WHERE students.id = ?`).all(session.user.studentId);
    } else {
      rows = database.prepare(`SELECT students.id, students.name, students.grade, students.joined,
        users.id AS userId, users.profile_image IS NOT NULL AS hasProfileImage
        FROM students JOIN users ON users.student_id = students.id
        ORDER BY students.name COLLATE NOCASE`).all();
    }
    sendJson(response, 200, { students: rows });
    return;
  }
  if (request.method === "POST" && pathname === "/api/students") {
    if (session.user.role !== "admin") {
      sendError(response, 403, "FORBIDDEN", "Administrator access is required.");
      return;
    }
    const payload = await readJson(request, 16 * 1024);
    const name = String(payload.name || "").trim();
    const grade = String(payload.grade || "");
    if (!name || name.length > 80 || !GRADES.has(grade)) {
      sendError(response, 400, "INVALID_STUDENT", "Enter a student name and choose a valid class.");
      return;
    }
    const temporaryPassword = generatedStudentPassword();
    let id;
    database.exec("BEGIN IMMEDIATE");
    try {
      id = generateStudentId();
      database.prepare("INSERT INTO students(id, name, grade, joined) VALUES (?, ?, ?, ?)")
        .run(id, name, grade, new Date().toISOString().slice(0, 10));
      database.prepare("INSERT INTO users(username, role, password_hash, student_id, must_change_password) VALUES (?, 'student', ?, ?, 0)")
        .run(id, hashPassword(temporaryPassword), id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const student = database.prepare("SELECT id, name, grade, joined FROM students WHERE id = ?").get(id);
    sendJson(response, 201, { student, temporaryPassword });
    return;
  }
  if (request.method === "GET" && pathname === "/api/teachers") {
    if (!["admin", "student"].includes(session.user.role)) {
      sendError(response, 403, "FORBIDDEN", "Administrator access is required.");
      return;
    }
    const teachers = session.user.role === "admin"
      ? database.prepare(`SELECT id, username, active, created_at AS createdAt,
          profile_image IS NOT NULL AS hasProfileImage, subject
        FROM users WHERE role = 'teacher' ORDER BY username COLLATE NOCASE`).all()
      : database.prepare("SELECT username FROM users WHERE role = 'teacher' AND active = 1 ORDER BY username COLLATE NOCASE").all();
    sendJson(response, 200, { teachers });
    return;
  }
  if (request.method === "POST" && pathname === "/api/teachers") {
    if (session.user.role !== "admin") {
      sendError(response, 403, "FORBIDDEN", "Administrator access is required.");
      return;
    }
    const payload = await readJson(request, 16 * 1024);
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");
    const subject = String(payload.subject || "").trim();
    if (!validUsername(username)) {
      sendError(response, 400, "INVALID_USERNAME", "Teacher user ID must be 3–64 letters, numbers, dots, underscores, or hyphens.");
      return;
    }
    if (password !== "pass") {
      sendError(response, 400, "INVALID_PASSWORD", "The initial password for new accounts is pass.");
      return;
    }
    if (!subject || subject.length > 80) {
      sendError(response, 400, "INVALID_SUBJECT", "Choose a subject or enter a custom subject.");
      return;
    }
    try {
      database.prepare("INSERT INTO users(username, role, password_hash, must_change_password, subject) VALUES (?, 'teacher', ?, 0, ?)")
        .run(username, hashPassword(password), subject);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        sendError(response, 409, "USERNAME_EXISTS", "That teacher user ID is already in use.");
        return;
      }
      throw error;
    }
    sendJson(response, 201, { username, mustChangePassword: false, subject });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin-accounts") {
    if (session.user.role !== "admin") {
      sendError(response, 403, "FORBIDDEN", "Administrator access is required.");
      return;
    }
    const payload = await readJson(request, 16 * 1024);
    const role = String(payload.role || "");
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");
    const studentId = String(payload.studentId || "").trim();
    const subject = String(payload.subject || "").trim();
    if (!["teacher", "student"].includes(role)) {
      sendError(response, 400, "INVALID_ROLE", "Choose a role for the account.");
      return;
    }
    if (!validUsername(username)) {
      sendError(response, 400, "INVALID_USERNAME", "Use 3–64 letters, numbers, dots, underscores, or hyphens.");
      return;
    }
    if (password !== "pass") {
      sendError(response, 400, "INVALID_PASSWORD", "The initial password for new accounts is pass.");
      return;
    }
    if (role === "student") {
      if (!studentId) {
        sendError(response, 400, "MISSING_STUDENT", "Select the linked student profile before creating the student account.");
        return;
      }
      const student = database.prepare("SELECT id FROM students WHERE id = ?").get(studentId);
      if (!student) {
        sendError(response, 404, "STUDENT_NOT_FOUND", "The selected student profile was not found.");
        return;
      }
    } else if (!subject || subject.length > 80) {
      sendError(response, 400, "INVALID_SUBJECT", "Choose a subject or enter a custom subject.");
      return;
    }
    try {
      if (role === "teacher") {
        database.prepare("INSERT INTO users(username, role, password_hash, must_change_password, subject) VALUES (?, 'teacher', ?, 0, ?)")
          .run(username, hashPassword(password), subject);
      } else {
        database.prepare("INSERT INTO users(username, role, password_hash, student_id, must_change_password) VALUES (?, 'student', ?, ?, 0)")
          .run(username, hashPassword(password), studentId);
      }
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        sendError(response, 409, "USERNAME_EXISTS", "That user ID is already in use.");
        return;
      }
      throw error;
    }
    sendJson(response, 201, { username, role, studentId: role === "student" ? studentId : null, subject: role === "teacher" ? subject : null, password });
    return;
  }

  if (request.method === "GET" && pathname === "/api/bulletins") {
    const rows = session.user.role === "student"
      ? database.prepare(`
          SELECT bulletins.id, bulletins.grade, bulletins.category, bulletins.title, bulletins.body,
            bulletins.pdf IS NOT NULL AS hasPdf, bulletins.created_at AS createdAt, users.username AS author
          FROM bulletins JOIN students ON students.grade = bulletins.grade
          JOIN users ON users.id = bulletins.author_id
          WHERE students.id = ? ORDER BY bulletins.created_at DESC, bulletins.id DESC
        `).all(session.user.studentId)
      : database.prepare(`
          SELECT bulletins.id, bulletins.grade, bulletins.category, bulletins.title, bulletins.body,
            bulletins.pdf IS NOT NULL AS hasPdf, bulletins.created_at AS createdAt, users.username AS author
          FROM bulletins JOIN users ON users.id = bulletins.author_id
          ORDER BY bulletins.created_at DESC, bulletins.id DESC
        `).all();
    sendJson(response, 200, { bulletins: rows });
    return;
  }
  if (request.method === "POST" && pathname === "/api/bulletins") {
    if (session.user.role !== "teacher") {
      sendError(response, 403, "FORBIDDEN", "Teacher access is required to publish class notes.");
      return;
    }
    const payload = await readJson(request);
    const grade = String(payload.grade || "");
    const category = String(payload.category || "");
    const title = String(payload.title || "").trim();
    const body = String(payload.body || "").trim();
    if (!GRADES.has(grade) || !["note", "exam"].includes(category) || !title || title.length > 120 || !body || body.length > 5000) {
      sendError(response, 400, "INVALID_BULLETIN", "Choose a class and type a title and message (up to 5,000 characters).");
      return;
    }
    let pdf = null;
    if (payload.pdf !== undefined && payload.pdf !== null && payload.pdf !== "") {
      const match = String(payload.pdf).match(/^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) {
        sendError(response, 400, "INVALID_PDF", "Upload a valid PDF exam-note file.");
        return;
      }
      pdf = Buffer.from(match[1], "base64");
      if (pdf.length > 2 * 1024 * 1024 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
        sendError(response, 400, "INVALID_PDF", "The PDF must be valid and no larger than 2 MB.");
        return;
      }
    }
    const result = database.prepare(`
      INSERT INTO bulletins(grade, category, title, body, pdf, author_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(grade, category, title, body, pdf, session.user.id);
    const bulletin = database.prepare(`
      SELECT id, grade, category, title, body, pdf IS NOT NULL AS hasPdf, created_at AS createdAt
      FROM bulletins WHERE id = ?
    `).get(Number(result.lastInsertRowid));
    sendJson(response, 201, { bulletin });
    return;
  }
  const bulletinFileMatch = pathname.match(/^\/api\/bulletins\/(\d+)\/file$/);
  if (request.method === "GET" && bulletinFileMatch) {
    const bulletin = database.prepare(`
      SELECT bulletins.id, bulletins.grade, bulletins.pdf, students.grade AS student_grade
      FROM bulletins LEFT JOIN students ON students.id = ? WHERE bulletins.id = ?
    `).get(session.user.studentId, Number(bulletinFileMatch[1]));
    if (!bulletin || !bulletin.pdf || (session.user.role === "student" && bulletin.grade !== bulletin.student_grade)) {
      sendError(response, 404, "NOT_FOUND", "That PDF was not found.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": bulletin.pdf.length,
      "Content-Disposition": `attachment; filename="exam-note-${bulletin.id}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox"
    });
    response.end(bulletin.pdf);
    return;
  }
  if (request.method === "GET" && pathname === "/api/messages") {
    if (!["student", "teacher"].includes(session.user.role)) {
      sendError(response, 403, "FORBIDDEN", "Messages are available only to students and teachers.");
      return;
    }
    const rows = database.prepare(`
      SELECT messages.id, messages.sender_id AS senderId, messages.recipient_id AS recipientId,
        sender.username AS senderUsername, sender.role AS senderRole,
        recipient.username AS recipientUsername, recipient.role AS recipientRole,
        messages.body, messages.created_at AS createdAt
      FROM messages
      JOIN users AS sender ON sender.id = messages.sender_id
      JOIN users AS recipient ON recipient.id = messages.recipient_id
      WHERE (messages.sender_id = ? OR messages.recipient_id = ?)
        AND ((sender.role = 'student' AND recipient.role = 'teacher')
          OR (sender.role = 'teacher' AND recipient.role = 'student'))
      ORDER BY messages.created_at ASC, messages.id ASC
    `).all(session.user.id, session.user.id);
    sendJson(response, 200, { messages: rows });
    return;
  }
  if (request.method === "POST" && pathname === "/api/messages") {
    if (!["student", "teacher"].includes(session.user.role)) {
      sendError(response, 403, "FORBIDDEN", "Messages are available only to students and teachers.");
      return;
    }
    const payload = await readJson(request, 32 * 1024);
    const body = String(payload.body || "").trim();
    if (!body || body.length > 2000) {
      sendError(response, 400, "INVALID_MESSAGE", "Write a message up to 2,000 characters.");
      return;
    }
    let recipient;
    if (session.user.role === "student") {
      const teacherUsername = String(payload.teacherUsername || "").trim();
      recipient = database.prepare("SELECT id FROM users WHERE lower(username) = lower(?) AND role = 'teacher' AND active = 1")
        .get(teacherUsername);
    } else {
      const studentId = String(payload.studentId || "").trim();
      recipient = database.prepare("SELECT id FROM users WHERE student_id = ? AND role = 'student' AND active = 1")
        .get(studentId);
    }
    if (!recipient) {
      sendError(response, 404, "RECIPIENT_NOT_FOUND", "Choose an active teacher or a student who has an active profile.");
      return;
    }
    database.prepare("INSERT INTO messages(sender_id, recipient_id, body) VALUES (?, ?, ?)")
      .run(session.user.id, recipient.id, body);
    sendJson(response, 201, { ok: true });
    return;
  }
  if (request.method === "GET" && pathname === "/api/recommendations") {
    if (!["admin", "teacher"].includes(session.user.role)) {
      sendError(response, 403, "FORBIDDEN", "Recommendations are available only to teachers and administrators.");
      return;
    }
    const recommendations = session.user.role === "admin"
      ? database.prepare(`
          SELECT recommendations.id, recommendations.body, recommendations.created_at AS createdAt,
            users.username AS teacher
          FROM recommendations JOIN users ON users.id = recommendations.teacher_id
          ORDER BY recommendations.created_at DESC, recommendations.id DESC
        `).all()
      : database.prepare(`
          SELECT id, body, created_at AS createdAt
          FROM recommendations WHERE teacher_id = ? ORDER BY created_at DESC, id DESC
        `).all(session.user.id);
    sendJson(response, 200, { recommendations });
    return;
  }
  if (request.method === "POST" && pathname === "/api/recommendations") {
    if (session.user.role !== "teacher") {
      sendError(response, 403, "FORBIDDEN", "Only teachers can submit recommendations.");
      return;
    }
    const payload = await readJson(request, 32 * 1024);
    const body = String(payload.body || "").trim();
    if (!body || body.length > 3000) {
      sendError(response, 400, "INVALID_RECOMMENDATION", "Write a recommendation up to 3,000 characters.");
      return;
    }
    database.prepare("INSERT INTO recommendations(teacher_id, body) VALUES (?, ?)")
      .run(session.user.id, body);
    sendJson(response, 201, { ok: true });
    return;
  }

  sendError(response, 404, "NOT_FOUND", "API route was not found.");
}

function secureHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  if (requested === "/msmr.html") {
    response.writeHead(302, { Location: "/", "Cache-Control": "no-store" }).end();
    return;
  }
  if (!STATIC_FILES.has(requested)) {
    response.writeHead(404).end("Not found");
    return;
  }
  const filename = path.resolve(ROOT, "." + requested);
  if (!filename.startsWith(ROOT + path.sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  fs.stat(filename, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    const type = path.extname(filename) === ".js" ? "text/javascript; charset=utf-8"
      : path.extname(filename) === ".css" ? "text/css; charset=utf-8"
        : path.extname(filename) === ".png" ? "image/png" : "text/html; charset=utf-8";
    response.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    fs.createReadStream(filename).pipe(response);
  });
}

function main() {
  const server = http.createServer(async (request, response) => {
    secureHeaders(response);
    try {
      const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
      if (pathname.startsWith("/api/")) {
        await handleApi(request, response, pathname);
        return;
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed.");
        return;
      }
      serveStatic(response, pathname);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error.status) {
        sendError(response, error.status, error.code || "REQUEST_ERROR", error.message);
        return;
      }
      console.error("Request failed:", error);
      sendError(response, 500, "INTERNAL_ERROR", "The request could not be completed.");
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`Assajda school portal listening on http://${HOST}:${PORT}`);
    console.log(`SQLite database: ${DATABASE_PATH}`);
    if (HOST === "127.0.0.1" || HOST === "localhost") {
      console.log("For access from other devices on your trusted LAN, set HOST=0.0.0.0 and configure your firewall.");
    }
  });
}

main();
