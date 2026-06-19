// backend/services/ticketAI.js
// Central AI intelligence hub for all ticket-related AI features
const { db } = require("../config/firebase");
const {
  geminiCategorize,
  geminiSentiment,
  geminiAnalyzeTicket,
  geminiTranslate,
  geminiEvaluateQuality,
  geminiPredictSatisfaction,
  geminiDetectFraud,
  geminiGenerateKB,
  geminiWeeklyReport
} = require("./geminiService");
const { pushNotification } = require("./notificationService");

// ═══════════════════════════════════════
// 1. SMART PRIORITY PREDICTION (Feature 2)
// ═══════════════════════════════════════
const CRITICAL_KEYWORDS = ["urgent", "critical", "emergency", "down", "breach", "hack", "data loss", "cannot access", "system failure", "outage"];
const HIGH_KEYWORDS      = ["broken", "failing", "error", "blocked", "asap", "immediately", "refund", "bug", "crash", "payment failed", "account locked"];
const MEDIUM_KEYWORDS    = ["issue", "problem", "not working", "slow", "unexpected", "incorrect", "wrong", "missing"];

function predictPriority(subject, description, sentimentLabel, customerRepScore) {
  const text  = `${subject} ${description}`.toLowerCase();
  const rep   = typeof customerRepScore === "number" ? customerRepScore : 50;

  if (CRITICAL_KEYWORDS.some(k => text.includes(k))) return "Critical";
  if (HIGH_KEYWORDS.some(k => text.includes(k)))     return "High";
  if (sentimentLabel === "Negative" && rep < 30)      return "High";
  if (sentimentLabel === "Negative")                  return "Medium";
  if (MEDIUM_KEYWORDS.some(k => text.includes(k)))   return "Medium";
  return "Low";
}

// ═══════════════════════════════════════
// 2. AI TICKET ANALYSIS (Feature 1 + 2)
// ═══════════════════════════════════════
async function analyzeTicket(subject, description, email) {
  const now = new Date().toISOString();
  try {
    // Fetch customer context in parallel
    const [repData, historySnap] = await Promise.allSettled([
      getReputation(email),
      db.collection("tickets").where("createdBy", "==", email.toLowerCase()).get()
    ]);

    const reputation    = repData.status === "fulfilled" ? repData.value : { score: 50, tier: "Standard" };
    const recentTickets = [];
    if (historySnap.status === "fulfilled") {
      historySnap.value.forEach(doc => {
        const d = doc.data();
        recentTickets.push({ subject: d.subject, status: d.status, category: d.category, priority: d.priority, createdAt: d.createdAt });
      });
      recentTickets.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    }

    // Run Gemini deep analysis with full customer context
    const aiResult = await geminiAnalyzeTicket(subject, description, { reputation, recentTickets });

    // Final priority — prefer Gemini result, fall back to rule-based
    const priority = aiResult.priority || predictPriority(subject, description, aiResult.sentiment, reputation.score);

    // Build priority reason
    const priorityReason = aiResult.priorityReason ||
      (priority === "Critical" ? "Critical keywords detected in ticket" :
       priority === "High"     ? "High-urgency keywords or negative sentiment detected" :
       priority === "Medium"   ? "Moderate keywords or neutral sentiment" :
                                 "Standard inquiry, low urgency");

    return {
      category:            aiResult.category          || "General Inquiry",
      department:          aiResult.department         || "General Support",
      priority,
      priorityReason,
      priorityGeneratedAt: now,
      priorityGeneratedBy: "Gemini AI",
      urgency:             aiResult.urgency            || priority,
      expertise:           aiResult.expertise          || [aiResult.category || "General Support"],
      requiredExpertise:   aiResult.requiredExpertise  || aiResult.category || "General Support",
      sentiment:           aiResult.sentiment          || "Neutral",
      sentimentScore:      aiResult.sentimentScore     || 50,
      keywords:            aiResult.keywords           || [],
      fraudRisk:           aiResult.fraudRisk          || "none",
      aiAnalysisSummary:   aiResult.summary            || `${aiResult.category || "General"} ticket — ${priority} priority`,
      previousComplaints:  recentTickets.length,
      customerTier:        reputation.tier,
      aiAnalyzed:          true,
      analyzedAt:          now,
      analysisSource:      "gemini"
    };
  } catch (err) {
    console.error("[TicketAI] analyzeTicket error:", err.message);
    const fallbackPriority = predictPriority(subject, description, "Neutral", 50);
    return {
      category: "General Inquiry", department: "General Support",
      priority: fallbackPriority,
      priorityReason: "AI unavailable — rule-based priority assigned",
      priorityGeneratedAt: now, priorityGeneratedBy: "Rule-Based Engine",
      urgency: fallbackPriority, expertise: ["General Support"],
      requiredExpertise: "General Support",
      sentiment: "Neutral", sentimentScore: 50,
      keywords: [], fraudRisk: "none",
      aiAnalysisSummary: "AI analysis unavailable — manual review recommended",
      previousComplaints: 0, customerTier: "Standard",
      aiAnalyzed: false, analyzedAt: now, analysisSource: "fallback"
    };
  }
}

