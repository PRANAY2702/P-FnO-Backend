/**
 * authService.js
 * Prisma PostgreSQL user store + JWT/bcrypt helpers for P-FnO auth.
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");

// We export a function or just instantiate one. We will try to instantiate safely.
let prisma;
try {
  prisma = new PrismaClient();
} catch (err) {
  console.warn("Prisma Client not initialized. Run 'npx prisma generate'.");
}

const JWT_SECRET = process.env.JWT_SECRET || "pfno-secret-key-change-in-production";
const JWT_EXPIRES = "7d";

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
  if (!user) return null;
  const { passwordHash, kotakApiKeys, ...safe } = user;
  return { ...safe, kotakApiSaved: !!(kotakApiKeys && kotakApiKeys.consumerKey) };
}

// ─── User CRUD ────────────────────────────────────────────────────────────────
async function createUser({ userId, email, password, fullName, broker, provider = "local", googleId = null }) {
  if (!prisma) throw new Error("Database not connected. Please check your DATABASE_URL and run 'npx prisma generate'.");
  
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { userId: userId || "" }] },
  });
  if (existing) {
    throw new Error("User with this email or user ID already exists.");
  }

  const passwordHash = password ? await bcrypt.hash(password, 12) : null;

  const user = await prisma.user.create({
    data: {
      userId: userId || `user_${Date.now()}`,
      email,
      fullName: fullName || "",
      passwordHash,
      broker: broker || "Kotak Neo",
      googleId,
      provider,
    },
    include: { kotakApiKeys: true },
  });

  return sanitizeUser(user);
}

async function findUserByEmail(email) {
  if (!prisma) throw new Error("Database not connected. Please run 'npx prisma generate'.");
  return await prisma.user.findUnique({ where: { email }, include: { kotakApiKeys: true } });
}

async function findUserById(id) {
  if (!prisma) throw new Error("Database not connected. Please run 'npx prisma generate'.");
  return await prisma.user.findUnique({ where: { id }, include: { kotakApiKeys: true } });
}

async function findOrCreateGoogleUser({ googleId, email, fullName }) {
  if (!prisma) throw new Error("Database not connected. Please run 'npx prisma generate'.");
  
  let user = await prisma.user.findUnique({ where: { googleId }, include: { kotakApiKeys: true } });
  if (user) return sanitizeUser(user);

  const byEmail = await prisma.user.findUnique({ where: { email }, include: { kotakApiKeys: true } });
  if (byEmail) {
    user = await prisma.user.update({
      where: { email },
      data: { googleId, provider: "google" },
      include: { kotakApiKeys: true },
    });
    return sanitizeUser(user);
  }

  return await createUser({ email, fullName, googleId, provider: "google" });
}

async function validatePassword(email, password) {
  if (!prisma) throw new Error("Database not connected. Please run 'npx prisma generate'.");
  
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) return null;
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
  saveKotakApiKeys: async (userId, keys) => {
    if (!prisma) return null;
    await prisma.kotakApiKey.upsert({
      where: { userId },
      update: keys,
      create: { ...keys, userId },
    });
    const user = await findUserById(userId);
    return sanitizeUser(user);
  },
  getKotakApiKeys: async (userId) => {
    if (!prisma) return null;
    const key = await prisma.kotakApiKey.findUnique({ where: { userId } });
    return key;
  },
  prisma,
};
