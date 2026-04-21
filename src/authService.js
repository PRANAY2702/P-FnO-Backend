/**
 * authService.js
 * In-memory user store + JWT/bcrypt helpers for P-FnO auth.
 * Replace the user store with a real DB (MongoDB, PostgreSQL) in production.
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "pfno-secret-key-change-in-production";
const JWT_EXPIRES = "7d";

// ─── In-memory user store ────────────────────────────────────────────────────
// { id, userId, email, fullName, passwordHash, googleId, provider, createdAt }
const users = [];
let nextId = 1;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, userId: user.userId },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function sanitizeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// ─── User CRUD ────────────────────────────────────────────────────────────────
async function createUser({ userId, email, password, fullName, provider = "local", googleId = null }) {
  const existing = users.find(
    (u) => u.email === email || (userId && u.userId === userId)
  );
  if (existing) {
    throw new Error("User with this email or user ID already exists.");
  }

  const passwordHash = password ? await bcrypt.hash(password, 12) : null;

  const user = {
    id: nextId++,
    userId: userId || `user_${Date.now()}`,
    email,
    fullName: fullName || "",
    passwordHash,
    googleId,
    provider,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  return sanitizeUser(user);
}

async function findUserByEmail(email) {
  return users.find((u) => u.email === email) || null;
}

async function findUserById(id) {
  return users.find((u) => u.id === id) || null;
}

async function findOrCreateGoogleUser({ googleId, email, fullName }) {
  // Check by googleId first
  let user = users.find((u) => u.googleId === googleId);
  if (user) return sanitizeUser(user);

  // Check by email (link account if email exists)
  const byEmail = users.find((u) => u.email === email);
  if (byEmail) {
    byEmail.googleId = googleId;
    byEmail.provider = "google";
    return sanitizeUser(byEmail);
  }

  // Create new Google user
  return await createUser({ email, fullName, googleId, provider: "google" });
}

async function validatePassword(email, password) {
  const user = await findUserByEmail(email);
  if (!user) return null;
  if (!user.passwordHash) return null; // Google-only account
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? sanitizeUser(user) : null;
}

module.exports = {
  generateToken,
  verifyToken,
  createUser,
  findUserByEmail,
  findUserById,
  findOrCreateGoogleUser,
  validatePassword,
  sanitizeUser,
};
