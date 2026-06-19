// backend/routes/activityRoutes.js
const express = require("express");
const router  = express.Router();
const { db }  = require("../config/firebase");
const { verifyToken, requireRole } = require("../middleware/auth");

// All activity routes — admin only
router.use(verifyToken, requireRole("admin"));

// GET /api/activity
// Query params: email, role, action, from (ISO date), to (ISO date), limit
router.get("/", async (req, res) => {
  try {
    const { email, role, action, from, to, limit = 200 } = req.query;

    const snapshot = await db.collection("activity_logs").get();
    let logs = [];
    snapshot.forEach(doc => logs.push({ id: doc.id, ...doc.data() }));

    // Apply filters in memory (mock DB has no compound query support)
    if (email)  logs = logs.filter(l => l.email  && l.email.includes(email.toLowerCase()));
    if (role)   logs = logs.filter(l => l.role   === role);
    if (action) logs = logs.filter(l => l.action === action);
    if (from)   logs = logs.filter(l => l.timestamp >= from);
    if (to)     logs = logs.filter(l => l.timestamp <= to);

    // Sort newest first
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    logs = logs.slice(0, parseInt(limit));

    res.json({ logs, total: logs.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/activity/actions — list of distinct action types in the logs
router.get("/actions", async (req, res) => {
  try {
    const snapshot = await db.collection("activity_logs").get();
    const actions = new Set();
    snapshot.forEach(doc => {
      const a = doc.data().action;
      if (a) actions.add(a);
    });
    res.json(Array.from(actions).sort());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/activity/stats — summary counts for admin overview
router.get("/stats", async (req, res) => {
  try {
    const snapshot = await db.collection("activity_logs").get();
    const stats = {
      total:   0,
      byRole:  {},
      byAction: {},
      last24h: 0
    };
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    snapshot.forEach(doc => {
      const d = doc.data();
      stats.total++;
      stats.byRole[d.role]     = (stats.byRole[d.role]     || 0) + 1;
      stats.byAction[d.action] = (stats.byAction[d.action] || 0) + 1;
      if (d.timestamp >= cutoff) stats.last24h++;
    });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
