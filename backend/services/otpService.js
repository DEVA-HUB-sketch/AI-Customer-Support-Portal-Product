// backend/services/otpService.js — Feature 18
const { db } = require("../config/firebase");

const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function generateOTP(email, action) {
  const code    = generateCode();
  const emailLower = email.toLowerCase();
  const expiresAt  = new Date(Date.now() + OTP_EXPIRY_MS).toISOString();

  // Invalidate any existing OTP for this email+action
  const existing = await db.collection("otp_codes")
    .where("email", "==", emailLower)
    .where("action", "==", action)
    .where("used", "==", false)
    .get();
  const invalidations = [];
  existing.forEach(doc => invalidations.push(db.collection("otp_codes").doc(doc.id).update({ used: true })));
  await Promise.allSettled(invalidations);

  await db.collection("otp_codes").add({
    email:    emailLower,
    action,
    code,
    used:     false,
    expiresAt,
    createdAt: new Date().toISOString()
  });

  return { code, expiresAt };
}

async function verifyOTP(email, action, code) {
  const emailLower = email.toLowerCase();
  const now = new Date().toISOString();

  const snap = await db.collection("otp_codes")
    .where("email",  "==", emailLower)
    .where("action", "==", action)
    .where("code",   "==", String(code))
    .where("used",   "==", false)
    .get();

  if (snap.empty) return { valid: false, reason: "Invalid or already used OTP" };

  const doc  = snap.docs[0];
  const data = doc.data();

  if (data.expiresAt < now) {
    await db.collection("otp_codes").doc(doc.id).update({ used: true });
    return { valid: false, reason: "OTP has expired. Please request a new one." };
  }

  await db.collection("otp_codes").doc(doc.id).update({ used: true, usedAt: now });
  return { valid: true };
}

module.exports = { generateOTP, verifyOTP };
