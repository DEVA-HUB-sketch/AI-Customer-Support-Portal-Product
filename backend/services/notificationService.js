// backend/services/notificationService.js
const { db } = require("../config/firebase");

/* Push to admin_notifications (admin dashboard bell) */
async function pushNotification({ type, severity, title, message, data = {} }) {
  try {
    await db.collection("admin_notifications").add({
      type, severity, title, message, data,
      read: false,
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    console.error("[Notification] Admin push failed:", err.message);
  }
}

/* Push to agent_notifications — agent-specific real-time bell */
async function pushAgentNotification({
  recipientEmail,
  recipientId,
  ticketId,
  ticketTitle,
  title,
  message,
  type       = "ticket_assignment",
  priority   = null,
  category   = null,
  customerEmail = null,
  createdBy  = "AI Auto Assignment"
}) {
  try {
    const ref = await db.collection("agent_notifications").add({
      recipientEmail: recipientEmail.toLowerCase(),
      recipientId:    recipientId || null,
      ticketId,
      ticketTitle,
      title,
      message,
      type,
      priority,
      category,
      customerEmail: customerEmail ? customerEmail.toLowerCase() : null,
      read:      false,
      createdAt: new Date().toISOString(),
      createdBy
    });
    console.log(`[AgentNotification] ✓ Created ${ref.id} → ${recipientEmail} (ticket ${ticketId})`);
    return ref.id;
  } catch (err) {
    console.error("[AgentNotification] ✗ Failed to push:", err.message);
    return null;
  }
}

module.exports = { pushNotification, pushAgentNotification };