// ═══════════════════════════════════════
// 3. AUTO-ASSIGN AGENT (Feature 1)
// Returns full assignment object or null
// ═══════════════════════════════════════
async function autoAssignAgent(ticket) {
  try {
    const { department, expertise, requiredExpertise, priority } = ticket;

    // Fetch agents, availability, and workload in parallel
    const [agentSnap, availSnap, openSnap, inProgSnap] = await Promise.all([
      db.collection("users").where("role", "==", "agent").get(),
      db.collection("agent_availability").get(),
      db.collection("tickets").where("status", "==", "Open").get(),
      db.collection("tickets").where("status", "==", "In Progress").get()
    ]);

    if (agentSnap.empty) return null;

    // Build lookup maps
    const agents = [];
    agentSnap.forEach(doc => agents.push({ id: doc.id, ...doc.data() }));

    const availability = {};
    availSnap.forEach(doc => {
      const d = doc.data();
      availability[d.email] = d;
    });

    const workload = {};
    [openSnap, inProgSnap].forEach(snap => {
      snap.forEach(doc => {
        const at = doc.data().assignedTo;
        if (at) workload[at] = (workload[at] || 0) + 1;
      });
    });

    // Stale heartbeat threshold (>5 min = offline)
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Score each agent
    const scored = agents.map(agent => {
      const avail  = availability[agent.email] || {};
      let   status = avail.status || "offline";

      // Treat stale heartbeat as offline
      if (avail.lastHeartbeat && avail.lastHeartbeat < staleThreshold) status = "offline";

      const load   = workload[agent.email] || 0;
      const dept   = (agent.department || "General Support").toLowerCase();
      const skills = (agent.skills || []).map(s => s.toLowerCase());
      const avgRes = agent.avgResolutionHours || 24;

      // Skip offline agents (unless Critical — then they're still eligible)
      if (status === "offline" && priority !== "Critical") return { agent, score: -1, reason: "offline" };

      let score = 100;
      let matchReasons = [];

      // ── Workload penalty (heavy hitter — max penalty 80 pts at 8 tickets) ──
      const loadPenalty = Math.min(80, load * 10);
      score -= loadPenalty;

      // ── Department match (+40) ──
      const deptMatch = department && dept.includes(department.toLowerCase());
      if (deptMatch) { score += 40; matchReasons.push("department match"); }

      // ── Required expertise / skill match (+30) ──
      const needed = [
        ...(expertise || []),
        ...(requiredExpertise ? [requiredExpertise] : [])
      ].map(e => e.toLowerCase());
      const skillMatch = needed.some(e => skills.includes(e));
      if (skillMatch) { score += 30; matchReasons.push("skill match"); }

      // ── Fast resolution bonus (up to +20) ──
      score += Math.max(0, 20 - Math.min(avgRes, 20));

      // ── Status bonus ──
      if (status === "online")      { score += 20; matchReasons.push("online"); }
      else if (status === "busy")   { score += 5; }
      else if (status === "in_meeting") { score -= 10; }
      else if (status === "offline" && priority === "Critical") { score -= 20; }

      // ── Agent reputation bonus (up to +10) ──
      score += Math.min(10, (agent.reputationScore || 70) / 10);

      return { agent, score, load, status, matchReasons };
    });

    // Sort descending, filter out negatives
    scored.sort((a, b) => b.score - a.score);
    const best = scored.find(s => s.score > 0);

    if (!best) return null;

    const { agent, score, load, status, matchReasons } = best;
    return {
      email:            agent.email,
      name:             agent.name || agent.email,
      uid:              agent.uid  || agent.id,
      department:       agent.department || "General Support",
      skills:           agent.skills || [],
      assignmentScore:  Math.round(score),
      currentLoad:      load,
      availabilityStatus: status,
      matchReasons:     matchReasons || []
    };
  } catch (err) {
    console.error("[AutoAssign] Error:", err.message);
    return null;
  }
}

