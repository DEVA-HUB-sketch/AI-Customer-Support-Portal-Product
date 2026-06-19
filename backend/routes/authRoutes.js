// backend/routes/authRoutes.js
const express = require("express");
const router  = express.Router();
const { db, auth, isMock } = require("../config/firebase");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const { log, ACTIONS } = require("../services/activityLogger");
const { sendWelcome, sendPasswordReset } = require("../services/emailService");
const { verifyToken, requireRole } = require("../middleware/auth");

const JWT_SECRET = process.env.JWT_SECRET || "deskflow_super_secret_jwt_2024";

/*
========================================
ME — returns the authenticated user's fresh role from DB
========================================
*/
router.get("/me", verifyToken, async (req, res) => {
  try {
    const snap = await db.collection("users").where("email", "==", req.user.email).get();
    if (snap.empty) return res.status(404).json({ message: "User not found." });
    let userData = null;
    snap.forEach(doc => { userData = { id: doc.id, ...doc.data() }; });
    const { password, ...safeUser } = userData;
    res.json({ user: safeUser, role: userData.role });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/*
========================================
ADMIN CREATE USER — admin only
Directly creates an account with a specified role (bypasses signup form)
========================================
*/
router.post("/admin-create-user", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "All fields are required." });
    }
    const validRoles = ["customer", "agent", "admin"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role specified." });
    }
    const emailLower = email.toLowerCase().trim();

    const existing = await db.collection("users").where("email", "==", emailLower).get();
    if (!existing.empty) {
      return res.status(400).json({ message: "An account with this email already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const baseData = {
      name, email: emailLower, role,
      password: hashedPassword,
      createdAt: new Date().toISOString(),
      createdBy: req.user.email
    };

    if (isMock) {
      const uid = "adm_" + Math.random().toString(36).substring(2, 12);
      await db.collection("users").doc(uid).set({ uid, ...baseData });
    } else {
      try {
        const userRecord = await auth.createUser({ email: emailLower, password, displayName: name });
        await db.collection("users").doc(userRecord.uid).set({ uid: userRecord.uid, ...baseData });
      } catch (_fbErr) {
        const uid = "adm_" + Date.now();
        await db.collection("users").doc(uid).set({ uid, ...baseData });
      }
    }

    log({ userId: req.user.uid, email: req.user.email, role: "admin",
          action: ACTIONS.USER_SIGNUP,
          details: { createdEmail: emailLower, createdRole: role, method: "admin_direct" },
          ip: req.clientIp });
    sendWelcome({ email: emailLower, name, role }).catch(() => {});

    res.status(201).json({ message: `Account created for ${name} (${emailLower}) as ${role}.` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/*
========================================
CHECK INVITE — public, no auth required
Returns the pending role invitation for an email (if any)
========================================
*/
router.get("/check-invite", async (req, res) => {
  try {
    const email = (req.query.email || "").toLowerCase();
    if (!email) return res.json({ role: null });
    const snap = await db.collection("authorized_emails")
      .where("email", "==", email)
      .where("used", "==", false)
      .get();
    if (snap.empty) return res.json({ role: null });
    let inviteRole = null;
    snap.forEach(doc => { inviteRole = doc.data().role; });
    return res.json({ role: inviteRole });
  } catch (_) {
    return res.json({ role: null });
  }
});

/*
========================================
SIGNUP
========================================
*/
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: "Please fill all fields" });
    }

    const emailLower = email.toLowerCase();

    const userSnapshot = await db.collection("users").where("email", "==", emailLower).get();
    if (!userSnapshot.empty) {
      return res.status(400).json({ message: "User already exists" });
    }

    const finalRole = role || "customer";

    // Agent and Admin accounts require prior admin authorization
    if (finalRole === "agent" || finalRole === "admin") {
      const authSnap = await db.collection("authorized_emails")
        .where("email", "==", emailLower)
        .where("role", "==", finalRole)
        .where("used", "==", false)
        .get();
      if (authSnap.empty) {
        return res.status(403).json({
          message: `This email is not authorized for the ${finalRole} role. Please contact your administrator to get access.`
        });
      }
      // Mark invitation as used
      try {
        await db.collection("authorized_emails").doc(authSnap.docs[0].id).update({ used: true, usedAt: new Date().toISOString() });
      } catch (_) {}
    }

    if (isMock) {
      await auth.createUser({ email: emailLower, password, displayName: name, role: finalRole });
    } else {
      const userRecord = await auth.createUser({ email: emailLower, password, displayName: name });
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.collection("users").doc(userRecord.uid).set({
        uid: userRecord.uid, name, email: emailLower, role: finalRole,
        password: hashedPassword, createdAt: new Date().toISOString()
      });
    }

    // Fire-and-forget: welcome email + activity log
    sendWelcome({ email: emailLower, name, role: finalRole }).catch(() => {});
    log({ userId: emailLower, email: emailLower, role: finalRole, action: ACTIONS.USER_SIGNUP,
          details: { name }, ip: req.clientIp });

    res.status(201).json({ message: "Signup Successful", user: { name, email: emailLower, role: finalRole } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/*
========================================
LOGIN
========================================
*/
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Please enter email and password" });
    }

    const emailLower = email.toLowerCase();

    const userSnapshot = await db.collection("users").where("email", "==", emailLower).get();
    if (userSnapshot.empty) {
      return res.status(404).json({ message: "User not found" });
    }

    let userData = null;
    userSnapshot.forEach(doc => { userData = doc.data(); userData.id = doc.id; });

    const isPasswordValid = await bcrypt.compare(password, userData.password);
    if (!isPasswordValid) {
      log({ userId: userData.uid || userData.id, email: emailLower, role: userData.role,
            action: ACTIONS.USER_LOGIN, details: { success: false }, ip: req.clientIp });
      return res.status(401).json({ message: "Invalid Password" });
    }

    // ── Block check — reject if account is blocked ───────────────────────
    if (userData.blocked) {
      log({ userId: userData.uid || userData.id, email: emailLower, role: userData.role,
            action: ACTIONS.USER_LOGIN, details: { success: false, reason: "account_blocked" }, ip: req.clientIp });
      return res.status(403).json({
        message: "Your account has been suspended. Please contact support or submit an appeal.",
        blocked: true,
        appealUrl: "/signin.html"
      });
    }

    const token = jwt.sign(
      { uid: userData.uid || userData.id, email: userData.email, role: userData.role },
      JWT_SECRET, { expiresIn: "24h" }
    );

    log({ userId: userData.uid || userData.id, email: emailLower, role: userData.role,
          action: ACTIONS.USER_LOGIN, details: { success: true }, ip: req.clientIp });

    res.status(200).json({
      message: "Login Successful", token, role: userData.role,
      user: { name: userData.name, email: userData.email, role: userData.role }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/*
========================================
PASSWORD RESET
========================================
*/
router.post("/reset-password", async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({ message: "Please provide email and new password" });
    }

    const emailLower = email.toLowerCase();

    const userSnapshot = await db.collection("users").where("email", "==", emailLower).get();
    if (userSnapshot.empty) {
      return res.status(404).json({ message: "User not found" });
    }

    let userId = null;
    let userRole = "customer";
    userSnapshot.forEach(doc => { userId = doc.id; userRole = doc.data().role || "customer"; });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.collection("users").doc(userId).update({ password: hashedPassword });

    // Generate a reset confirmation token for the email (informational only here)
    const resetToken = jwt.sign({ email: emailLower }, JWT_SECRET, { expiresIn: "1h" });
    sendPasswordReset({ email: emailLower, resetToken }).catch(() => {});

    log({ userId, email: emailLower, role: userRole, action: ACTIONS.PASSWORD_RESET,
          details: {}, ip: req.clientIp });

    res.json({ message: "Password Updated Successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/*
========================================
PROFILE UPDATE — requires valid session
========================================
*/
router.put("/update-profile", verifyToken, async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || !name) {
      return res.status(400).json({ message: "Please provide email and name" });
    }

    const emailLower = email.toLowerCase();
    const userSnapshot = await db.collection("users").where("email", "==", emailLower).get();
    if (userSnapshot.empty) {
      return res.status(404).json({ message: "User not found" });
    }

    let userId = null;
    let userRole = "customer";
    userSnapshot.forEach(doc => { userId = doc.id; userRole = doc.data().role || "customer"; });

    await db.collection("users").doc(userId).update({ name });

    log({ userId, email: emailLower, role: userRole, action: ACTIONS.PROFILE_UPDATED,
          details: { name }, ip: req.clientIp });

    res.status(200).json({ message: "Profile Updated Successfully", user: { name, email: emailLower } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/*
========================================
GET ALL USERS (Admin Roster) — admin only
========================================
*/
router.get("/users", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const userSnapshot = await db.collection("users").get();
    const users = [];
    userSnapshot.forEach(doc => {
      const { password, ...safeUser } = doc.data();
      users.push({ id: doc.id, ...safeUser });
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/*
========================================
UPDATE USER ROLE (RBAC Auth Control) — admin only
========================================
*/
router.put("/users/role", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const { email, role, adminEmail } = req.body;
    if (!email || !role) {
      return res.status(400).json({ message: "Please provide email and role" });
    }

    const userSnapshot = await db.collection("users").where("email", "==", email.toLowerCase()).get();
    if (userSnapshot.empty) {
      return res.status(404).json({ message: "User not found" });
    }

    let userId = null;
    let oldRole = null;
    userSnapshot.forEach(doc => { userId = doc.id; oldRole = doc.data().role; });

    await db.collection("users").doc(userId).update({ role });

    log({ userId: adminEmail || "admin", email: adminEmail || "admin", role: "admin",
          action: ACTIONS.ROLE_CHANGED,
          details: { targetEmail: email.toLowerCase(), oldRole, newRole: role },
          ip: req.clientIp });

    res.json({ message: `User role updated to ${role} successfully` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/*
========================================
GOOGLE AUTHENTICATION
========================================
*/
router.post("/google", async (req, res) => {
  try {
    const { idToken, uid, name, email, photoURL } = req.body;
    if (!email || !uid) {
      return res.status(400).json({ message: "Invalid Google authentication data." });
    }

    const emailLower = email.toLowerCase();

    if (!isMock) {
      try {
        const { auth: adminAuth } = require("../config/firebase");
        const decoded = await adminAuth.verifyIdToken(idToken);
        if (decoded.email.toLowerCase() !== emailLower) {
          return res.status(401).json({ message: "Token email mismatch. Authentication rejected." });
        }
      } catch (verifyErr) {
        console.error("[Google Auth] Token verification failed:", verifyErr.message);
        return res.status(401).json({ message: "Invalid or expired Google token. Please sign in again." });
      }
    }

    const userSnapshot = await db.collection("users").where("email", "==", emailLower).get();
    let userData, userId;
    let isNewUser = false;

    if (!userSnapshot.empty) {
      userSnapshot.forEach(doc => { userData = doc.data(); userId = doc.id; });
      // Block check for Google login too
      if (userData.blocked) {
        return res.status(403).json({
          message: "Your account has been suspended. Please contact support or submit an appeal.",
          blocked: true
        });
      }
      if (photoURL && !userData.photoURL) {
        await db.collection("users").doc(userId).update({ photoURL });
      }
    } else {
      isNewUser = true;
      const newUser = {
        uid, name: name || emailLower.split("@")[0], email: emailLower,
        role: "customer", provider: "google", photoURL: photoURL || "",
        createdAt: new Date().toISOString()
      };
      await db.collection("users").doc(uid).set(newUser);
      userData = newUser;
      userId   = uid;

      // Welcome email for new Google users
      sendWelcome({ email: emailLower, name: newUser.name, role: "customer" }).catch(() => {});
    }

    const token = jwt.sign(
      { uid: userData.uid || userId, email: userData.email, role: userData.role },
      JWT_SECRET, { expiresIn: "24h" }
    );

    log({ userId: userData.uid || userId, email: emailLower, role: userData.role,
          action: ACTIONS.GOOGLE_LOGIN,
          details: { isNewUser, provider: "google" }, ip: req.clientIp });

    return res.status(200).json({
      message: "Google Login Successful", token, role: userData.role,
      user: {
        name: userData.name, email: userData.email, role: userData.role,
        provider: userData.provider || "google", photoURL: userData.photoURL || ""
      }
    });
  } catch (error) {
    console.error("[Google Auth] Error:", error.message);
    return res.status(500).json({ message: "Server error during Google authentication." });
  }
});

module.exports = router;
