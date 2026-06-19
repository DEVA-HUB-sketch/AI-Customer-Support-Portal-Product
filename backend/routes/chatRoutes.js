// backend/routes/chatRoutes.js
const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");
const { analyzeSentiment } = require("../services/aiService");
const { geminiChat } = require("../services/geminiService");
const { log, ACTIONS } = require("../services/activityLogger");

const ESCALATE_KEYWORDS = [
  "speak to agent", "talk to agent", "human agent", "real agent",
  "connect me to", "escalate", "live agent", "speak with someone",
  "human support", "agent please", "need an agent", "want a person",
  "transfer me", "get a human", "talk to a person", "speak to a person"
];

function detectCategory(message) {
  const clean = message.toLowerCase();
  if (["billing","invoice","payment","refund","charge","subscription"].some(k => clean.includes(k))) return "Billing Issue";
  if (["login","password","reset","account","locked","access"].some(k => clean.includes(k))) return "Account Issue";
  if (["bug","error","crash","broken","not working","issue","problem"].some(k => clean.includes(k))) return "Technical Issue";
  if (["feature","request","suggest","improve","add"].some(k => clean.includes(k))) return "Feature Request";
  return "General Inquiry";
}

// POST /api/chat/bot  — public, no auth required (used by landing page chatbot)
router.post("/bot", async (req, res) => {
  try {
    const { message, email, history } = req.body;
    if (!message) return res.json({ reply: "Please enter a message.", escalate: false });

    const clean = message.toLowerCase();
    const category = detectCategory(message);
    const escalate = ESCALATE_KEYWORDS.some(k => clean.includes(k));

    // Search KB first — return KB answer if no escalation triggered
    const kbSnap = await db.collection("kb").get();
    const kbArticles = [];
    kbSnap.forEach(doc => kbArticles.push(doc.data()));
    const kbMatch = kbArticles.find(a => {
      const q = (a.question || "").toLowerCase();
      return (
        clean.includes(q.substring(0, 20)) ||
        q.split(" ").some(w => w.length > 4 && clean.includes(w))
      );
    });
    if (kbMatch && !escalate) {
      log({ userId: email || "anonymous", email: email || "", role: "customer",
            action: ACTIONS.KB_SEARCHED,
            details: { query: message.substring(0, 100), matched: kbMatch.question },
            ip: req.clientIp });
      return res.json({ reply: kbMatch.answer, source: "kb", escalate: false, category });
    }

    let ticketId = null;
    let reply;

    if (escalate && email) {
      const sentiment = analyzeSentiment(message);
      const priority = sentiment === "Negative" ? "High" : "Medium";
      const newTicket = {
        subject: `Auto Escalation: ${message.substring(0, 40)}${message.length > 40 ? "..." : ""}`,
        description: `Customer requested agent support. Context: "${message}"`,
        category,
        priority,
        status: "Open",
        sentiment,
        createdAt: new Date().toISOString(),
        createdBy: email.toLowerCase(),
        assignedTo: null,
        history: [{
          status: "Open",
          updatedBy: "Zia AI Chatbot",
          timestamp: new Date().toISOString(),
          note: "Ticket created automatically via live chatbot escalation."
        }],
        messages: [
          { sender: "customer", text: message, timestamp: new Date().toISOString() }
        ]
      };
      const docRef = await db.collection("tickets").add(newTicket);
      ticketId = docRef.id;
      reply = `I've connected you with our support team! A ticket has been created (#${ticketId.substring(0, 6).toUpperCase()}). An agent will reach out to you shortly.`;
    } else {
      const result = await geminiChat(message, history || []);
      reply = result.reply;
    }

    log({ userId: email || "anonymous", email: email || "", role: "customer",
          action: ACTIONS.AI_CHAT_USED,
          details: { message: message.substring(0, 120), escalated: escalate, ticketId },
          ip: req.clientIp });

    res.json({ reply, escalate, category, ticketId });
  } catch (error) {
    console.error("[ChatRoute] Error:", error.message);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
