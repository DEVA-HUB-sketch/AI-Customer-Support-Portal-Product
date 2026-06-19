// backend/services/escalationEngine.js — Feature 15
const { db }               = require("../config/firebase");
const { log, ACTIONS }     = require("./activityLogger");
const { pushNotification } = require("./notificationService");

const ESCALATION_RULES = {
  inactiveHours:   24,  // Escalate if no update for 24h
  agentSLAHours:   4,   // Escalate if agent hasn't responded in 4h after assignment
  criticalSLAHours: 1,  // Critical tickets: escalate after 1h without response
  maxPendingHours: 48   // Escalate if open ticket older than 48h
};

function hoursSince(isoString) {
  if (!isoString) return 9999;
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60);
}

function shouldEscalate(ticket) {
  const reasons = [];
  const updatedHours  = hoursSince(ticket.updatedAt);
  const createdHours  = hoursSince(ticket.createdAt);
  const isCritical    = ticket.priority === "Critical";
  const isAssigned    = !!ticket.assignedTo;
  const isOpen        = ticket.status === "Open" || ticket.status === "In Progress";

  if (!isOpen || ticket.escalated) return { escalate: false, reasons: [] };

  // Rule 1: Critical ticket inactive for 1h
  if (isCritical && updatedHours >= ESCALATION_RULES.criticalSLAHours) {
    reasons.push(`Critical ticket inactive for ${updatedHours.toFixed(1)}h`);
  }
  // Rule 2: Assigned but no agent response in 4h
  if (isAssigned && updatedHours >= ESCALATION_RULES.agentSLAHours && !isCritical) {
    reasons.push(`Agent has not responded in ${updatedHours.toFixed(1)}h`);
  }
  // Rule 3: Customer waiting > 24h with no update
  if (updatedHours >= ESCALATION_RULES.inactiveHours) {
    reasons.push(`Ticket inactive for ${updatedHours.toFixed(0)}h — customer may be waiting`);
  }
  // Rule 4: Open ticket older than 48h
  if (createdHours >= ESCALATION_RULES.maxPendingHours && !isAssigned) {
    reasons.push(`Unassigned ticket open for ${createdHours.toFixed(0)}h`);
  }

  return { escalate: reasons.length > 0, reasons };
}

async function runEscalationCheck() {
  try {
    const snap = await db.collection("tickets").get();
    const now  = new Date().toISOString();
    let escalated = 0;

    const promises = [];
    snap.forEach(doc => {
      const ticket = { id: doc.id, ...doc.data() };
      const { escalate, reasons } = shouldEscalate(ticket);

      if (escalate) {
        escalated++;
        const timelineEntry = {
          type: "escalated", actor: "system",
          icon: "ti-alert-triangle", color: "var(--danger)",
          note: `Auto-escalated: ${reasons.join("; ")}`,
          timestamp: now
        };

        promises.push(
          db.collection("tickets").doc(ticket.id).update({
            escalated: true,
            escalatedAt: now,
            escalationReasons: reasons,
            priority: ticket.priority === "Low" ? "Medium" : ticket.priority === "Medium" ? "High" : ticket.priority,
            updatedAt: now,
            timeline: [...(ticket.timeline || []), timelineEntry]
          })
        );

        promises.push(
          db.collection("escalations").add({
            ticketId: ticket.id,
            subject:  ticket.subject,
            createdBy: ticket.createdBy,
            assignedTo: ticket.assignedTo,
            reasons,
            priority:   ticket.priority,
            escalatedAt: now,
            resolved:   false
          })
        );

        promises.push(
          pushNotification({
            type: "TICKET_ESCALATED", severity: "warn",
            title: "Ticket Escalated",
            message: `Ticket "${ticket.subject}" (${ticket.createdBy}) has been auto-escalated: ${reasons[0]}`,
            data: { ticketId: ticket.id, reasons }
          })
        );

        log({ userId: "system", email: "system", role: "system",
              action: "TICKET_ESCALATED",
              details: { ticketId: ticket.id, reasons } }).catch(() => {});
      }
    });

    await Promise.allSettled(promises);
    if (escalated > 0) console.log(`[EscalationEngine] Escalated ${escalated} tickets at ${now}`);
  } catch (err) {
    console.error("[EscalationEngine] Error:", err.message);
  }
}

module.exports = { runEscalationCheck, shouldEscalate };
