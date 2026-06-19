// backend/services/activityLogger.js
const { db } = require("../config/firebase");

// Action constants — used across all routes for consistency
const ACTIONS = {
  // Auth
  USER_SIGNUP:       "USER_SIGNUP",
  USER_LOGIN:        "USER_LOGIN",
  USER_LOGOUT:       "USER_LOGOUT",
  GOOGLE_LOGIN:      "GOOGLE_LOGIN",
  PASSWORD_RESET:    "PASSWORD_RESET",
  PROFILE_UPDATED:   "PROFILE_UPDATED",
  ROLE_CHANGED:      "ROLE_CHANGED",
  // Tickets
  TICKET_CREATED:    "TICKET_CREATED",
  TICKET_UPDATED:    "TICKET_UPDATED",
  TICKET_ASSIGNED:   "TICKET_ASSIGNED",
  TICKET_RESOLVED:   "TICKET_RESOLVED",
  TICKET_CLOSED:     "TICKET_CLOSED",
  TICKET_DELETED:    "TICKET_DELETED",
  TICKET_MESSAGE:    "TICKET_MESSAGE",
  TICKET_FEEDBACK:   "TICKET_FEEDBACK",
  // AI
  AI_CHAT_USED:      "AI_CHAT_USED",
  AI_SENTIMENT:      "AI_SENTIMENT",
  AI_CATEGORIZE:     "AI_CATEGORIZE",
  VOICE_USED:        "VOICE_USED",
  KB_SEARCHED:       "KB_SEARCHED",
  KB_ARTICLE_ADDED:  "KB_ARTICLE_ADDED",
  KB_ARTICLE_DELETED:"KB_ARTICLE_DELETED",
  // Admin
  USER_CREATED:      "USER_CREATED",
  USER_DELETED:      "USER_DELETED",
};

/**
 * Log an activity event to the activity_logs Firestore collection.
 * This is always fire-and-forget — it never throws to the caller.
 *
 * @param {object} params
 * @param {string} params.userId   - UID or doc ID of the acting user
 * @param {string} params.email    - Email of the acting user
 * @param {string} params.role     - Role: customer | agent | admin | system
 * @param {string} params.action   - One of the ACTIONS constants above
 * @param {object} params.details  - Any extra context (ticketId, subject, etc.)
 * @param {string} [params.ip]     - IP address from request
 */
async function log({ userId = "system", email = "", role = "system", action, details = {}, ip = "" }) {
  try {
    await db.collection("activity_logs").add({
      userId,
      email:     email.toLowerCase(),
      role,
      action,
      details,
      ipAddress: ip,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    // Never let logging crash the main request
    console.error("[ActivityLogger] Failed to write log:", err.message);
  }
}

/**
 * Express middleware — extracts IP and attaches a convenience logActivity() method.
 */
function activityMiddleware(req, _res, next) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  req.clientIp = ip;
  next();
}

module.exports = { log, activityMiddleware, ACTIONS };