// ═══════════════════════════════════════
// 4. AI FRAUD DETECTION (Feature 6)
// ═══════════════════════════════════════
const SPAM_PATTERNS    = [/\b(free money|click here|win prize|lottery|casino|crypto invest|buy now)\b/i];
const BOT_PATTERNS     = [/^(.)\1{10,}$/, /^[^a-zA-Z]*$/, /test\s*test\s*test/i];
const DUPLICATE_WINDOW = 60 * 60 * 1000; // 1 hour

async function detectFraud(email, subject, description) {
  const text    = `${subject} ${description}`;
  const alerts  = [];
  let isFraud   = false;
  let confidence = 0;

  // 1. Spam pattern check
  if (SPAM_PATTERNS.some(p => p.test(text))) {
    alerts.push("Spam keywords detected"); confidence += 40;
  }
  // 2. Bot pattern check
  if (BOT_PATTERNS.some(p => p.test(description || ""))) {
    alerts.push("Bot-like input detected"); confidence += 30;
  }
  // 3. Duplicate ticket check (same user, same subject in last hour)
  const since = new Date(Date.now() - DUPLICATE_WINDOW).toISOString();
  const dupSnap = await db.collection("tickets")
    .where("createdBy", "==", email.toLowerCase())
    .get();
  const recentDups = [];
  dupSnap.forEach(doc => {
    const d = doc.data();
    if (d.createdAt >= since && d.subject.toLowerCase() === (subject || "").toLowerCase()) {
      recentDups.push(doc.id);
    }
  });
  if (recentDups.length > 0) {
    alerts.push(`Duplicate ticket detected (${recentDups.length} similar in last hour)`);
    confidence += 35;
  }
  // 4. Excessive request check (>10 tickets in 24h)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let recentCount = 0;
  dupSnap.forEach(doc => {
    if (doc.data().createdAt >= dayAgo) recentCount++;
  });
  if (recentCount > 10) {
    alerts.push(`Excessive requests: ${recentCount} tickets in 24h`);
    confidence += 30;
  }

  // 5. AI-based fraud check for edge cases
  if (confidence < 40 && text.length > 20) {
    try {
      const aiCheck = await geminiDetectFraud(subject, description, email);
      if (aiCheck.isFraud) {
        alerts.push(aiCheck.reason);
        confidence += aiCheck.confidence || 25;
      }
    } catch { /* non-fatal */ }
  }

  isFraud = confidence >= 40;

  if (isFraud) {
    // Store fraud alert
    await db.collection("fraud_alerts").add({
      email: email.toLowerCase(),
      subject,
      alerts,
      confidence,
      status: "pending_review",
      createdAt: new Date().toISOString(),
      reviewed: false
    });

    // Notify admins
    await pushNotification({
      type: "FRAUD_DETECTED", severity: "warn",
      title: "Fraud Alert",
      message: `Potential fraud from ${email}: ${alerts[0]}`,
      data: { email, alerts, confidence }
    }).catch(() => {});
  }

  return { isFraud, confidence, alerts };
}

// ═══════════════════════════════════════
// 5. CUSTOMER REPUTATION (Feature 5)
// ═══════════════════════════════════════
const REP_EVENTS = {
  ticket_created:   2,
  ticket_resolved:  5,
  positive_rating:  10,
  negative_rating: -5,
  spam_report:     -20,
  false_complaint: -15,
  abuse_report:    -25,
  appeal_submitted:-5,
  account_age_bonus: 1
};

