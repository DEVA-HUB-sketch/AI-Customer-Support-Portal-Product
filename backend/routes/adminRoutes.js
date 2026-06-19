// backend/routes/adminRoutes.js
// DeskFlow AI — Extended Admin API (Features 1-14)
const express = require("express");
const router  = express.Router();
const { db }  = require("../config/firebase");
const { verifyToken, requireRole } = require("../middleware/auth");
const { log }  = require("../services/activityLogger");

// ─── Shared helper: create admin notification ───────────────────────
async function pushNotification({ type, title, message, data = {}, severity = "info" }) {
  try {
    await db.collection("admin_notifications").add({
      type, title, message, data, severity,
      read: false,
      createdAt: new Date().toISOString()
    });
  } catch (e) { console.error("[Notification]", e.message); }
}

// ─── Shared helper: generate block report object ────────────────────
function buildBlockReport(req, approvers) {
  return {
    title: "Account Block Notice",
    accountName: req.targetName,
    email:       req.targetEmail,
    role:        req.targetRole,
    date:        new Date().toISOString(),
    status:      "Blocked",
    reason:      req.reason,
    policyViolated: req.policyViolated || "Terms of Service",
    approvedBy:  approvers.map(v => ({ name: v.adminName, email: v.adminEmail, at: v.timestamp })),
    totalApprovals: approvers.length,
    generatedAt: new Date().toISOString()
  };
}

