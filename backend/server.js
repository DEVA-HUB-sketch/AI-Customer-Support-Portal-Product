const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const dotenv     = require("dotenv");

dotenv.config();

const { db, isMock } = require("./config/firebase");

const app = express();

// ── Security headers (helmet) ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled — inline scripts in HTML pages

// ── CORS — restrict to same origin ──────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.APP_URL || "http://localhost:5000";
app.use(cors({
  origin: [ALLOWED_ORIGIN, "http://localhost:5000"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// ── Body parsing (10 KB cap) ─────────────────────────────────────────────────
app.use(express.json({ limit: "10kb" }));

// ── Static frontend ──────────────────────────────────────────────────────────
app.use(express.static(require("path").join(__dirname, "../frontend")));

// ── Activity logging middleware ──────────────────────────────────────────────
const { activityMiddleware } = require("./services/activityLogger");
app.use(activityMiddleware);

// ── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 25,
  message: { message: "Too many requests. Please wait 15 minutes before trying again." },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: { message: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false
});

// ── Route mounts ─────────────────────────────────────────────────────────────
app.use("/api/auth",     authLimiter, require("./routes/authRoutes"));
app.use("/api/tickets",  apiLimiter,  require("./routes/ticketRoutes"));
app.use("/api/chat",     apiLimiter,  require("./routes/chatRoutes"));
app.use("/api/kb",       apiLimiter,  require("./routes/kbRoutes"));
app.use("/api/ai",       apiLimiter,  require("./routes/aiRoutes"));
app.use("/api/analytics",apiLimiter,  require("./routes/analyticsRoutes"));
app.use("/api/activity", apiLimiter,  require("./routes/activityRoutes"));
app.use("/api/admin",    apiLimiter,  require("./routes/adminRoutes"));
app.use("/api/agents",   apiLimiter,  require("./routes/agentRoutes"));

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    message: "DeskFlow AI Backend Running",
    database: isMock ? "Local Mock JSON DB" : "Firebase Firestore",
    status: "Healthy"
  });
});

// ── 404 handler — always return JSON (never HTML) ───────────────────────────
app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ message: `Cannot ${req.method} ${req.path}` });
});

// ── Centralized error handler ────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[Server Error]", err.stack || err.message);
  res.status(err.status || 500).json({ message: err.message || "Internal server error." });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`DeskFlow Server running on port ${PORT}`);
  console.log(`Mode: ${isMock ? "LOCAL MOCK (No credentials)" : "FIREBASE ENGINE (Live Cert)"}`);

  // ── Escalation Engine — first run after 10 s (let Firebase finish auth)
  const { runEscalationCheck } = require("./services/escalationEngine");
  setTimeout(() => {
    runEscalationCheck().catch(() => {});
  }, 10000);
  setInterval(() => { runEscalationCheck().catch(() => {}); }, 30 * 60 * 1000);
  console.log("[EscalationEngine] Scheduled (first run in 10s, then every 30 min)");
});