async function updateReputation(email, event) {
  const delta = REP_EVENTS[event] || 0;
  if (delta === 0) return;
  const emailLower = email.toLowerCase();

  try {
    const snap = await db.collection("customer_reputation").where("email", "==", emailLower).get();
    if (snap.empty) {
      await db.collection("customer_reputation").add({
        email: emailLower,
        score: Math.max(0, Math.min(100, 50 + delta)),
        events: [{ event, delta, timestamp: new Date().toISOString() }],
        tier: "Standard",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    } else {
      const doc  = snap.docs[0];
      const data = doc.data();
      const newScore = Math.max(0, Math.min(100, (data.score || 50) + delta));
      const tier = newScore >= 80 ? "Trusted" : newScore >= 50 ? "Standard" : newScore >= 20 ? "Caution" : "Restricted";
      await db.collection("customer_reputation").doc(doc.id).update({
        score: newScore,
        tier,
        events: [...(data.events || []).slice(-49), { event, delta, timestamp: new Date().toISOString() }],
        updatedAt: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error("[Reputation] Error:", err.message);
  }
}

async function getReputation(email) {
  try {
    const snap = await db.collection("customer_reputation").where("email", "==", email.toLowerCase()).get();
    if (snap.empty) return { score: 50, tier: "Standard", events: [] };
    const d = snap.docs[0].data();
    return { score: d.score || 50, tier: d.tier || "Standard", events: d.events || [] };
  } catch {
    return { score: 50, tier: "Standard", events: [] };
  }
}

// ═══════════════════════════════════════
// 6. TICKET TIMELINE (Feature 7)
// ═══════════════════════════════════════
function buildTimelineEntry(type, actor, note, metadata = {}) {
  const icons = {
    created:        { icon: "ti-ticket",           color: "var(--gold)" },
    ai_analyzed:    { icon: "ti-brain",             color: "var(--info)" },
    priority_set:   { icon: "ti-flag",              color: "var(--warning)" },
    auto_assigned:  { icon: "ti-robot",             color: "var(--info)" },
    assigned:       { icon: "ti-user-check",        color: "var(--success)" },
    accepted:       { icon: "ti-check",             color: "var(--success)" },
    message:        { icon: "ti-message",           color: "var(--text-muted)" },
    internal_note:  { icon: "ti-lock",              color: "var(--warning)" },
    status_changed: { icon: "ti-refresh",           color: "var(--info)" },
    escalated:      { icon: "ti-alert-triangle",    color: "var(--danger)" },
    resolved:       { icon: "ti-circle-check",      color: "var(--success)" },
    closed:         { icon: "ti-lock-check",        color: "var(--text-muted)" },
    feedback:       { icon: "ti-star",              color: "var(--gold)" },
    fraud_flagged:  { icon: "ti-shield-x",          color: "var(--danger)" },
    translated:     { icon: "ti-language",          color: "var(--info)" },
    kb_generated:   { icon: "ti-book",              color: "var(--success)" },
    collaborated:   { icon: "ti-users",             color: "var(--info)" }
  };
  return {
    type,
    actor,
    note,
    ...metadata,
    ...(icons[type] || { icon: "ti-point", color: "var(--text-muted)" }),
    timestamp: new Date().toISOString()
  };
}

// ═══════════════════════════════════════
// 7. AI TRANSLATION (Feature 4)
// ═══════════════════════════════════════
async function translateText(text, targetLang, sourceLang = "auto") {
  try {
    return await geminiTranslate(text, targetLang, sourceLang);
  } catch {
    return { translated: text, detectedLang: sourceLang, source: "none" };
  }
}

// ═══════════════════════════════════════
// 8. RESPONSE QUALITY SCORE (Feature 10)
// ═══════════════════════════════════════
async function scoreResponseQuality(response, context = {}) {
  try {
    return await geminiEvaluateQuality(response, context);
  } catch {
    const length = (response || "").length;
    return {
      overall: 70, professionalism: 70, grammar: 75,
      friendliness: 70, completeness: 65,
      feedback: "Could not analyze with AI. Basic check passed.",
      source: "fallback"
    };
  }
}

// ═══════════════════════════════════════
// 9. CUSTOMER SATISFACTION PREDICTION (Feature 11)
// ═══════════════════════════════════════
async function predictSatisfaction(ticket) {
  try {
    return await geminiPredictSatisfaction(ticket);
  } catch {
    const score = ticket.sentiment === "Positive" ? 4 : ticket.sentiment === "Negative" ? 2 : 3;
    return {
      predictedRating: score,
      stars: "★".repeat(score) + "☆".repeat(5 - score),
      confidence: 60,
      suggestions: score < 4 ? ["Send a follow-up message", "Offer a discount or compensation"] : [],
      source: "fallback"
    };
  }
}

// ═══════════════════════════════════════
// 10. KB ARTICLE GENERATOR (Feature 14)
// ═══════════════════════════════════════
async function generateKBArticle(ticket, resolution) {
  try {
    return await geminiGenerateKB(ticket, resolution);
  } catch {
    return {
      question: ticket.subject,
      answer: resolution,
      category: ticket.category || "General Inquiry",
      tags: [ticket.category],
      source: "fallback"
    };
  }
}

// ═══════════════════════════════════════
// 11. WEEKLY REPORT (Feature 20)
// ═══════════════════════════════════════
async function generateWeeklyReport() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const ticketSnap = await db.collection("tickets").get();
  const allTickets = [];
  ticketSnap.forEach(doc => allTickets.push({ id: doc.id, ...doc.data() }));

  const weekTickets = allTickets.filter(t => t.createdAt >= weekAgo);
  const resolved    = weekTickets.filter(t => t.status === "Resolved" || t.status === "Closed");
  const pending     = weekTickets.filter(t => t.status === "Open" || t.status === "In Progress");
  const avgRating   = resolved.filter(t => t.rating).reduce((s, t) => s + t.rating, 0) / (resolved.filter(t => t.rating).length || 1);

  // Best agents by resolution
  const agentStats = {};
  resolved.forEach(t => {
    if (t.assignedTo) {
      if (!agentStats[t.assignedTo]) agentStats[t.assignedTo] = { resolved: 0, ratings: [] };
      agentStats[t.assignedTo].resolved++;
      if (t.rating) agentStats[t.assignedTo].ratings.push(t.rating);
    }
  });
  const bestAgents = Object.entries(agentStats)
    .map(([email, s]) => ({
      email,
      resolved: s.resolved,
      avgRating: s.ratings.length ? (s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length).toFixed(1) : null
    }))
    .sort((a, b) => b.resolved - a.resolved)
    .slice(0, 5);

  // Category breakdown
  const byCategory = {};
  weekTickets.forEach(t => { byCategory[t.category] = (byCategory[t.category] || 0) + 1; });

  // AI usage
  const aiConvSnap = await db.collection("ai_conversations").get();
  let aiSessions = 0;
  aiConvSnap.forEach(doc => { if (doc.data().createdAt >= weekAgo) aiSessions++; });

  const reportData = {
    weekStart:      weekAgo,
    weekEnd:        new Date().toISOString(),
    totalCreated:   weekTickets.length,
    totalResolved:  resolved.length,
    totalPending:   pending.length,
    resolutionRate: weekTickets.length ? Math.round((resolved.length / weekTickets.length) * 100) : 0,
    avgSatisfaction: isNaN(avgRating) ? null : parseFloat(avgRating.toFixed(1)),
    bestAgents,
    categoryBreakdown: byCategory,
    aiSessionsUsed: aiSessions,
    generatedAt: new Date().toISOString()
  };

  // Get AI recommendations
  try {
    const recs = await geminiWeeklyReport(reportData);
    reportData.aiRecommendations = recs.recommendations || [];
  } catch { reportData.aiRecommendations = []; }

  return reportData;
}

// ── Append a new timeline entry to an existing ticket ──────────────────────
async function appendTimelineEntry(ticketId, entry) {
  try {
    const ref  = db.collection("tickets").doc(ticketId);
    const snap = await ref.get();
    if (!snap.exists) return;
    const existing = snap.data().timeline || [];
    await ref.update({
      timeline:  [...existing, entry],
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error("[Timeline] append error:", err.message);
  }
}

module.exports = {
  analyzeTicket,
  autoAssignAgent,
  detectFraud,
  updateReputation,
  getReputation,
  predictPriority,
  buildTimelineEntry,
  appendTimelineEntry,
  translateText,
  scoreResponseQuality,
  predictSatisfaction,
  generateKBArticle,
  generateWeeklyReport
};
