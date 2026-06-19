// backend/routes/ticketRoutes.js
const express = require("express");
const router  = express.Router();
const { db }  = require("../config/firebase");
const { categorizeTicket, analyzeSentiment, getSuggestedResponses } = require("../services/aiService");
const { log, ACTIONS } = require("../services/activityLogger");
const { verifyToken, requireRole } = require("../middleware/auth");
const {
  sendTicketCreated,
  sendTicketAssigned,
  sendTicketResolved
} = require("../services/emailService");
const {
  analyzeTicket,
  autoAssignAgent,
  detectFraud,
  updateReputation,
  buildTimelineEntry,
  appendTimelineEntry,
  predictSatisfaction,
  generateKBArticle
} = require("../services/ticketAI");
const { pushNotification, pushAgentNotification } = require("../services/notificationService");

// PUBLIC: GET /api/tickets/reviews — no auth required, used by landing page
router.get("/reviews", async (req, res) => {
  try {
    const snapshot = await db.collection("tickets").get();
    const reviews = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.rating && data.feedback && data.feedback.trim()) {
        const email = data.createdBy || "user@example.com";
        const parts = email.split("@");
        const name = parts[0][0].toUpperCase() + "***";
        const domain = parts[1] || "mail.com";
        reviews.push({
          rating:    data.rating,
          feedback:  data.feedback,
          user:      name + "@" + domain,
          subject:   data.subject || "Support ticket",
          createdAt: data.updatedAt || data.createdAt
        });
      }
    });
    reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ reviews: reviews.slice(0, 6) });
  } catch (error) {
    console.error("[Reviews] Error:", error.message);
    res.json({ reviews: [] });
  }
});

// All ticket routes below require a valid JWT
router.use(verifyToken);

