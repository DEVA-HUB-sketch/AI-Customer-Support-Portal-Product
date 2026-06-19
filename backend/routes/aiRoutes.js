// backend/routes/aiRoutes.js
const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/auth");
const {
  geminiChat,
  geminiSentiment,
  geminiCategorize,
  geminiSuggestResponses,
  geminiFaqSearch
} = require("../services/geminiService");

// All AI routes require a valid session
router.use(verifyToken);

// POST /api/ai/chat
// Gemini-powered chatbot with persistent history in Firestore
router.post("/chat", async (req, res) => {
  try {
    const { message, email, history = [], sessionId, lang = "en-US" } = req.body;
    if (!message) return res.status(400).json({ message: "message is required" });

    const result = await geminiChat(message, history, lang);

    // Persist conversation to Firestore
    if (email) {
      const sid = sessionId || `session_${Date.now()}`;
      const convRef = db.collection("ai_conversations").doc(sid);
      const existing = await convRef.get();
      const msgs = existing.exists ? (existing.data().messages || []) : [];
      msgs.push(
        { role: "user", text: message, timestamp: new Date().toISOString() },
        { role: "model", text: result.reply, timestamp: new Date().toISOString() }
      );
      await convRef.set({
        email: email.toLowerCase(),
        sessionId: sid,
        messages: msgs,
        updatedAt: new Date().toISOString(),
        createdAt: existing.exists ? existing.data().createdAt : new Date().toISOString()
      }, { merge: true });
      result.sessionId = sid;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/ai/sentiment
router.post("/sentiment", async (req, res) => {
  try {
    const { text, email, ticketId } = req.body;
    if (!text) return res.status(400).json({ message: "text is required" });

    const result = await geminiSentiment(text);

    // Store in Firestore if ticketId provided
    if (ticketId) {
      await db.collection("ai_sentiment").add({
        ticketId,
        email: (email || "").toLowerCase(),
        text: text.substring(0, 500),
        ...result,
        analyzedAt: new Date().toISOString()
      });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/ai/categorize
router.post("/categorize", async (req, res) => {
  try {
    const { subject, description, email } = req.body;
    if (!subject && !description) return res.status(400).json({ message: "subject or description required" });

    const result = await geminiCategorize(subject || "", description || "");

    if (email) {
      await db.collection("ai_categorizations").add({
        email: email.toLowerCase(),
        subject,
        description: (description || "").substring(0, 500),
        ...result,
        categorizedAt: new Date().toISOString()
      });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/ai/suggest
router.post("/suggest", async (req, res) => {
  try {
    const { category, sentiment, subject, description } = req.body;
    if (!category) return res.status(400).json({ message: "category is required" });

    const result = await geminiSuggestResponses({ category, sentiment: sentiment || "Neutral", subject: subject || "", description: description || "" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/ai/faq-search
router.post("/faq-search", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ message: "query is required" });

    // Fetch all KB articles from Firestore
    const snapshot = await db.collection("kb").get();
    const articles = [];
    snapshot.forEach(doc => articles.push(doc.data()));

    const result = await geminiFaqSearch(query, articles);
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/ai/history?email=...
router.get("/history", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ message: "email is required" });

    const snapshot = await db.collection("ai_conversations")
      .where("email", "==", email.toLowerCase())
      .get();

    const sessions = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      sessions.push({
        sessionId: doc.id,
        updatedAt: data.updatedAt,
        createdAt: data.createdAt,
        messageCount: (data.messages || []).length,
        preview: (data.messages || []).find(m => m.role === "user")?.text?.substring(0, 80) || ""
      });
    });

    // Sort by updatedAt desc
    sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/ai/history/:sessionId
router.get("/history/:sessionId", async (req, res) => {
  try {
    const doc = await db.collection("ai_conversations").doc(req.params.sessionId).get();
    if (!doc.exists) return res.status(404).json({ message: "Session not found" });
    res.json(doc.data());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/ai/translate — Feature 4
router.post("/translate", async (req, res) => {
  try {
    const { text, targetLang, sourceLang = "auto" } = req.body;
    if (!text || !targetLang) return res.status(400).json({ message: "text and targetLang required" });
    const { geminiTranslate } = require("../services/geminiService");
    const result = await geminiTranslate(text, targetLang, sourceLang);
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/ai/quality-score — Feature 10
router.post("/quality-score", async (req, res) => {
  try {
    const { response, context } = req.body;
    if (!response) return res.status(400).json({ message: "response required" });
    const { geminiEvaluateQuality } = require("../services/geminiService");
    const result = await geminiEvaluateQuality(response, context || {});

    // Store for admin review
    await db.collection("quality_scores").add({
      response: response.substring(0, 500),
      context,
      ...result,
      scoredBy: req.user.email,
      scoredAt: new Date().toISOString()
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/ai/weekly-report — Feature 20
router.get("/weekly-report", async (req, res) => {
  try {
    const { requireRole } = require("../middleware/auth");
    if (!["admin"].includes(req.user.role)) {
      return res.status(403).json({ message: "Admin only" });
    }
    const { generateWeeklyReport } = require("../services/ticketAI");
    const report = await generateWeeklyReport();

    // Cache report in Firestore
    await db.collection("weekly_reports").add({
      ...report,
      requestedBy: req.user.email
    });

    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/ai/weekly-reports — list past reports
router.get("/weekly-reports", async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const snap = await db.collection("weekly_reports").get();
    const reports = [];
    snap.forEach(doc => reports.push({ id: doc.id, generatedAt: doc.data().generatedAt, weekStart: doc.data().weekStart }));
    reports.sort((a, b) => (b.generatedAt || "").localeCompare(a.generatedAt || ""));
    res.json({ reports: reports.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/ai/meeting-request — Feature 13
router.post("/meeting-request", async (req, res) => {
  try {
    const { customerEmail, reason, preferredDates, ticketId } = req.body;
    if (!customerEmail || !preferredDates?.length) {
      return res.status(400).json({ message: "customerEmail and preferredDates required" });
    }
    const emailLower = customerEmail.toLowerCase();

    // Find available agents
    const availSnap = await db.collection("agent_availability")
      .where("status", "==", "online")
      .get();
    const availAgents = [];
    availSnap.forEach(doc => availAgents.push(doc.data().email));

    // Create meeting request
    const ref = await db.collection("meeting_requests").add({
      customerEmail: emailLower,
      requestedBy:   req.user.email,
      reason:        reason || "",
      ticketId:      ticketId || null,
      preferredDates,
      availAgents,
      status:        "pending",
      scheduledAt:   null,
      assignedAgent: null,
      createdAt:     new Date().toISOString()
    });

    res.status(201).json({
      id: ref.id,
      message: "Meeting request submitted. An agent will confirm shortly.",
      availAgents: availAgents.length
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/ai/meeting-request/:id/schedule — agent schedules a meeting
router.put("/meeting-request/:id/schedule", async (req, res) => {
  try {
    if (!["agent", "admin"].includes(req.user.role)) return res.status(403).json({ message: "Agent/Admin only" });
    const { scheduledAt, meetingLink } = req.body;
    if (!scheduledAt) return res.status(400).json({ message: "scheduledAt required" });

    const ref = db.collection("meeting_requests").doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ message: "Meeting request not found" });

    await ref.update({
      status:        "scheduled",
      scheduledAt,
      assignedAgent: req.user.email,
      meetingLink:   meetingLink || null,
      updatedAt:     new Date().toISOString()
    });

    res.json({ message: "Meeting scheduled successfully", scheduledAt, agent: req.user.email });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/ai/meeting-requests — list meeting requests
router.get("/meeting-requests", async (req, res) => {
  try {
    let snap;
    if (req.user.role === "customer") {
      snap = await db.collection("meeting_requests").where("customerEmail", "==", req.user.email).get();
    } else {
      snap = await db.collection("meeting_requests").get();
    }
    const requests = [];
    snap.forEach(doc => requests.push({ id: doc.id, ...doc.data() }));
    requests.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json({ requests });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/ai/analytics?email=...
router.get("/analytics", async (req, res) => {
  try {
    const { email } = req.query;

    // Gather sentiment data
    const sentSnap = await db.collection("ai_sentiment").get();
    const catSnap = await db.collection("ai_categorizations").get();
    const convSnap = await db.collection("ai_conversations").get();

    const sentimentCounts = { Positive: 0, Neutral: 0, Negative: 0 };
    sentSnap.forEach(doc => {
      const s = doc.data().sentiment;
      if (sentimentCounts[s] !== undefined) sentimentCounts[s]++;
    });

    const categoryCounts = {};
    catSnap.forEach(doc => {
      const c = doc.data().category;
      categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    });

    let totalMessages = 0;
    convSnap.forEach(doc => {
      totalMessages += (doc.data().messages || []).length;
    });

    res.json({
      totalSessions: convSnap.docs ? convSnap.docs.length : 0,
      totalMessages,
      sentimentBreakdown: sentimentCounts,
      categoryBreakdown: categoryCounts,
      totalAnalyzed: sentSnap.docs ? sentSnap.docs.length : 0
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
