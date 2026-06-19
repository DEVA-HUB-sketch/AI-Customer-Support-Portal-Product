// backend/routes/agentRoutes.js
// Features: Real-Time Agent Availability (3), Internal Agent Chat (9), Collaborative Support (8)
const express  = require("express");
const router   = express.Router();
const { db }   = require("../config/firebase");
const { verifyToken, requireRole } = require("../middleware/auth");

router.use(verifyToken);

// ═══════════════════════════════════════
// AGENT AVAILABILITY (Feature 3)
// ═══════════════════════════════════════

// GET /api/agents/availability — all agents + their status (public within auth)
router.get("/availability", async (req, res) => {
  try {
    const agentSnap = await db.collection("users").where("role", "==", "agent").get();
    const availSnap = await db.collection("agent_availability").get();

    const availMap = {};
    availSnap.forEach(doc => {
      const d = doc.data();
      availMap[d.email] = { ...d, docId: doc.id };
    });

    const agents = [];
    agentSnap.forEach(doc => {
      const a     = doc.data();
      const avail = availMap[a.email] || {};
      // Mark as offline if last heartbeat > 5 minutes ago
      let status  = avail.status || "offline";
      if (avail.lastHeartbeat) {
        const mins = (Date.now() - new Date(avail.lastHeartbeat).getTime()) / 60000;
        if (mins > 5 && status !== "offline") status = "offline";
      }
      agents.push({
        email:        a.email,
        name:         a.name,
        status,
        department:   a.department   || "General Support",
        skills:       a.skills       || [],
        currentLoad:  avail.currentLoad  || 0,
        lastActive:   avail.lastHeartbeat || null
      });
    });

    res.json({ agents });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/agents/availability — agent updates their own status
router.put("/availability", async (req, res) => {
  try {
    const { status } = req.body;
    const email      = req.user.email;
    const validStatuses = ["online", "busy", "in_meeting", "offline"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status. Use: online, busy, in_meeting, offline" });
    }

    const snap = await db.collection("agent_availability").where("email", "==", email).get();
    const now  = new Date().toISOString();

    if (snap.empty) {
      await db.collection("agent_availability").add({
        email, status, lastHeartbeat: now, updatedAt: now
      });
    } else {
      await db.collection("agent_availability").doc(snap.docs[0].id).update({
        status, lastHeartbeat: now, updatedAt: now
      });
    }

    res.json({ status, updatedAt: now });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/agents/heartbeat — keeps agent marked as online
router.post("/heartbeat", async (req, res) => {
  try {
    const email = req.user.email;
    const now   = new Date().toISOString();
    const snap  = await db.collection("agent_availability").where("email", "==", email).get();

    if (snap.empty) {
      await db.collection("agent_availability").add({ email, status: "online", lastHeartbeat: now, updatedAt: now });
    } else {
      const doc    = snap.docs[0];
      const current = doc.data().status;
      // Don't change status if they set themselves to busy/in_meeting manually
      await db.collection("agent_availability").doc(doc.id).update({
        lastHeartbeat: now,
        status: current === "offline" ? "online" : current
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════
// INTERNAL AGENT CHAT (Feature 9)
// ═══════════════════════════════════════

// GET /api/agents/chat/direct?with=email — get DM history
router.get("/chat/direct", requireRole("agent", "admin"), async (req, res) => {
  try {
    const me   = req.user.email;
    const other = (req.query.with || "").toLowerCase();
    if (!other) return res.status(400).json({ message: "with parameter required" });

    // DM thread ID = sorted emails joined
    const threadId = [me, other].sort().join("__");
    const snap = await db.collection("agent_messages")
      .where("threadId", "==", threadId)
      .get();

    const messages = [];
    snap.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    res.json({ messages, threadId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/agents/chat/direct — send a DM
router.post("/chat/direct", requireRole("agent", "admin"), async (req, res) => {
  try {
    const { toEmail, text, fileUrl, fileName } = req.body;
    const from = req.user.email;
    if (!toEmail || !text) return res.status(400).json({ message: "toEmail and text required" });

    // Verify recipient is an agent/admin
    const recipientSnap = await db.collection("users").where("email", "==", toEmail.toLowerCase()).get();
    if (recipientSnap.empty) return res.status(404).json({ message: "Recipient not found" });
    const recipientRole = recipientSnap.docs[0].data().role;
    if (!["agent", "admin"].includes(recipientRole)) {
      return res.status(403).json({ message: "Can only DM agents or admins" });
    }

    const threadId = [from, toEmail.toLowerCase()].sort().join("__");
    const msg = {
      threadId,
      from,
      to:       toEmail.toLowerCase(),
      text,
      fileUrl:  fileUrl  || null,
      fileName: fileName || null,
      read:     false,
      timestamp: new Date().toISOString()
    };

    const ref = await db.collection("agent_messages").add(msg);
    res.status(201).json({ id: ref.id, ...msg });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/agents/chat/channels — list all team channels
router.get("/chat/channels", requireRole("agent", "admin"), async (req, res) => {
  try {
    const snap = await db.collection("agent_channels").get();
    const channels = [];
    snap.forEach(doc => channels.push({ id: doc.id, ...doc.data() }));
    if (!channels.length) {
      // Seed default channels
      const defaults = [
        { name: "general",     description: "General team discussion", createdAt: new Date().toISOString() },
        { name: "support-ops", description: "Support operations and processes", createdAt: new Date().toISOString() },
        { name: "escalations", description: "Escalated ticket coordination", createdAt: new Date().toISOString() }
      ];
      const created = await Promise.all(defaults.map(c => db.collection("agent_channels").add(c)));
      defaults.forEach((c, i) => channels.push({ id: created[i].id, ...c }));
    }
    res.json({ channels });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/agents/chat/channel/:channelId — get channel messages
router.get("/chat/channel/:channelId", requireRole("agent", "admin"), async (req, res) => {
  try {
    const snap = await db.collection("agent_channel_messages")
      .where("channelId", "==", req.params.channelId)
      .get();
    const messages = [];
    snap.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/agents/chat/channel/:channelId — post to channel
router.post("/chat/channel/:channelId", requireRole("agent", "admin"), async (req, res) => {
  try {
    const { text, fileUrl, fileName, mentions = [] } = req.body;
    if (!text) return res.status(400).json({ message: "text is required" });

    const msg = {
      channelId: req.params.channelId,
      from:     req.user.email,
      fromName: req.user.name || req.user.email,
      text,
      fileUrl:  fileUrl  || null,
      fileName: fileName || null,
      mentions,
      timestamp: new Date().toISOString()
    };
    const ref = await db.collection("agent_channel_messages").add(msg);
    res.status(201).json({ id: ref.id, ...msg });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/agents/chat/unread — unread DM count for current user
router.get("/chat/unread", requireRole("agent", "admin"), async (req, res) => {
  try {
    const snap = await db.collection("agent_messages")
      .where("to",   "==", req.user.email)
      .where("read", "==", false)
      .get();
    res.json({ unread: snap.size || 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/agents/chat/mark-read — mark DMs as read
router.put("/chat/mark-read", requireRole("agent", "admin"), async (req, res) => {
  try {
    const { threadId } = req.body;
    const snap = await db.collection("agent_messages")
      .where("threadId", "==", threadId)
      .where("to",       "==", req.user.email)
      .where("read",     "==", false)
      .get();
    const updates = [];
    snap.forEach(doc => updates.push(db.collection("agent_messages").doc(doc.id).update({ read: true })));
    await Promise.allSettled(updates);
    res.json({ marked: updates.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════
// TICKET COLLABORATION — INTERNAL NOTES (Feature 8)
// ═══════════════════════════════════════

// GET /api/agents/tickets/:ticketId/notes — internal notes (agents/admins only)
router.get("/tickets/:ticketId/notes", requireRole("agent", "admin"), async (req, res) => {
  try {
    const snap = await db.collection("internal_notes")
      .where("ticketId", "==", req.params.ticketId)
      .get();
    const notes = [];
    snap.forEach(doc => notes.push({ id: doc.id, ...doc.data() }));
    notes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/agents/tickets/:ticketId/notes — add internal note
router.post("/tickets/:ticketId/notes", requireRole("agent", "admin"), async (req, res) => {
  try {
    const { text, mentions = [] } = req.body;
    if (!text) return res.status(400).json({ message: "text is required" });

    const ticketRef = db.collection("tickets").doc(req.params.ticketId);
    const ticketDoc = await ticketRef.get();
    if (!ticketDoc.exists) return res.status(404).json({ message: "Ticket not found" });

    const note = {
      ticketId:  req.params.ticketId,
      author:    req.user.email,
      authorName: req.user.name || req.user.email,
      text,
      mentions,
      isInternal: true,
      timestamp: new Date().toISOString()
    };

    const ref = await db.collection("internal_notes").add(note);

    // Add to ticket timeline
    const tData = ticketDoc.data();
    const tlEntry = {
      type: "internal_note", actor: req.user.email,
      icon: "ti-lock", color: "var(--warning)",
      note: `Internal note added by ${req.user.email}`,
      timestamp: new Date().toISOString()
    };
    await ticketRef.update({
      timeline: [...(tData.timeline || []), tlEntry],
      updatedAt: new Date().toISOString()
    });

    res.status(201).json({ id: ref.id, ...note });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/agents/tickets/:ticketId/collaborators — add collaborator to ticket
router.post("/tickets/:ticketId/collaborators", requireRole("agent", "admin"), async (req, res) => {
  try {
    const { agentEmail } = req.body;
    if (!agentEmail) return res.status(400).json({ message: "agentEmail required" });

    const ref  = db.collection("tickets").doc(req.params.ticketId);
    const doc  = await ref.get();
    if (!doc.exists) return res.status(404).json({ message: "Ticket not found" });

    const data = doc.data();
    const collaborators = data.collaborators || [];
    if (!collaborators.includes(agentEmail.toLowerCase())) {
      collaborators.push(agentEmail.toLowerCase());
    }
    await ref.update({ collaborators, updatedAt: new Date().toISOString() });
    res.json({ collaborators });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════
// FILE ATTACHMENT SCANNER (Feature 19)
// ═══════════════════════════════════════
const ALLOWED_EXTENSIONS = [".pdf",".png",".jpg",".jpeg",".gif",".txt",".doc",".docx",".xlsx",".csv",".mp4",".mp3"];
const BLOCKED_EXTENSIONS  = [".exe",".bat",".sh",".js",".php",".py",".rb",".ps1",".cmd",".msi",".dll",".vbs",".jar"];
const MAX_FILE_SIZE_MB    = 10;

router.post("/scan-file", async (req, res) => {
  try {
    const { fileName, fileSizeMB, mimeType } = req.body;
    if (!fileName) return res.status(400).json({ message: "fileName required" });

    const ext    = (fileName.match(/\.[^.]+$/) || [""])[0].toLowerCase();
    const issues = [];
    let safe     = true;

    if (BLOCKED_EXTENSIONS.includes(ext)) {
      issues.push(`Blocked file type: ${ext}`); safe = false;
    }
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      issues.push(`Unrecognized extension: ${ext}`); safe = false;
    }
    if (fileSizeMB && fileSizeMB > MAX_FILE_SIZE_MB) {
      issues.push(`File too large: ${fileSizeMB}MB (max ${MAX_FILE_SIZE_MB}MB)`); safe = false;
    }
    // Basic MIME type check
    if (mimeType) {
      const dangerousMimes = ["application/x-msdownload","application/x-executable","text/x-script.python","application/x-sh"];
      if (dangerousMimes.includes(mimeType)) {
        issues.push(`Dangerous MIME type: ${mimeType}`); safe = false;
      }
    }

    if (!safe) {
      await db.collection("file_scan_logs").add({
        fileName, fileSizeMB, mimeType, ext,
        scannedBy: req.user.email,
        safe: false, issues,
        timestamp: new Date().toISOString()
      });
    }

    res.json({ safe, issues, fileName, allowedExtensions: ALLOWED_EXTENSIONS });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// AGENT NOTIFICATIONS (agent_notifications collection)
// ═══════════════════════════════════════════════════════════

// GET /api/agents/my-notifications — all notifications for logged-in agent
router.get("/my-notifications", async (req, res) => {
  try {
    const email = req.user.email.toLowerCase();
    const snap  = await db.collection("agent_notifications")
      .where("recipientEmail", "==", email)
      .get();

    const notifications = [];
    snap.forEach(doc => notifications.push({ id: doc.id, ...doc.data() }));
    notifications.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    const unread = notifications.filter(n => !n.read).length;
    if (unread > 0) console.log(`[AgentNotification] ${unread} unread for ${email}`);
    res.json({ notifications: notifications.slice(0, 50), unread });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/agents/my-notifications/mark-all-read — mark all as read
router.put("/my-notifications/mark-all-read", async (req, res) => {
  try {
    const email = req.user.email.toLowerCase();
    const snap  = await db.collection("agent_notifications")
      .where("recipientEmail", "==", email)
      .where("read", "==", false)
      .get();

    const updates = [];
    snap.forEach(doc => {
      updates.push(
        db.collection("agent_notifications").doc(doc.id).update({ read: true, readAt: new Date().toISOString() })
      );
    });
    await Promise.allSettled(updates);
    console.log(`[AgentNotification] Marked ${updates.length} notifications read for ${email}`);
    res.json({ marked: updates.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/agents/my-notifications/:id/read — mark single notification as read
router.put("/my-notifications/:id/read", async (req, res) => {
  try {
    await db.collection("agent_notifications").doc(req.params.id).update({
      read:   true,
      readAt: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