// 1. GET /api/tickets
router.get("/", async (req, res) => {
  try {
    const { email, role } = req.query;
    const ticketsRef = db.collection("tickets");
    let snapshot;

    if (role === "customer" && email) {
      snapshot = await ticketsRef.where("createdBy", "==", email.toLowerCase()).get();
    } else {
      snapshot = await ticketsRef.get();
    }

    const tickets = [];
    snapshot.forEach(doc => tickets.push({ id: doc.id, ...doc.data() }));
    tickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 2. GET /api/tickets/:id
router.get("/:id", async (req, res) => {
  try {
    const doc = await db.collection("tickets").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 3. POST /api/tickets/create
router.post("/create", async (req, res) => {
  try {
    const { subject, description, priority, email, category: frontendCategory, lang } = req.body;
    if (!subject || !description || !email) {
      return res.status(400).json({ message: "Subject, description, and email are required" });
    }

    const emailLower = email.toLowerCase();
    const now        = new Date().toISOString();

    // ── 1. Run AI analysis + fraud check in parallel ─────────────────────
    const [aiResult, fraudResult] = await Promise.allSettled([
      analyzeTicket(subject, description, emailLower),
      detectFraud(emailLower, subject, description)
    ]);

    const ai    = aiResult.status    === "fulfilled" ? aiResult.value    : {};
    const fraud = fraudResult.status === "fulfilled" ? fraudResult.value : { isFraud: false, confidence: 0, alerts: [] };

    // Derived fields with rule-based fallbacks
    const category       = ai.category         || categorizeTicket(subject, description);
    const department     = ai.department        || "General Support";
    const sentiment      = ai.sentiment         || analyzeSentiment(description);
    const finalPriority  = priority             || ai.priority || "Low";
    const priorityReason = ai.priorityReason    || "Assigned by rule-based engine";

    // ── 2. Build Step-by-step timeline ───────────────────────────────────
    const timeline = [
      buildTimelineEntry("created",    emailLower, "Customer submitted support ticket"),
      buildTimelineEntry("ai_analyzed","system",
        `AI Analysis: ${category} — ${department} | Sentiment: ${sentiment} | Keywords: ${(ai.keywords || []).slice(0, 3).join(", ") || "none"}`),
      buildTimelineEntry("priority_set","system",
        `Priority set to ${finalPriority} — ${priorityReason}`)
    ];

    if (fraud.isFraud) {
      timeline.push(buildTimelineEntry("fraud_flagged", "system",
        `Fraud signals detected (confidence: ${fraud.confidence}%) — ${(fraud.alerts || [])[0] || ""}`));
    }

    // ── 3. Auto-assign best agent ─────────────────────────────────────────
    let assignment = null;
    try {
      assignment = await autoAssignAgent({
        category, department, priority: finalPriority,
        expertise: ai.expertise || [], requiredExpertise: ai.requiredExpertise
      });
    } catch (assignErr) {
      console.error("[AutoAssign] non-fatal:", assignErr.message);
    }

    if (assignment) {
      timeline.push(buildTimelineEntry("auto_assigned", "system",
        `Best agent selected: ${assignment.name} (score: ${assignment.assignmentScore}, load: ${assignment.currentLoad} tickets, status: ${assignment.availabilityStatus})`));
      timeline.push(buildTimelineEntry("assigned", "system",
        `Ticket assigned to ${assignment.name} via AI Auto-Assignment`));
    }

    // ── 4. Build complete Firestore ticket document ───────────────────────
    const newTicket = {
      // Core fields
      subject, description,
      lang:       lang || "en",
      createdAt:  now,
      updatedAt:  now,
      createdBy:  emailLower,
      status:     assignment ? "Assigned" : "Open",
      rating:     null,
      feedback:   null,
      escalated:  false,
      collaborators: [],

      // AI Category & Priority (Feature 2 required fields)
      category,
      department,
      priority:              finalPriority,
      priorityReason,
      priorityGeneratedAt:   ai.priorityGeneratedAt  || now,
      priorityGeneratedBy:   ai.priorityGeneratedBy  || "Rule-Based Engine",

      // AI Analysis summary
      sentiment,
      sentimentScore:        ai.sentimentScore        || 50,
      aiKeywords:            ai.keywords              || [],
      aiAnalysisSummary:     ai.aiAnalysisSummary     || `${category} — ${finalPriority} priority`,
      aiAnalyzed:            ai.aiAnalyzed            !== false,
      analysisSource:        ai.analysisSource        || "fallback",
      previousComplaints:    ai.previousComplaints    || 0,
      customerTier:          ai.customerTier          || "Standard",
      fraudFlagged:          fraud.isFraud            || false,
      fraudAlerts:           fraud.alerts             || [],

      // Assignment fields (Feature 1 required fields)
      assignedTo:            assignment ? assignment.email      : null,
      assignedAgentId:       assignment ? assignment.uid        : null,
      assignedAgentName:     assignment ? assignment.name       : null,
      assignedDepartment:    assignment ? assignment.department : null,
      assignedTimestamp:     assignment ? now                   : null,
      assignmentMethod:      assignment ? "AI Auto Assignment"  : null,
      assignmentScore:       assignment ? assignment.assignmentScore : null,
      assignmentMatchReasons: assignment ? assignment.matchReasons  : [],

      // Timeline & history
      timeline,
      history: [{
        status:    assignment ? "Assigned" : "Open",
        updatedBy: emailLower,
        timestamp: now,
        note:      `Ticket created. AI: category=${category}, priority=${finalPriority}${assignment ? `, assigned to ${assignment.name}` : ", no agent available"}.`
      }],
      messages: [{
        sender:    "customer",
        text:      description,
        timestamp: now,
        senderName: emailLower,
        lang:      lang || "en"
      }]
    };

    const docRef = await db.collection("tickets").add(newTicket);

    // ── 5. Notify assigned agent (email + Firestore dashboard notification) ──
    if (assignment) {
      // Email notification
      sendTicketAssigned({
        ticketId:      docRef.id,
        agentEmail:    assignment.email,
        customerEmail: emailLower,
        customerName:  emailLower,
        subject,
        category,
        priority: finalPriority
      }).catch(() => {});

      // ── Agent-specific Firestore notification (agent_notifications collection) ──
      pushAgentNotification({
        recipientEmail: assignment.email,
        recipientId:    assignment.uid,
        ticketId:       docRef.id,
        ticketTitle:    subject,
        title:          "New Ticket Assigned",
        message:        `You have been assigned Ticket #${docRef.id.substring(0,6).toUpperCase()} — [${finalPriority}] ${subject}`,
        type:           "ticket_assignment",
        priority:       finalPriority,
        category,
        customerEmail:  emailLower,
        createdBy:      "AI Auto Assignment"
      }).catch(err => console.error("[TicketCreate] Agent notification failed:", err.message));

      // ── Also notify admins so they see it in the admin bell ──────────────
      pushNotification({
        type:     "TICKET_ASSIGNED",
        severity: finalPriority === "Critical" ? "danger" : finalPriority === "High" ? "warn" : "info",
        title:    "Ticket Auto-Assigned",
        message:  `[${finalPriority}] "${subject}" assigned to ${assignment.name} (${category})`,
        data:     { ticketId: docRef.id, agentEmail: assignment.email, priority: finalPriority }
      }).catch(() => {});
    }

    // ── 6. Customer notification email ────────────────────────────────────
    sendTicketCreated({
      ticketId:      docRef.id,
      customerEmail: emailLower,
      subject,
      category,
      priority:      finalPriority,
      status:        newTicket.status
    }).catch(() => {});

    // ── 7. Side effects ───────────────────────────────────────────────────
    updateReputation(emailLower, "ticket_created").catch(() => {});

    log({
      userId: emailLower, email: emailLower, role: "customer",
      action: ACTIONS.TICKET_CREATED,
      details: {
        ticketId:       docRef.id, subject, category, department,
        priority:       finalPriority, priorityReason,
        autoAssigned:   assignment ? assignment.email : null,
        assignmentScore: assignment ? assignment.assignmentScore : null,
        aiAnalyzed:     ai.aiAnalyzed !== false,
        fraudFlagged:   fraud.isFraud,
        analysisSource: ai.analysisSource || "fallback"
      },
      ip: req.clientIp
    });

    res.status(201).json({
      message:  "Ticket Created Successfully",
      ticketId: docRef.id,
      aiInsights: {
        category, department, priority: finalPriority,
        priorityReason, sentiment,
        autoAssigned:   assignment ? assignment.email : null,
        assignedAgentName: assignment ? assignment.name : null,
        assignedDepartment: assignment ? assignment.department : null,
        assignmentMethod: assignment ? "AI Auto Assignment" : null,
        aiAnalysisSummary: ai.aiAnalysisSummary,
        analysisSource: ai.analysisSource || "fallback"
      },
      ticket: { id: docRef.id, ...newTicket }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 4. PUT /api/tickets/:id/status
router.put("/:id/status", async (req, res) => {
  try {
    const { status, updatedBy, note } = req.body;
    if (!status || !updatedBy) {
      return res.status(400).json({ message: "Status and updatedBy are required" });
    }

    const ticketRef = db.collection("tickets").doc(req.params.id);
    const doc = await ticketRef.get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });

    const ticketData = doc.data();
    const now        = new Date().toISOString();
    const noteText   = note || `Status changed from ${ticketData.status} to ${status}.`;
    const historyEntry = { status, updatedBy, timestamp: now, note: noteText };

    const tlType  = status === "Resolved" ? "resolved" : status === "Closed" ? "closed" : "status_changed";
    const tlEntry = buildTimelineEntry(tlType, updatedBy, noteText);

    await ticketRef.update({
      status,
      updatedAt: now,
      history:   [...(ticketData.history || []), historyEntry],
      timeline:  [...(ticketData.timeline || []), tlEntry]
    });

    let action = ACTIONS.TICKET_UPDATED;
    if (status === "Resolved") {
      action = ACTIONS.TICKET_RESOLVED;
      updateReputation(ticketData.createdBy, "ticket_resolved").catch(() => {});
      sendTicketResolved({
        ticketId:      req.params.id,
        customerEmail: ticketData.createdBy,
        agentName:     updatedBy,
        subject:       ticketData.subject
      }).catch(() => {});
    } else if (status === "Closed") {
      action = ACTIONS.TICKET_CLOSED;
    }

    log({ userId: updatedBy, email: updatedBy, role: "agent",
          action,
          details: { ticketId: req.params.id, oldStatus: ticketData.status, newStatus: status },
          ip: req.clientIp });

    res.json({ message: "Ticket Status Updated Successfully", status });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 5. PUT /api/tickets/:id/assign
router.put("/:id/assign", async (req, res) => {
  try {
    const { assignedTo, updatedBy } = req.body;
    if (!updatedBy) return res.status(400).json({ message: "updatedBy parameter is required" });

    const ticketRef = db.collection("tickets").doc(req.params.id);
    const doc = await ticketRef.get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });

    const ticketData = doc.data();
    const historyEntry = {
      status:    ticketData.status,
      updatedBy,
      timestamp: new Date().toISOString(),
      note:      assignedTo ? `Ticket assigned to agent: ${assignedTo}` : "Ticket unassigned."
    };

    await ticketRef.update({
      assignedTo: assignedTo ? assignedTo.toLowerCase() : null,
      updatedAt:  new Date().toISOString(),
      history:    [...(ticketData.history || []), historyEntry]
    });

    // Send assignment email to agent
    if (assignedTo) {
      sendTicketAssigned({
        ticketId:      req.params.id,
        agentEmail:    assignedTo,
        customerEmail: ticketData.createdBy,
        customerName:  ticketData.createdBy,
        subject:       ticketData.subject,
        category:      ticketData.category,
        priority:      ticketData.priority
      }).catch(() => {});
    }

    log({ userId: updatedBy, email: updatedBy, role: "agent",
          action: ACTIONS.TICKET_ASSIGNED,
          details: { ticketId: req.params.id, assignedTo: assignedTo || null },
          ip: req.clientIp });

    res.json({ message: "Ticket Assignment Updated Successfully", assignedTo });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 6. POST /api/tickets/:id/messages
router.post("/:id/messages", async (req, res) => {
  try {
    const { sender, text, senderName } = req.body;
    if (!sender || !text || !senderName) {
      return res.status(400).json({ message: "Sender, text, and senderName are required" });
    }

    const ticketRef = db.collection("tickets").doc(req.params.id);
    const doc = await ticketRef.get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });

    const ticketData = doc.data();
    const newMessage = { sender, text, timestamp: new Date().toISOString(), senderName };

    await ticketRef.update({
      messages:  [...(ticketData.messages || []), newMessage],
      updatedAt: new Date().toISOString()
    });

    log({ userId: senderName, email: senderName, role: sender === "agent" ? "agent" : "customer",
          action: ACTIONS.TICKET_MESSAGE,
          details: { ticketId: req.params.id, sender },
          ip: req.clientIp });

    res.json({ message: "Message Sent Successfully", chat: newMessage });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 7. POST /api/tickets/:id/feedback
router.post("/:id/feedback", async (req, res) => {
  try {
    const { rating, feedback } = req.body;
    if (rating === undefined) return res.status(400).json({ message: "Rating is required" });

    const ticketRef = db.collection("tickets").doc(req.params.id);
    const doc = await ticketRef.get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });

    const ticketData = doc.data();
    const historyEntry = {
      status:    ticketData.status,
      updatedBy: ticketData.createdBy,
      timestamp: new Date().toISOString(),
      note:      `Customer submitted feedback: Rating ${rating}/5.`
    };

    await ticketRef.update({
      rating:    parseInt(rating),
      feedback:  feedback || "",
      updatedAt: new Date().toISOString(),
      history:   [...(ticketData.history || []), historyEntry]
    });

    log({ userId: ticketData.createdBy, email: ticketData.createdBy, role: "customer",
          action: ACTIONS.TICKET_FEEDBACK,
          details: { ticketId: req.params.id, rating: parseInt(rating) },
          ip: req.clientIp });

    res.json({ message: "Feedback Submitted Successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 8. GET /api/tickets/:id/ai-suggestions
router.get("/:id/ai-suggestions", async (req, res) => {
  try {
    const doc = await db.collection("tickets").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });

    const data = doc.data();
    const suggestions = getSuggestedResponses(data.category, data.sentiment);
    const insight = data.sentiment === "Negative"
      ? "Customer is frustrated. Prioritize prompt, empathetic assistance. This ticket breaches regular response SLAs."
      : "Standard customer request. Response suggestion is context-mapped to Help Articles.";

    res.json({ category: data.category, sentiment: data.sentiment, suggestions, insight });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 9. POST /api/tickets/:id/reprioritize — re-run AI priority when content changes
router.post("/:id/reprioritize", async (req, res) => {
  try {
    const ticketRef = db.collection("tickets").doc(req.params.id);
    const doc       = await ticketRef.get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });

    const ticket = doc.data();
    const now    = new Date().toISOString();

    // Re-run full AI analysis
    const ai = await analyzeTicket(ticket.subject, ticket.description, ticket.createdBy);
    const newPriority = ai.priority || ticket.priority;
    const changed     = newPriority !== ticket.priority;

    const tlEntry = buildTimelineEntry("priority_set", req.user ? req.user.email : "system",
      `Priority ${changed ? `updated from ${ticket.priority} to ${newPriority}` : `confirmed as ${newPriority}`} — ${ai.priorityReason}`);

    await ticketRef.update({
      priority:            newPriority,
      priorityReason:      ai.priorityReason,
      priorityGeneratedAt: now,
      priorityGeneratedBy: "Gemini AI (re-run)",
      aiAnalysisSummary:   ai.aiAnalysisSummary || ticket.aiAnalysisSummary,
      aiKeywords:          ai.keywords || ticket.aiKeywords || [],
      sentiment:           ai.sentiment || ticket.sentiment,
      sentimentScore:      ai.sentimentScore || ticket.sentimentScore,
      updatedAt:           now,
      timeline:            [...(ticket.timeline || []), tlEntry],
      history:             [...(ticket.history || []), {
        status:    ticket.status,
        updatedBy: req.user ? req.user.email : "system",
        timestamp: now,
        note:      `Priority re-predicted: ${newPriority} — ${ai.priorityReason}`
      }]
    });

    res.json({
      priority:       newPriority,
      priorityReason: ai.priorityReason,
      changed,
      previousPriority: ticket.priority,
      aiAnalysisSummary: ai.aiAnalysisSummary
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 10. GET /api/tickets/:id/timeline — Feature 7
router.get("/:id/timeline", async (req, res) => {
  try {
    const doc = await db.collection("tickets").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });
    res.json({ timeline: doc.data().timeline || [] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 10. POST /api/tickets/:id/satisfaction-predict — predict rating before closure
router.post("/:id/satisfaction-predict", async (req, res) => {
  try {
    const doc = await db.collection("tickets").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });
    const result = await predictSatisfaction(doc.data());
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 11. POST /api/tickets/:id/kb-generate — generate KB article from resolved ticket
router.post("/:id/kb-generate", requireRole("agent", "admin"), async (req, res) => {
  try {
    const { resolution, publishImmediately = false } = req.body;
    if (!resolution) return res.status(400).json({ message: "resolution text required" });

    const doc = await db.collection("tickets").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });

    const ticket  = doc.data();
    const article = await generateKBArticle(ticket, resolution);

    if (publishImmediately) {
      const kbRef = await db.collection("kb").add({
        ...article,
        createdAt:  new Date().toISOString(),
        createdBy:  req.user.email,
        fromTicket: req.params.id,
        aiGenerated: true
      });
      // Add to ticket timeline
      const tlEntry = buildTimelineEntry("kb_generated", req.user.email,
        "Knowledge Base article generated from this ticket resolution");
      await db.collection("tickets").doc(req.params.id).update({
        timeline: [...(ticket.timeline || []), tlEntry],
        kbArticleId: kbRef.id,
        updatedAt: new Date().toISOString()
      });
      log({ userId: req.user.email, email: req.user.email, role: req.user.role,
            action: ACTIONS.KB_ARTICLE_ADDED,
            details: { articleId: kbRef.id, ticketId: req.params.id, aiGenerated: true },
            ip: req.clientIp });
      return res.status(201).json({ article, kbArticleId: kbRef.id, published: true });
    }

    res.json({ article, published: false });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 12. POST /api/tickets/:id/voice-transcript — attach voice transcript to ticket
router.post("/:id/voice-transcript", async (req, res) => {
  try {
    const { transcript, summary, duration } = req.body;
    if (!transcript) return res.status(400).json({ message: "transcript required" });

    const ticketRef = db.collection("tickets").doc(req.params.id);
    const doc       = await ticketRef.get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });

    const data = doc.data();
    const transcriptEntry = {
      transcript,
      summary:   summary  || "",
      duration:  duration || 0,
      addedBy:   req.user.email,
      timestamp: new Date().toISOString()
    };
    const tlEntry = buildTimelineEntry("message", req.user.email,
      `Voice transcript attached (${duration || 0}s)`);

    await ticketRef.update({
      voiceTranscripts: [...(data.voiceTranscripts || []), transcriptEntry],
      timeline: [...(data.timeline || []), tlEntry],
      updatedAt: new Date().toISOString()
    });

    res.status(201).json({ message: "Voice transcript saved", transcript: transcriptEntry });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 13. PUT /api/tickets/:id/status — enhanced with timeline + reputation update
// (overwrites route 4 above — this appears BEFORE the duplicate, so no conflict)

// 14. DELETE /api/tickets/:id — admin only
router.delete("/:id", requireRole("admin", "agent"), async (req, res) => {
  try {
    const { deletedBy } = req.query;
    const ticketRef = db.collection("tickets").doc(req.params.id);
    const doc = await ticketRef.get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });

    const ticketData = doc.data();
    await ticketRef.delete();

    log({ userId: deletedBy || "admin", email: deletedBy || "admin", role: "admin",
          action: ACTIONS.TICKET_DELETED,
          details: { ticketId: req.params.id, subject: ticketData.subject },
          ip: req.clientIp });

    res.json({ message: "Ticket Deleted Successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
