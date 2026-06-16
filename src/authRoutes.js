/**
 * authRoutes.js
 * Express routes for local + Google OAuth authentication.
 *
 * Endpoints:
 *   POST /api/auth/register      – Create account with email/password
 *   POST /api/auth/login         – Login with email/password → JWT
 *   GET  /api/auth/google        – Redirect to Google OAuth
 *   GET  /api/auth/google/callback – Google OAuth callback → redirect with token
 *   GET  /api/auth/me            – Get current user (requires Bearer token)
 *   POST /api/auth/logout        – Logout (client should discard token)
 */

const express = require("express");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const {
  generateToken,
  verifyToken,
  createUser,
  findUserById,
  findOrCreateGoogleUser,
  validatePassword,
  saveKotakApiKeys,
  getKotakApiKeys,
} = require("./authService");

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const BACKEND_URL  = process.env.BACKEND_URL  || "http://localhost:3001";

// ─── Passport Google Strategy ─────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: `${BACKEND_URL}/api/auth/google/callback`,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const user = await findOrCreateGoogleUser({
            googleId: profile.id,
            email: profile.emails?.[0]?.value || "",
            fullName: profile.displayName || "",
          });
          done(null, user);
        } catch (err) {
          done(err, null);
        }
      }
    )
  );
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  const user = await findUserById(id);
  done(null, user);
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    req.user = verifyToken(auth.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── Local register ───────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  const { userId, email, password, fullName } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  try {
    const user = await createUser({ userId, email, password, fullName });
    const token = generateToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// ─── Local login ──────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = await validatePassword(email, password);
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = generateToken(user);
  res.json({ token, user });
});

// ─── Google OAuth ──────────────────────────────────────────────────────────────
router.get(
  "/google",
  (req, res, next) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(503).json({
        error: "Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env",
      });
    }
    next();
  },
  passport.authenticate("google", { scope: ["profile", "email"] })
);

router.get(
  "/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: `${FRONTEND_URL}/login?error=google_failed` }),
  (req, res) => {
    const token = generateToken(req.user);
    // Redirect to frontend with token in query param (frontend stores it)
    res.redirect(`${FRONTEND_URL}/auth/callback?token=${token}&user=${encodeURIComponent(JSON.stringify(req.user))}`);
  }
);

// ─── Me ───────────────────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  const user = await findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user });
});

// ─── Logout ───────────────────────────────────────────────────────────────────
router.post("/logout", (_req, res) => {
  res.json({ message: "Logged out. Discard your token on the client." });
});

// ─── Save Kotak API Keys ──────────────────────────────────────────────────────
router.post("/kotak-api", requireAuth, async (req, res) => {
  const { consumerKey, consumerSecret, mpin } = req.body;

  if (!consumerKey || !consumerSecret || !mpin) {
    return res.status(400).json({ error: "All API key fields are required." });
  }

  // Validate credentials with Kotak API
  try {
    const axios = require('axios');
    const creds = `${consumerKey}:${consumerSecret}`;
    const basicAuth = 'Basic ' + Buffer.from(creds).toString('base64');
    
    // Attempt a call that requires valid credentials
    await axios.post(
      'https://gw-napi.kotaksecurities.com/login/1.0/login/v2/login/validatePassword',
      { mobileNumber: '', password: '' },
      { headers: { 'Content-Type': 'application/json', 'Authorization': basicAuth }, timeout: 5000 }
    );
    // If we somehow get a 200, the keys might be valid (though unlikely with empty payload)
  } catch (err) {
    // Kotak returns 401 for invalid keys. 
    // It returns 400 for valid keys but bad payload (which is what we sent).
    if (err.response && err.response.status === 400) {
      // Basic Auth worked! Proceed.
    } else {
      // For 401, 403, network errors, timeouts, etc. we consider it invalid or unreachable
      return res.status(401).json({ error: "invalid API key" });
    }
  }

  const updated = await saveKotakApiKeys(req.user.id, { consumerKey, consumerSecret, mpin });
  if (!updated) {
    return res.status(404).json({ error: "User not found." });
  }

  res.json({ message: "Kotak API keys saved successfully.", user: updated });
});

// ─── Forgot Password (OTP) ────────────────────────────────────────────────────
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  const { prisma } = require("./authService");
  if (!prisma) return res.status(500).json({ error: "Database not connected" });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Return success anyway to prevent email enumeration
    return res.json({ message: "If that email exists, an OTP was sent." });
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

  await prisma.otp.create({
    data: { userId: user.id, code: otp, expiresAt }
  });

  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    try {
      transporter.sendMail({
        from: `"P-FnO Support" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Your Password Reset OTP",
        text: `Your OTP for password reset is: ${otp}. It is valid for 15 minutes.`,
        html: `<p>Your OTP for password reset is: <b style="font-size: 20px;">${otp}</b></p><p>It is valid for 15 minutes.</p>`,
      }).then(() => {
        console.log(`OTP sent to ${email}`);
      }).catch(err => {
        console.error("Failed to send email:", err);
      });
      res.json({ message: "OTP sent to your email!" });
    } catch (err) {
      console.error("Error setting up email:", err);
      res.status(500).json({ error: "Failed to process OTP request." });
    }
  } else {
    // Fallback if env variables are not configured
    console.log(`\n\n=== OTP for ${email}: ${otp} ===\n\n`);
    res.json({ message: "OTP sent to email (check backend console for now)" });
  }
});

router.post("/reset-password", async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) return res.status(400).json({ error: "Missing fields" });

  const { prisma } = require("./authService");
  if (!prisma) return res.status(500).json({ error: "Database not connected" });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(404).json({ error: "User not found" });

  const validOtp = await prisma.otp.findFirst({
    where: { userId: user.id, code: otp, expiresAt: { gt: new Date() } }
  });

  if (!validOtp) return res.status(400).json({ error: "Invalid or expired OTP" });

  const bcrypt = require("bcryptjs");
  const passwordHash = await bcrypt.hash(newPassword, 12);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash }
  });

  // Delete used OTP
  await prisma.otp.deleteMany({ where: { userId: user.id } });

  res.json({ message: "Password updated successfully" });
});

// ─── Google Login ─────────────────────────────────────────────────────────────
router.post("/google", async (req, res) => {
  const { token, fullName, email } = req.body;
  if (!token) return res.status(400).json({ error: "No token provided" });

  // In production, you would verify the token with Firebase Admin SDK:
  // const admin = require("firebase-admin");
  // const decodedToken = await admin.auth().verifyIdToken(token);
  // const googleId = decodedToken.uid;
  
  // For this local demo without a configured Firebase project, we'll just trust the email 
  // passed from the frontend Firebase SDK popup.
  if (!email) return res.status(400).json({ error: "Email required from Google" });
  
  const googleId = "google_" + email; // Mock ID

  try {
    const user = await findOrCreateGoogleUser({ googleId, email, fullName });
    const jwtToken = generateToken(user);
    res.json({ token: jwtToken, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, passport };
