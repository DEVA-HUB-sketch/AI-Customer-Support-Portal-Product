// backend/routes/analyticsRoutes.js
const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/auth");

// All analytics routes require a valid JWT
router.use(verifyToken);

// GET /api/analytics?role=admin|agent|customer&email=...
router.get("/", async (req, res) => {
  try {
    const { role, email } = req.query;

    // Fetch all tickets and users
    const ticketSnap = await db.collection("tickets").get();
    const userSnap = await db.collection("users").get();

    const tickets = [];
    ticketSnap.forEach(doc => tickets.push({ id: doc.id, ...doc.data() }));

    const users = [];
    userSnap.forEach(doc => users.push({ id: doc.id, ...doc.data() }));

    if (role === "admin") {
      const total = tickets.length;
      const open = tickets.filter(t => t.status === "Open").length;
      const inProgress = tickets.filter(t => t.status === "In Progress").length;
      const resolved = tickets.filter(t => t.status === "Resolved").length;
      const resolutionRate = total > 0 ? Math.round((resolved / total) * 100) : 0;

      const ratedTickets = tickets.filter(t => t.rating != null);
      const avgCSAT = ratedTickets.length > 0
        ? (ratedTickets.reduce((sum, t) => sum + t.rating, 0) / ratedTickets.length).toFixed(1)
        : "N/A";

      // Category breakdown
      const categories = {};
      tickets.forEach(t => {
        const cat = t.category || "General";
        categories[cat] = (categories[cat] || 0) + 1;
      });

      // Priority breakdown
      const priorities = { High: 0, Medium: 0, Low: 0 };
      tickets.forEach(t => {
        const p = t.priority || "Low";
        if (priorities[p] !== undefined) priorities[p]++;
        else priorities["Low"]++;
      });

      // Sentiment breakdown
      const sentiments = { Positive: 0, Neutral: 0, Negative: 0 };
      tickets.forEach(t => {
        const s = t.sentiment || "Neutral";
        if (sentiments[s] !== undefined) sentiments[s]++;
        else sentiments["Neutral"]++;
      });

      // User stats
      const totalUsers = users.length;
      const totalAgents = users.filter(u => u.role === "agent").length;
      const totalCustomers = users.filter(u => u.role === "customer").length;

      // Agent performance stats
      const agents = users.filter(u => u.role === "agent");
      const agentStats = agents.map(agent => {
        const agentEmailLower = (agent.email || "").toLowerCase();
        const agentTickets = tickets.filter(t => (t.assignedTo || "").toLowerCase() === agentEmailLower);
        const agentResolved = agentTickets.filter(t => t.status === "Resolved");

        // avg response hours
        let totalHours = 0;
        let countWithResponse = 0;
        agentTickets.forEach(t => {
          const msgs = (t.messages || []);
          const firstAgentMsg = msgs.find(m => m.sender === "agent" && !m.isBot);
          if (firstAgentMsg && t.createdAt) {
            const diffMs = new Date(firstAgentMsg.timestamp) - new Date(t.createdAt);
            if (diffMs > 0) {
              totalHours += diffMs / (1000 * 60 * 60);
              countWithResponse++;
            }
          }
        });
        const avgResponseHours = countWithResponse > 0
          ? (totalHours / countWithResponse).toFixed(1)
          : "N/A";

        const csatTickets = agentResolved.filter(t => t.rating != null);
        const csat = csatTickets.length > 0
          ? (csatTickets.reduce((sum, t) => sum + t.rating, 0) / csatTickets.length).toFixed(1)
          : "N/A";

        const recentFeedback = agentResolved
          .filter(t => t.rating != null)
          .slice(-5)
          .map(t => ({ rating: t.rating, feedback: t.feedback || "", subject: t.subject }));

        return {
          name: agent.name,
          email: agent.email,
          assigned: agentTickets.length,
          resolved: agentResolved.length,
          csat,
          avgResponseHours,
          recentFeedback
        };
      });

      // Rank agents by csat
      const sortedByCsat = [...agentStats]
        .filter(a => a.csat !== "N/A")
        .sort((a, b) => parseFloat(b.csat) - parseFloat(a.csat));
      agentStats.forEach(a => {
        const rankIdx = sortedByCsat.findIndex(s => s.email === a.email);
        a.rank = rankIdx >= 0 ? `#${rankIdx + 1} of ${sortedByCsat.length}` : "Unranked";
      });

      return res.json({
        total, open, inProgress, resolved, resolutionRate,
        avgCSAT,
        categories, priorities, sentiments,
        totalUsers, totalAgents, totalCustomers,
        agentStats
      });
    }

    if (role === "agent" && email) {
      const emailLower = email.toLowerCase();
      const agentTickets = tickets.filter(t => (t.assignedTo || "").toLowerCase() === emailLower);
      const agentResolved = agentTickets.filter(t => t.status === "Resolved");

      let totalHours = 0;
      let countWithResponse = 0;
      agentTickets.forEach(t => {
        const msgs = (t.messages || []);
        const firstAgentMsg = msgs.find(m => m.sender === "agent" && !m.isBot);
        if (firstAgentMsg && t.createdAt) {
          const diffMs = new Date(firstAgentMsg.timestamp) - new Date(t.createdAt);
          if (diffMs > 0) {
            totalHours += diffMs / (1000 * 60 * 60);
            countWithResponse++;
          }
        }
      });
      const avgResponseHours = countWithResponse > 0
        ? (totalHours / countWithResponse).toFixed(1)
        : "N/A";

      const csatTickets = agentResolved.filter(t => t.rating != null);
      const csat = csatTickets.length > 0
        ? (csatTickets.reduce((sum, t) => sum + t.rating, 0) / csatTickets.length).toFixed(1)
        : "N/A";

      const recentFeedback = csatTickets
        .slice(-10)
        .map(t => ({ rating: t.rating, feedback: t.feedback || "", subject: t.subject }));

      // Compute rank among all agents
      const allAgents = users.filter(u => u.role === "agent");
      const agentScores = allAgents.map(ag => {
        const agEmail = (ag.email || "").toLowerCase();
        const ats = tickets.filter(t => (t.assignedTo || "").toLowerCase() === agEmail && t.status === "Resolved" && t.rating != null);
        const score = ats.length > 0 ? ats.reduce((s, t) => s + t.rating, 0) / ats.length : 0;
        return { email: agEmail, score };
      }).filter(a => a.score > 0).sort((a, b) => b.score - a.score);

      const rankIdx = agentScores.findIndex(a => a.email === emailLower);
      const rank = rankIdx >= 0 ? `#${rankIdx + 1} of ${agentScores.length}` : "Unranked";

      return res.json({
        assigned: agentTickets.length,
        resolved: agentResolved.length,
        avgResponseHours,
        csat,
        rank,
        recentFeedback
      });
    }

    if (role === "customer" && email) {
      const emailLower = email.toLowerCase();
      const customerTickets = tickets.filter(t => t.createdBy === emailLower);
      const total = customerTickets.length;
      const open = customerTickets.filter(t => t.status === "Open").length;
      const inProgress = customerTickets.filter(t => t.status === "In Progress").length;
      const resolved = customerTickets.filter(t => t.status === "Resolved").length;

      const ratedTickets = customerTickets.filter(t => t.rating != null);
      const satisfaction = ratedTickets.length > 0
        ? (ratedTickets.reduce((sum, t) => sum + t.rating, 0) / ratedTickets.length).toFixed(1)
        : null;

      return res.json({ total, open, inProgress, resolved, satisfaction });
    }

    return res.status(400).json({ message: "Invalid role or missing email" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