// ═══════════════════════════════════════════════════════════
// PUBLIC APPEAL SUBMISSION (no admin role required — blocked
// users submit appeals before they can log in normally)
// ═══════════════════════════════════════════════════════════
router.post("/appeals/submit", verifyToken, async (req, res) => {
  try {
    const { reason, additionalDetails } = req.body;
    const userEmail = req.user.email;

    const userSnap = await db.collection("users").where("email", "==", userEmail).get();
    if (userSnap.empty) return res.status(404).json({ message: "User not found" });

    const userData = userSnap.docs[0].data();
    if (!userData.blocked) return res.status(400).json({ message: "Your account is not blocked" });

    const existing = await db.collection("appeals")
      .where("userEmail", "==", userEmail)
      .where("status", "==", "pending")
      .get();
    if (!existing.empty) return res.status(400).json({ message: "You already have a pending appeal" });

    const docRef = await db.collection("appeals").add({
      userEmail,
      userName:  userData.name || userEmail,
      userRole:  userData.role || "customer",
      reason,
      additionalDetails: additionalDetails || "",
      status:    "pending",
      reviewedBy: null, reviewedByName: null,
      reviewDecision: null, reviewNote: null,
      createdAt:  new Date().toISOString(),
      reviewedAt: null,
      blockRequestId: userData.blockRequestId || null
    });

    log({ userId: userEmail, email: userEmail, role: userData.role,
          action: "APPEAL_SUBMITTED", details: { appealId: docRef.id } });

    await pushNotification({
      type: "APPEAL_SUBMITTED", severity: "info",
      title: "Appeal Submitted",
      message: `${userData.name || userEmail} submitted an appeal for their blocked account.`,
      data: { appealId: docRef.id, userEmail }
    });

    res.status(201).json({ message: "Appeal submitted. Our team will review it shortly.", id: docRef.id });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ─── All remaining routes require admin role ─────────────────────────
router.use(verifyToken, requireRole("admin"));

// ═══════════════════════════════════════════════════════════
// 1. BLOCK REQUESTS
// ═══════════════════════════════════════════════════════════

// POST /api/admin/blocks — create a block request (Admin #1 vote)
router.post("/blocks", async (req, res) => {
  try {
    const { targetEmail, targetName, targetRole, reason, policyViolated } = req.body;
    const admin = req.user;
    if (!targetEmail || !reason) return res.status(400).json({ message: "Target email and reason are required" });

    const existSnap = await db.collection("block_requests")
      .where("targetEmail", "==", targetEmail)
      .where("status", "==", "pending")
      .get();
    if (!existSnap.empty) return res.status(400).json({ message: "A pending block request already exists for this user" });

    const doc = {
      targetEmail,
      targetName:     targetName || targetEmail,
      targetRole:     targetRole || "customer",
      reason,
      policyViolated: policyViolated || "Terms of Service",
      initiatedBy:    admin.email,
      initiatedByName:admin.name || admin.email,
      votes: [{
        adminEmail: admin.email,
        adminName:  admin.name || admin.email,
        adminId:    admin.uid  || admin.email,
        vote: "approve",
        timestamp:  new Date().toISOString()
      }],
      approvalCount:     1,
      requiredApprovals: 3,
      status:   "pending",
      report:   null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null
    };

    const ref = await db.collection("block_requests").add(doc);

    log({ userId: admin.email, email: admin.email, role: "admin",
          action: "BLOCK_REQUEST_CREATED",
          details: { requestId: ref.id, targetEmail, reason } });

    await pushNotification({
      type: "BLOCK_REQUEST_CREATED", severity: "warning",
      title: "New Block Request",
      message: `${admin.name || admin.email} requested to block ${targetName || targetEmail}. 2 more approvals needed.`,
      data: { requestId: ref.id, targetEmail }
    });

    res.status(201).json({
      message: "Block request created (1/3 approvals). Two more admins must approve.",
      id: ref.id
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET /api/admin/blocks — all block requests
router.get("/blocks", async (req, res) => {
  try {
    const snap = await db.collection("block_requests").get();
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json(list);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// PUT /api/admin/blocks/:id/vote — approve or reject
router.put("/blocks/:id/vote", async (req, res) => {
  try {
    const { id } = req.params;
    const { vote } = req.body; // "approve" | "reject"
    const admin = req.user;

    const ref  = db.collection("block_requests").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ message: "Block request not found" });

    const data = snap.data();
    if (data.status !== "pending") return res.status(400).json({ message: `Request is already ${data.status}` });

    if ((data.votes || []).some(v => v.adminEmail === admin.email)) {
      return res.status(400).json({ message: "You have already voted on this request" });
    }

    const newVote = {
      adminEmail: admin.email,
      adminName:  admin.name || admin.email,
      adminId:    admin.uid  || admin.email,
      vote,
      timestamp:  new Date().toISOString()
    };
    const allVotes  = [...(data.votes || []), newVote];
    const approvals = allVotes.filter(v => v.vote === "approve").length;

    const update = { votes: allVotes, approvalCount: approvals, updatedAt: new Date().toISOString() };
    let responseMsg = "";

    if (vote === "reject") {
      update.status      = "rejected";
      update.completedAt = new Date().toISOString();
      responseMsg        = "Block request rejected.";

      log({ userId: admin.email, email: admin.email, role: "admin",
            action: "BLOCK_REJECTED",
            details: { requestId: id, targetEmail: data.targetEmail } });
    } else if (approvals >= data.requiredApprovals) {
      update.status      = "approved";
      update.completedAt = new Date().toISOString();
      responseMsg        = "Block approved and executed! Account has been blocked.";

      // Block the target user
      try {
        const uSnap = await db.collection("users").where("email", "==", data.targetEmail).get();
        if (!uSnap.empty) {
          await db.collection("users").doc(uSnap.docs[0].id).update({
            blocked: true,
            blockedAt: new Date().toISOString(),
            blockedReason: data.reason,
            blockRequestId: id
          });
        }
      } catch (blockErr) { console.error("[Block] user update error:", blockErr.message); }

      // Generate report
      const report = buildBlockReport(data, allVotes.filter(v => v.vote === "approve"));
      update.report = report;

      log({ userId: admin.email, email: admin.email, role: "admin",
            action: "BLOCK_COMPLETED",
            details: { requestId: id, targetEmail: data.targetEmail, totalApprovals: approvals } });

      await pushNotification({
        type: "BLOCK_APPROVED", severity: "danger",
        title: "Account Blocked",
        message: `${data.targetName} (${data.targetRole}) has been blocked after 3 admin approvals.`,
        data: { requestId: id, targetEmail: data.targetEmail, report }
      });
    } else {
      update.status   = "pending";
      responseMsg     = `Vote recorded (${approvals}/3 approvals). ${data.requiredApprovals - approvals} more needed.`;
    }

    await ref.update(update);

    log({ userId: admin.email, email: admin.email, role: "admin",
          action: "BLOCK_VOTE_CAST",
          details: { requestId: id, targetEmail: data.targetEmail, vote, approvals } });

    res.json({ message: responseMsg, status: update.status, approvals });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST /api/admin/blocks/:id/unblock — initiate an unblock REQUEST (requires 3-admin vote)
router.post("/blocks/:id/unblock", async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const admin = req.user;

    const ref  = db.collection("block_requests").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ message: "Block request not found" });

    const data = snap.data();
    if (data.status !== "approved") {
      return res.status(400).json({ message: "Only actively blocked accounts can be unblocked" });
    }

    // Check if an unblock request already exists for this block
    const existing = await db.collection("unblock_requests")
      .where("blockRequestId", "==", id)
      .where("status", "==", "pending")
      .get();
    if (!existing.empty) {
      return res.status(400).json({ message: "An unblock request is already pending for this account. Cast your vote there." });
    }

    // Create unblock request with requester's first vote
    const unblockRequest = {
      blockRequestId: id,
      targetEmail:    data.targetEmail,
      targetName:     data.targetName || data.targetEmail,
      targetRole:     data.targetRole || "",
      reason:         reason || "Admin-initiated unblock",
      requestedBy:    admin.email,
      requestedAt:    new Date().toISOString(),
      requiredApprovals: 3,
      votes: [{
        adminEmail: admin.email,
        adminName:  admin.name || admin.email,
        vote:       "approve",
        timestamp:  new Date().toISOString()
      }],
      approvalCount: 1,
      status: "pending"
    };

    const docRef = await db.collection("unblock_requests").add(unblockRequest);

    log({ userId: admin.email, email: admin.email, role: "admin",
          action: "UNBLOCK_REQUESTED",
          details: { requestId: docRef.id, blockRequestId: id, targetEmail: data.targetEmail } });

    await pushNotification({
      type: "UNBLOCK_REQUESTED", severity: "info",
      title: "Unblock Request Submitted",
      message: `${admin.email} requested to unblock ${data.targetName || data.targetEmail}. 2 more admin approvals required.`,
      data: { unblockRequestId: docRef.id, targetEmail: data.targetEmail }
    });

    res.status(201).json({
      message: "Unblock request created. Your vote (1/3) has been recorded. 2 more admin approvals needed.",
      unblockRequestId: docRef.id,
      approvalCount: 1,
      required: 3
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET /api/admin/unblock-requests — list all unblock requests
router.get("/unblock-requests", async (req, res) => {
  try {
    const snap = await db.collection("unblock_requests").get();
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.requestedAt || "").localeCompare(a.requestedAt || ""));
    res.json(list);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// PUT /api/admin/unblock-requests/:id/vote — approve or reject unblock
router.put("/unblock-requests/:id/vote", async (req, res) => {
  try {
    const { vote } = req.body; // "approve" | "reject"
    if (!["approve", "reject"].includes(vote)) {
      return res.status(400).json({ message: "vote must be 'approve' or 'reject'" });
    }
    const admin = req.user;
    const ref   = db.collection("unblock_requests").doc(req.params.id);
    const snap  = await ref.get();
    if (!snap.exists) return res.status(404).json({ message: "Unblock request not found" });

    const data = snap.data();
    if (data.status !== "pending") {
      return res.status(400).json({ message: `Unblock request is already ${data.status}` });
    }
    if ((data.votes || []).some(v => v.adminEmail === admin.email)) {
      return res.status(400).json({ message: "You have already voted on this unblock request" });
    }

    const newVote   = { adminEmail: admin.email, adminName: admin.name || admin.email, vote, timestamp: new Date().toISOString() };
    const allVotes  = [...(data.votes || []), newVote];
    const approvals = allVotes.filter(v => v.vote === "approve").length;
    const now       = new Date().toISOString();
    const update    = { votes: allVotes, approvalCount: approvals, updatedAt: now };
    let   responseMsg = "";

    if (vote === "reject") {
      update.status      = "rejected";
      update.completedAt = now;
      responseMsg        = "Unblock request rejected.";

      log({ userId: admin.email, email: admin.email, role: "admin",
            action: "UNBLOCK_REJECTED",
            details: { requestId: req.params.id, targetEmail: data.targetEmail } });
    } else if (approvals >= data.requiredApprovals) {
      // 3rd approval — actually unblock the user
      update.status      = "approved";
      update.completedAt = now;
      responseMsg        = "Unblock approved by all 3 admins. Account has been restored.";

      // Restore user in DB
      try {
        const uSnap = await db.collection("users").where("email", "==", data.targetEmail).get();
        if (!uSnap.empty) {
          await db.collection("users").doc(uSnap.docs[0].id).update({
            blocked:        false,
            blockedReason:  null,
            blockRequestId: null,
            unblockedAt:    now,
            unblockedBy:    admin.email
          });
        }
      } catch (uErr) { console.error("[Unblock] user restore error:", uErr.message); }

      // Mark original block request as unblocked
      if (data.blockRequestId) {
        await db.collection("block_requests").doc(data.blockRequestId).update({
          status: "unblocked", unblockedAt: now, unblockedBy: admin.email
        });
      }

      log({ userId: admin.email, email: admin.email, role: "admin",
            action: "BLOCK_UNBLOCKED",
            details: { unblockRequestId: req.params.id, targetEmail: data.targetEmail, totalApprovals: approvals } });

      await pushNotification({
        type: "ACCOUNT_UNBLOCKED", severity: "success",
        title: "Account Unblocked",
        message: `${data.targetName || data.targetEmail} has been unblocked after 3 admin approvals.`,
        data: { unblockRequestId: req.params.id, targetEmail: data.targetEmail }
      });
    } else {
      update.status  = "pending";
      responseMsg    = `Vote recorded (${approvals}/3 approvals). ${data.requiredApprovals - approvals} more needed.`;
    }

    await ref.update(update);

    log({ userId: admin.email, email: admin.email, role: "admin",
          action: "UNBLOCK_VOTE_CAST",
          details: { requestId: req.params.id, targetEmail: data.targetEmail, vote, approvals } });

    res.json({ message: responseMsg, status: update.status, approvals });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// 7. APPEAL MANAGEMENT (admin side)
// ═══════════════════════════════════════════════════════════

router.get("/appeals", async (req, res) => {
  try {
    const snap = await db.collection("appeals").get();
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json(list);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.put("/appeals/:id/review", async (req, res) => {
  try {
    const { id } = req.params;
    const { decision, note } = req.body;
    const admin = req.user;

    const ref  = db.collection("appeals").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ message: "Appeal not found" });

    const appeal = snap.data();

    await ref.update({
      status:        decision === "approve" ? "approved" : "rejected",
      reviewedBy:    admin.email,
      reviewedByName:admin.name || admin.email,
      reviewDecision:decision,
      reviewNote:    note || "",
      reviewedAt:    new Date().toISOString()
    });

    if (decision === "approve") {
      const uSnap = await db.collection("users").where("email", "==", appeal.userEmail).get();
      if (!uSnap.empty) {
        await db.collection("users").doc(uSnap.docs[0].id).update({
          blocked: false, blockedAt: null, blockedReason: null,
          restoredAt: new Date().toISOString(), restoredBy: admin.email
        });
      }
      await pushNotification({
        type: "APPEAL_APPROVED", severity: "success",
        title: "Appeal Approved",
        message: `${appeal.userName || appeal.userEmail}'s appeal approved. Account restored by ${admin.name}.`,
        data: { appealId: id, userEmail: appeal.userEmail }
      });
      log({ userId: admin.email, email: admin.email, role: "admin",
            action: "APPEAL_APPROVED", details: { appealId: id, userEmail: appeal.userEmail } });
    } else {
      log({ userId: admin.email, email: admin.email, role: "admin",
            action: "APPEAL_REJECTED", details: { appealId: id, userEmail: appeal.userEmail } });
    }

    res.json({ message: `Appeal ${decision === "approve" ? "approved — account restored" : "rejected"}.` });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// 4. LIVE STATS
// ═══════════════════════════════════════════════════════════
router.get("/live-stats", async (req, res) => {
  try {
    const now       = new Date();
    const today     = now.toISOString().split("T")[0];
    const threshold = new Date(now - 5 * 60 * 1000).toISOString();

    const [tSnap, uSnap, bSnap, aSnap, nSnap] = await Promise.all([
      db.collection("tickets").get(),
      db.collection("users").get(),
      db.collection("block_requests").where("status", "==", "pending").get(),
      db.collection("activity_logs").get(),
      db.collection("admin_notifications").where("read", "==", false).get()
    ]);

    const tickets = []; tSnap.forEach(d => tickets.push(d.data()));
    const users   = []; uSnap.forEach(d => users.push(d.data()));
    const customers = users.filter(u => u.role === "customer");
    const agents    = users.filter(u => u.role === "agent");

    const customersOnline = customers.filter(u => u.lastActive >= threshold).length;
    const agentsOnline    = agents.filter(u => u.lastActive >= threshold).length;
    const openTickets     = tickets.filter(t => t.status === "Open").length;
    const pendingTickets  = tickets.filter(t => t.status === "In Progress").length;
    const resolvedToday   = tickets.filter(t => t.status === "Resolved" && (t.updatedAt || "").startsWith(today)).length;

    let aiResponses = 0;
    aSnap.forEach(d => { if (d.data().action === "AI_CHAT_USED") aiResponses++; });

    const rated  = tickets.filter(t => t.rating != null);
    const avgRating = rated.length > 0
      ? (rated.reduce((s, t) => s + t.rating, 0) / rated.length).toFixed(1) : null;

    res.json({
      customersOnline, agentsOnline, openTickets, pendingTickets,
      resolvedToday, aiResponses,
      pendingBlocks: bSnap.size,
      avgRating, unreadNotifications: nSnap.size,
      systemHealth: "Healthy",
      timestamp: now.toISOString()
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// 5. ACTIVITY FEED
// ═══════════════════════════════════════════════════════════
router.get("/activity-feed", async (req, res) => {
  try {
    const snap = await db.collection("activity_logs").get();
    const feed = [];
    snap.forEach(d => feed.push({ id: d.id, ...d.data() }));
    feed.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    res.json({ feed: feed.slice(0, 60) });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// 3 & 9. AGENT PERFORMANCE + DETAILED REPORT
// ═══════════════════════════════════════════════════════════
router.get("/agent-performance", async (req, res) => {
  try {
    const [tSnap, uSnap] = await Promise.all([
      db.collection("tickets").get(),
      db.collection("users").where("role", "==", "agent").get()
    ]);
    const tickets = []; tSnap.forEach(d => tickets.push({ id: d.id, ...d.data() }));
    const agents  = []; uSnap.forEach(d => agents.push({ id: d.id, ...d.data() }));

    const now = new Date();
    const stats = agents.map(agent => {
      const el = (agent.email || "").toLowerCase();
      const at = tickets.filter(t => (t.assignedTo || "").toLowerCase() === el);
      const resolved = at.filter(t => t.status === "Resolved");
      const pending  = at.filter(t => t.status === "In Progress");
      const escalated= at.filter(t => t.escalated);
      const aiHelped = at.filter(t => (t.messages || []).some(m => m.isBot));

      let totalResp = 0, cntResp = 0, totalRes = 0, cntRes = 0;
      at.forEach(t => {
        const fm = (t.messages || []).find(m => m.sender === "agent" && !m.isBot);
        if (fm && t.createdAt) { const d = new Date(fm.timestamp) - new Date(t.createdAt); if (d > 0) { totalResp += d; cntResp++; } }
      });
      resolved.forEach(t => {
        if (t.createdAt && t.updatedAt) { const d = new Date(t.updatedAt) - new Date(t.createdAt); if (d > 0) { totalRes += d; cntRes++; } }
      });

      const avgRespH = cntResp > 0 ? (totalResp / cntResp / 3600000).toFixed(1) : null;
      const avgResH  = cntRes  > 0 ? (totalRes  / cntRes  / 3600000).toFixed(1) : null;
      const rated    = resolved.filter(t => t.rating != null);
      const csat     = rated.length > 0 ? (rated.reduce((s, t) => s + t.rating, 0) / rated.length).toFixed(1) : null;
      const aiPct    = at.length > 0 ? Math.round((aiHelped.length / at.length) * 100) : 0;

      const scoreRes  = at.length > 0 ? (resolved.length / at.length) * 40 : 0;
      const scoreCsat = csat ? (parseFloat(csat) / 5) * 35 : 0;
      const scoreResp = avgRespH ? Math.max(0, 25 - parseFloat(avgRespH) * 2) : 12;
      const productivity = Math.min(100, Math.round(scoreRes + scoreCsat + scoreResp));

      const online = agent.lastActive && (now - new Date(agent.lastActive)) < 5 * 60 * 1000;

      return {
        id: agent.id, name: agent.name, email: agent.email,
        department: agent.department || "Support",
        status: online ? "Online" : "Offline", online,
        assigned: at.length, resolved: resolved.length,
        pending: pending.length,
        avgResponseHours: avgRespH, avgResolutionHours: avgResH,
        csat, aiUsagePct: aiPct,
        escalated: escalated.length,
        productivityScore: productivity,
        warnings: agent.warnings || 0,
        lastActive: agent.lastActive || null
      };
    });

    res.json(stats);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get("/agent-report/:email", async (req, res) => {
  try {
    const el = req.params.email.toLowerCase();
    const [tSnap, uSnap] = await Promise.all([
      db.collection("tickets").get(),
      db.collection("users").where("email", "==", el).get()
    ]);
    if (uSnap.empty) return res.status(404).json({ message: "Agent not found" });

    const agent   = uSnap.docs[0].data();
    const tickets = []; tSnap.forEach(d => tickets.push({ id: d.id, ...d.data() }));
    const at      = tickets.filter(t => (t.assignedTo || "").toLowerCase() === el);
    const resolved= at.filter(t => t.status === "Resolved");
    const now     = new Date();
    const wkStart = new Date(now - 7 * 86400000).toISOString();
    const moStart = new Date(now - 30 * 86400000).toISOString();

    let tr = 0, cr = 0, tres = 0, cres = 0;
    at.forEach(t => {
      const fm = (t.messages || []).find(m => m.sender === "agent" && !m.isBot);
      if (fm && t.createdAt) { const d = new Date(fm.timestamp) - new Date(t.createdAt); if (d > 0) { tr += d; cr++; } }
    });
    resolved.forEach(t => {
      if (t.createdAt && t.updatedAt) { const d = new Date(t.updatedAt) - new Date(t.createdAt); if (d > 0) { tres += d; cres++; } }
    });

    const avgReply      = cr   > 0 ? (tr   / cr   / 3600000).toFixed(1) + "h" : "N/A";
    const avgResolution = cres > 0 ? (tres / cres / 3600000).toFixed(1) + "h" : "N/A";
    const rated  = resolved.filter(t => t.rating != null);
    const csat   = rated.length > 0 ? (rated.reduce((s, t) => s + t.rating, 0) / rated.length).toFixed(1) + " / 5" : "No ratings";
    const aiHelp = at.filter(t => (t.messages || []).some(m => m.isBot));
    const wkRes  = resolved.filter(t => (t.updatedAt || "") >= wkStart).length;
    const moRes  = resolved.filter(t => (t.updatedAt || "") >= moStart).length;
    const score  = Math.min(100, Math.round(
      (at.length > 0 ? (resolved.length / at.length) * 40 : 0) +
      (rated.length > 0 ? (rated.reduce((s, t) => s + t.rating, 0) / rated.length / 5) * 35 : 0) + 25
    ));

    res.json({
      agent: { name: agent.name, email: agent.email, department: agent.department || "Support" },
      ticketsAssigned: at.length,       ticketsClosed: resolved.length,
      ticketsPending: at.filter(t => t.status === "In Progress").length,
      avgReplyTime: avgReply,           avgResolutionTime: avgResolution,
      customerRating: csat,             escalationCount: at.filter(t => t.escalated).length,
      aiAssistedReplies: aiHelp.length, knowledgeArticlesUsed: Math.max(1, Math.floor(at.length * 0.3)),
      weeklyProductivity: wkRes,        monthlyProductivity: moRes,
      overallScore: `${score} / 100`,   generatedAt: now.toISOString()
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// 10. CUSTOMER DETAILED REPORT
// ═══════════════════════════════════════════════════════════
router.get("/customer-report/:email", async (req, res) => {
  try {
    const el = req.params.email.toLowerCase();
    const [tSnap, uSnap, bSnap, aSnap] = await Promise.all([
      db.collection("tickets").get(),
      db.collection("users").where("email", "==", el).get(),
      db.collection("block_requests").where("targetEmail", "==", el).get(),
      db.collection("appeals").where("userEmail", "==", el).get()
    ]);

    const tickets = []; tSnap.forEach(d => tickets.push({ id: d.id, ...d.data() }));
    const ct = tickets.filter(t => (t.createdBy || "").toLowerCase() === el);
    const resolved = ct.filter(t => t.status === "Resolved");
    const userData = !uSnap.empty ? uSnap.docs[0].data() : {};

    let tres = 0, cres = 0;
    resolved.forEach(t => {
      if (t.createdAt && t.updatedAt) { const d = new Date(t.updatedAt) - new Date(t.createdAt); if (d > 0) { tres += d; cres++; } }
    });

    const blockHistory = []; bSnap.forEach(d => blockHistory.push({ id: d.id, ...d.data() }));
    const appealHistory= []; aSnap.forEach(d => appealHistory.push({ id: d.id, ...d.data() }));

    const timeline = ct.map(t => ({
      type: "ticket", subject: t.subject, date: t.createdAt,
      event: t.status === "Resolved" ? "Ticket Resolved" : t.status === "In Progress" ? "In Progress" : "Ticket Created",
      status: t.status
    })).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    res.json({
      customer: { name: userData.name || el, email: el, blocked: userData.blocked || false },
      ticketsCreated: ct.length,        ticketsResolved: resolved.length,
      ticketsPending: ct.filter(t => t.status === "In Progress").length,
      avgResolutionTime: cres > 0 ? (tres / cres / 3600000).toFixed(1) + "h" : "N/A",
      sentimentHistory:  ct.map(t => ({ subject: t.subject, sentiment: t.sentiment || "Neutral", date: t.createdAt })).slice(-10),
      recentChats:  ct.slice(-5).map(t => ({ subject: t.subject, date: t.createdAt, status: t.status })),
      feedbackRatings: resolved.filter(t => t.rating != null).map(t => ({ subject: t.subject, rating: t.rating, feedback: t.feedback || "", date: t.updatedAt })),
      blockHistory, appealHistory, timeline: timeline.slice(0, 20),
      generatedAt: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// 11. LIVE USER MONITORING + 12. FRAUD DETECTION
// ═══════════════════════════════════════════════════════════
router.get("/monitoring", async (req, res) => {
  try {
    const now = new Date();
    const threshold = new Date(now - 10 * 60 * 1000).toISOString();
    const [uSnap, tSnap] = await Promise.all([
      db.collection("users").get(),
      db.collection("tickets").get()
    ]);

    const users   = []; uSnap.forEach(d => users.push({ id: d.id, ...d.data() }));
    const tickets = []; tSnap.forEach(d => tickets.push({ id: d.id, ...d.data() }));

    const onlineUsers = users
      .filter(u => u.lastActive && u.lastActive >= threshold)
      .map(u => ({
        id: u.id, name: u.name, email: u.email, role: u.role,
        lastActive: u.lastActive,
        currentPage: u.currentPage || "Dashboard",
        sessionStart: u.sessionStart || u.lastActive,
        sessionDuration: u.sessionStart ? Math.round((now - new Date(u.sessionStart)) / 60000) : 0,
        blocked: u.blocked || false
      }));

    // Fraud detection
    const ticketCount = {}, subjectMap = {}, negativeCount = {};
    tickets.forEach(t => {
      const e = (t.createdBy || "").toLowerCase();
      ticketCount[e]  = (ticketCount[e] || 0) + 1;
      const sk = `${e}:${(t.subject || "").toLowerCase().trim()}`;
      subjectMap[sk]  = (subjectMap[sk] || 0) + 1;
      if (t.sentiment === "Negative") negativeCount[e] = (negativeCount[e] || 0) + 1;
    });

    const fraudAlerts = [];
    Object.entries(ticketCount).forEach(([email, count]) => {
      if (count >= 8) {
        const u = users.find(u => u.email === email) || {};
        fraudAlerts.push({
          type: "SPAM_TICKETS", severity: count >= 15 ? "critical" : "warning",
          email, name: u.name || email,
          description: `${count} tickets submitted — possible spam`, count
        });
      }
    });
    Object.entries(subjectMap).forEach(([key, count]) => {
      if (count >= 3) {
        const [email] = key.split(":");
        if (!fraudAlerts.find(a => a.email === email && a.type === "DUPLICATE_TICKETS")) {
          const u = users.find(u => u.email === email) || {};
          fraudAlerts.push({
            type: "DUPLICATE_TICKETS", severity: "warning",
            email, name: u.name || email,
            description: `Repeated identical ticket subjects (${count}×)`, count
          });
        }
      }
    });
    Object.entries(negativeCount).forEach(([email, count]) => {
      if (count >= 5) {
        const u = users.find(u => u.email === email) || {};
        if (!fraudAlerts.find(a => a.email === email && a.type === "ABUSE_DETECTED")) {
          fraudAlerts.push({
            type: "ABUSE_DETECTED", severity: "warning",
            email, name: u.name || email,
            description: `${count} negative-sentiment tickets — possible abuse`, count
          });
        }
      }
    });

    res.json({ onlineUsers, fraudAlerts });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// 13. AI ALERT CENTER
// ═══════════════════════════════════════════════════════════
router.get("/ai-alerts", async (req, res) => {
  try {
    const [tSnap, uSnap] = await Promise.all([
      db.collection("tickets").get(),
      db.collection("users").where("role", "==", "agent").get()
    ]);
    const tickets = []; tSnap.forEach(d => tickets.push({ id: d.id, ...d.data() }));
    const agents  = []; uSnap.forEach(d => agents.push(d.data()));

    const now = new Date();
    const inactiveThreshold = new Date(now - 48 * 3600000).toISOString();

    const negative   = tickets.filter(t => t.sentiment === "Negative" && t.status !== "Resolved").slice(0, 10);
    const highPri    = tickets.filter(t => t.priority === "High"      && t.status !== "Resolved").slice(0, 10);
    const inactive   = tickets.filter(t => t.status === "In Progress" && t.updatedAt && t.updatedAt < inactiveThreshold).slice(0, 10);
    const unassigned = tickets.filter(t => !t.assignedTo              && t.status !== "Resolved").slice(0, 5);

    const agentLoads = agents.map(a => {
      const count = tickets.filter(t => (t.assignedTo||"").toLowerCase() === a.email.toLowerCase() && t.status !== "Resolved").length;
      return { name: a.name, email: a.email, openCount: count, overloaded: count > 5 };
    }).filter(a => a.overloaded);

    res.json({ negativeSentiment: negative, highPriority: highPri, inactiveTickets: inactive, overloadedAgents: agentLoads, escalationSuggestions: unassigned });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// 14. NOTIFICATIONS
// ═══════════════════════════════════════════════════════════
router.get("/notifications", async (req, res) => {
  try {
    const snap = await db.collection("admin_notifications").get();
    const list = []; let unread = 0;
    snap.forEach(d => {
      const data = d.data();
      list.push({ id: d.id, ...data });
      if (!data.read) unread++;
    });
    list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json({ notifications: list.slice(0, 100), unread });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.put("/notifications/read-all", async (req, res) => {
  try {
    const snap = await db.collection("admin_notifications").where("read", "==", false).get();
    const updates = [];
    snap.forEach(d => updates.push(db.collection("admin_notifications").doc(d.id).update({ read: true })));
    await Promise.all(updates);
    res.json({ message: "All notifications marked as read" });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST alias (frontend convenience)
router.post("/notifications/mark-all-read", async (req, res) => {
  try {
    const snap = await db.collection("admin_notifications").where("read", "==", false).get();
    const updates = [];
    snap.forEach(d => updates.push(db.collection("admin_notifications").doc(d.id).update({ read: true })));
    await Promise.all(updates);
    res.json({ message: "All notifications marked as read" });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Mark single notification read
router.post("/notifications/:id/read", async (req, res) => {
  try {
    await db.collection("admin_notifications").doc(req.params.id).update({ read: true });
    res.json({ message: "Notification marked as read" });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// 15. AUTHORIZED EMAIL WHITELIST (agent / admin invitations)
// ═══════════════════════════════════════════════════════════

// GET all authorized emails
router.get("/authorized-emails", async (req, res) => {
  try {
    const snap = await db.collection("authorized_emails").get();
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.invitedAt || "").localeCompare(a.invitedAt || ""));
    res.json({ authorizedEmails: list });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST add an authorized email
router.post("/authorized-emails", async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) return res.status(400).json({ message: "Email and role are required" });
    if (!["agent", "admin"].includes(role)) return res.status(400).json({ message: "Role must be agent or admin" });
    const emailLower = email.toLowerCase().trim();

    // Check if already exists
    const existing = await db.collection("authorized_emails")
      .where("email", "==", emailLower).where("role", "==", role).get();
    if (!existing.empty) return res.status(400).json({ message: "This email is already authorized for this role" });

    const ref = await db.collection("authorized_emails").add({
      email: emailLower, role,
      invitedBy: req.user.email,
      invitedByName: req.user.name || req.user.email,
      invitedAt: new Date().toISOString(),
      used: false
    });

    log({ userId: req.user.email, email: req.user.email, role: "admin",
          action: "EMAIL_AUTHORIZED", details: { email: emailLower, role } });

    res.status(201).json({ message: `${emailLower} authorized as ${role}`, id: ref.id });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// DELETE revoke an authorized email
router.delete("/authorized-emails/:id", async (req, res) => {
  try {
    await db.collection("authorized_emails").doc(req.params.id).delete();
    log({ userId: req.user.email, email: req.user.email, role: "admin",
          action: "EMAIL_AUTHORIZATION_REVOKED", details: { id: req.params.id } });
    res.json({ message: "Authorization revoked" });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// OTP VERIFICATION — Feature 18
// ═══════════════════════════════════════════════════════════
const { generateOTP, verifyOTP } = require("../services/otpService");
const { sendOTPEmail }           = require("../services/emailService");

router.post("/otp/request", async (req, res) => {
  try {
    const { action } = req.body;
    if (!action) return res.status(400).json({ message: "action required" });
    const validActions = ["block_user","delete_account","grant_admin","restore_user","delete_kb"];
    if (!validActions.includes(action)) return res.status(400).json({ message: "Invalid action" });

    const { code, expiresAt } = await generateOTP(req.user.email, action);
    await sendOTPEmail({ email: req.user.email, code, action, expiresAt }).catch(() => {});

    res.json({ message: `OTP sent to ${req.user.email}. Expires in 10 minutes.`, expiresAt });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post("/otp/verify", async (req, res) => {
  try {
    const { action, otp } = req.body;
    if (!action || !otp) return res.status(400).json({ message: "action and otp required" });
    const result = await verifyOTP(req.user.email, action, otp);
    if (!result.valid) return res.status(400).json({ message: result.reason });
    res.json({ valid: true, message: "OTP verified successfully" });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// CUSTOMER REPUTATION — Feature 5
// ═══════════════════════════════════════════════════════════
const { getReputation, updateReputation } = require("../services/ticketAI");

router.get("/reputation/:email", async (req, res) => {
  try {
    const rep = await getReputation(req.params.email);
    res.json(rep);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get("/reputations", async (req, res) => {
  try {
    const snap = await db.collection("customer_reputation").get();
    const list = [];
    snap.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
    list.sort((a, b) => a.score - b.score);
    res.json({ reputations: list });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post("/reputation/:email/event", async (req, res) => {
  try {
    const { event } = req.body;
    await updateReputation(req.params.email, event);
    const rep = await getReputation(req.params.email);
    res.json({ message: "Reputation updated", ...rep });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FRAUD ALERTS — Feature 6
// ═══════════════════════════════════════════════════════════
router.get("/fraud-alerts", async (req, res) => {
  try {
    const snap = await db.collection("fraud_alerts").get();
    const alerts = [];
    snap.forEach(doc => alerts.push({ id: doc.id, ...doc.data() }));
    alerts.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json({ alerts });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.put("/fraud-alerts/:id/review", async (req, res) => {
  try {
    const { decision, note } = req.body;
    await db.collection("fraud_alerts").doc(req.params.id).update({
      reviewed: true, decision, reviewNote: note || "",
      reviewedBy: req.user.email, reviewedAt: new Date().toISOString()
    });
    res.json({ message: "Fraud alert reviewed" });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ESCALATIONS — Feature 15
// ═══════════════════════════════════════════════════════════
router.get("/escalations", async (req, res) => {
  try {
    const snap = await db.collection("escalations").get();
    const list = [];
    snap.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
    list.sort((a, b) => (b.escalatedAt || "").localeCompare(a.escalatedAt || ""));
    res.json({ escalations: list });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// AI DASHBOARD INSIGHTS — Feature 16
// ═══════════════════════════════════════════════════════════
router.get("/insights", async (req, res) => {
  try {
    const [ticketSnap, agentSnap, repSnap, fraudSnap] = await Promise.all([
      db.collection("tickets").get(),
      db.collection("users").where("role","==","agent").get(),
      db.collection("customer_reputation").get(),
      db.collection("fraud_alerts").where("reviewed","==",false).get()
    ]);

    const tickets = [];
    ticketSnap.forEach(doc => tickets.push({ id: doc.id, ...doc.data() }));

    const byStatus   = { Open: 0, "In Progress": 0, Resolved: 0, Closed: 0 };
    const byPriority = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    const byCategory = {};
    const byDay      = {};
    let   totalRating = 0, ratingCount = 0, totalResHours = 0, resCount = 0;

    tickets.forEach(t => {
      byStatus[t.status]       = (byStatus[t.status]       || 0) + 1;
      byPriority[t.priority]   = (byPriority[t.priority]   || 0) + 1;
      byCategory[t.category]   = (byCategory[t.category]   || 0) + 1;
      const day = (t.createdAt || "").substring(0, 10);
      if (day) byDay[day]      = (byDay[day] || 0) + 1;
      if (t.rating) { totalRating += t.rating; ratingCount++; }
      if (t.status === "Resolved" && t.createdAt && t.updatedAt) {
        const hrs = (new Date(t.updatedAt) - new Date(t.createdAt)) / 3600000;
        if (hrs > 0 && hrs < 720) { totalResHours += hrs; resCount++; }
      }
    });

    const last30 = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-30)
      .map(([date, count]) => ({ date, count }));

    res.json({
      summary: {
        totalTickets:      tickets.length,
        openTickets:       byStatus.Open || 0,
        inProgress:        byStatus["In Progress"] || 0,
        resolved:          byStatus.Resolved || 0,
        avgRating:         ratingCount ? (totalRating / ratingCount).toFixed(1) : null,
        avgResolutionHrs:  resCount    ? (totalResHours / resCount).toFixed(1)  : null,
        totalAgents:       agentSnap.size || 0,
        unreadFraudAlerts: fraudSnap.size || 0,
        totalCustomers:    repSnap.size   || 0
      },
      byStatus,
      byPriority,
      byCategory,
      ticketTrend: last30
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// QUALITY SCORES — Feature 10 (admin view)
// ═══════════════════════════════════════════════════════════
router.get("/quality-scores", async (req, res) => {
  try {
    const snap = await db.collection("quality_scores").get();
    const scores = [];
    snap.forEach(doc => scores.push({ id: doc.id, ...doc.data() }));
    scores.sort((a, b) => (b.scoredAt || "").localeCompare(a.scoredAt || ""));
    res.json({ scores: scores.slice(0, 100) });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

module.exports = router;
