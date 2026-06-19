// backend/services/emailService.js
const nodemailer = require("nodemailer");

const EMAIL_HOST   = process.env.EMAIL_HOST   || "smtp.gmail.com";
const EMAIL_PORT   = parseInt(process.env.EMAIL_PORT || "587");
const EMAIL_USER   = process.env.EMAIL_USER   || "";
const EMAIL_PASS   = process.env.EMAIL_PASS   || "";
const EMAIL_FROM   = process.env.EMAIL_FROM   || `"DeskFlow AI" <${EMAIL_USER}>`;
const APP_URL      = process.env.APP_URL       || "http://localhost:5000";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn("[EmailService] EMAIL_USER / EMAIL_PASS not configured — emails will be logged to console only.");
    return null;
  }
  transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_PORT === 465,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    tls: { rejectUnauthorized: false }
  });
  return transporter;
}

async function send(to, subject, html) {
  const t = getTransporter();
  if (!t) {
    console.log(`[EmailService] (console-only) To: ${to} | Subject: ${subject}`);
    return;
  }
  try {
    await t.sendMail({ from: EMAIL_FROM, to, subject, html });
    console.log(`[EmailService] Sent: "${subject}" → ${to}`);
  } catch (err) {
    console.error(`[EmailService] Failed sending to ${to}:`, err.message);
  }
}

// ─── Shared HTML shell ────────────────────────────────────────────────────────
function wrap(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#0a0a0f;color:#f0f0ff;padding:32px 16px;}
  .wrapper{max-width:600px;margin:0 auto;background:#13131f;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);}
  .header{background:linear-gradient(135deg,#6c63ff,#3b82f6);padding:32px 40px;text-align:center;}
  .header img{width:48px;height:48px;margin-bottom:12px;}
  .header h1{color:#fff;font-size:22px;letter-spacing:-0.02em;}
  .header p{color:rgba(255,255,255,0.8);font-size:13px;margin-top:6px;}
  .body{padding:36px 40px;}
  .body h2{font-size:18px;margin-bottom:12px;color:#f0f0ff;}
  .body p{font-size:14px;line-height:1.7;color:#9090b0;margin-bottom:14px;}
  .info-card{background:rgba(108,99,255,0.1);border:1px solid rgba(108,99,255,0.25);border-radius:14px;padding:20px 24px;margin:20px 0;}
  .info-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);}
  .info-row:last-child{border-bottom:none;}
  .info-label{font-size:12px;font-weight:700;color:#6c63ff;text-transform:uppercase;letter-spacing:0.05em;}
  .info-value{font-size:13px;color:#f0f0ff;font-weight:600;}
  .btn{display:inline-block;background:linear-gradient(135deg,#6c63ff,#3b82f6);color:#fff!important;text-decoration:none;padding:14px 32px;border-radius:14px;font-weight:700;font-size:14px;margin:20px 0;}
  .badge{display:inline-block;padding:4px 12px;border-radius:999px;font-size:11px;font-weight:700;}
  .badge-open{background:rgba(56,189,248,0.15);color:#38bdf8;}
  .badge-resolved{background:rgba(34,211,165,0.15);color:#22d3a5;}
  .badge-high{background:rgba(244,114,182,0.15);color:#f472b6;}
  .badge-medium{background:rgba(251,146,60,0.15);color:#fb923c;}
  .badge-low{background:rgba(90,90,122,0.15);color:#9090b0;}
  .footer{padding:20px 40px;text-align:center;border-top:1px solid rgba(255,255,255,0.06);}
  .footer p{font-size:12px;color:#5a5a7a;line-height:1.6;}
  .footer a{color:#6c63ff;text-decoration:none;}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>⚡ DeskFlow AI</h1>
    <p>Intelligent Customer Support Platform</p>
  </div>
  <div class="body">${body}</div>
  <div class="footer">
    <p>This is an automated message from <strong>DeskFlow AI</strong>.<br>
    Need help? Visit <a href="${APP_URL}">${APP_URL}</a> or reply to this email.<br>
    © 2026 DeskFlow AI. All rights reserved.</p>
  </div>
</div>
</body>
</html>`;
}

function priorityBadge(p) {
  const cls = p === "High" ? "badge-high" : p === "Low" ? "badge-low" : "badge-medium";
  return `<span class="badge ${cls}">${p || "Medium"}</span>`;
}

// ─── Email 1: Ticket Created ──────────────────────────────────────────────────
async function sendTicketCreated({ ticketId, customerEmail, subject, category, priority, status }) {
  const shortId = (ticketId || "").substring(0, 8).toUpperCase();
  const html = wrap("Ticket Created — DeskFlow AI", `
    <h2>Your support ticket has been created ✅</h2>
    <p>Hi there! We've received your support request and our team will respond shortly. Here are your ticket details:</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">Ticket ID</span><span class="info-value">#${shortId}</span></div>
      <div class="info-row"><span class="info-label">Subject</span><span class="info-value">${subject}</span></div>
      <div class="info-row"><span class="info-label">Category</span><span class="info-value">${category || "General Inquiry"}</span></div>
      <div class="info-row"><span class="info-label">Priority</span><span class="info-value">${priorityBadge(priority)}</span></div>
      <div class="info-row"><span class="info-label">Status</span><span class="info-value"><span class="badge badge-open">${status || "Open"}</span></span></div>
    </div>
    <p>Our support agents are available <strong>Mon–Fri, 9 AM – 6 PM IST</strong>. High-priority tickets are addressed first.</p>
    <a class="btn" href="${APP_URL}/dashboard.html">View Your Ticket →</a>
  `);
  await send(customerEmail, `[DeskFlow AI] Ticket #${shortId} Created — ${subject}`, html);
}

// ─── Email 2: Ticket Assigned to Agent ───────────────────────────────────────
async function sendTicketAssigned({ ticketId, agentEmail, customerEmail, customerName, subject, category, priority }) {
  const shortId = (ticketId || "").substring(0, 8).toUpperCase();
  const html = wrap("New Ticket Assigned — DeskFlow AI", `
    <h2>A ticket has been assigned to you 📋</h2>
    <p>Hello Agent, a new support ticket requires your attention. Please review and respond as soon as possible.</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">Ticket ID</span><span class="info-value">#${shortId}</span></div>
      <div class="info-row"><span class="info-label">Subject</span><span class="info-value">${subject}</span></div>
      <div class="info-row"><span class="info-label">Customer</span><span class="info-value">${customerName || customerEmail}</span></div>
      <div class="info-row"><span class="info-label">Category</span><span class="info-value">${category || "General Inquiry"}</span></div>
      <div class="info-row"><span class="info-label">Priority</span><span class="info-value">${priorityBadge(priority)}</span></div>
    </div>
    <p>${priority === "High" ? "⚠️ <strong>This is a HIGH PRIORITY ticket.</strong> Please respond within 1 hour." : "Please respond within 4 business hours."}</p>
    <a class="btn" href="${APP_URL}/agent.html">Open Agent Dashboard →</a>
  `);
  await send(agentEmail, `[DeskFlow AI] Ticket #${shortId} Assigned — ${subject}`, html);
}

// ─── Email 3: Ticket Resolved ─────────────────────────────────────────────────
async function sendTicketResolved({ ticketId, customerEmail, agentName, subject }) {
  const shortId = (ticketId || "").substring(0, 8).toUpperCase();
  const html = wrap("Ticket Resolved — DeskFlow AI", `
    <h2>Your support ticket has been resolved ✨</h2>
    <p>Great news! Your support ticket has been resolved by our team. We hope the issue has been addressed to your satisfaction.</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">Ticket ID</span><span class="info-value">#${shortId}</span></div>
      <div class="info-row"><span class="info-label">Subject</span><span class="info-value">${subject}</span></div>
      <div class="info-row"><span class="info-label">Resolved By</span><span class="info-value">${agentName || "DeskFlow Support Team"}</span></div>
      <div class="info-row"><span class="info-label">Status</span><span class="info-value"><span class="badge badge-resolved">Resolved</span></span></div>
    </div>
    <p>Was this resolution helpful? Please take a moment to rate your experience — your feedback helps us improve!</p>
    <a class="btn" href="${APP_URL}/dashboard.html">Leave Feedback →</a>
    <p style="margin-top:16px;">If your issue was not fully resolved, you can <a href="${APP_URL}/dashboard.html" style="color:#6c63ff;">create a new ticket</a> or reply to this email.</p>
  `);
  await send(customerEmail, `[DeskFlow AI] Ticket #${shortId} Resolved — ${subject}`, html);
}

// ─── Email 4: Password Reset ──────────────────────────────────────────────────
async function sendPasswordReset({ email, resetToken }) {
  const resetLink = `${APP_URL}/signin.html?reset=${resetToken}&email=${encodeURIComponent(email)}`;
  const html = wrap("Password Reset — DeskFlow AI", `
    <h2>Password reset request 🔐</h2>
    <p>We received a request to reset the password for your DeskFlow AI account associated with <strong>${email}</strong>.</p>
    <p>Click the button below to reset your password. This link will expire in <strong>1 hour</strong>.</p>
    <a class="btn" href="${resetLink}">Reset My Password →</a>
    <div class="info-card" style="margin-top:24px;">
      <p style="color:#9090b0;font-size:13px;margin:0;">If you did not request a password reset, you can safely ignore this email. Your password will not be changed until you click the link above and create a new one.</p>
    </div>
    <p>For security, never share this link with anyone. DeskFlow AI staff will never ask for your password.</p>
  `);
  await send(email, "[DeskFlow AI] Password Reset Request", html);
}

// ─── Email 5: Welcome / New Account ──────────────────────────────────────────
async function sendWelcome({ email, name, role }) {
  const html = wrap("Welcome to DeskFlow AI 🚀", `
    <h2>Welcome, ${name || "there"}! 👋</h2>
    <p>Your DeskFlow AI account has been created successfully. You now have access to our intelligent customer support platform.</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">Email</span><span class="info-value">${email}</span></div>
      <div class="info-row"><span class="info-label">Role</span><span class="info-value" style="text-transform:capitalize;">${role || "customer"}</span></div>
      <div class="info-row"><span class="info-label">Portal</span><span class="info-value">DeskFlow AI Customer Support</span></div>
    </div>
    <p>You can now submit support tickets, track their progress, and chat with our Zia AI assistant anytime.</p>
    <a class="btn" href="${APP_URL}/dashboard.html">Go to Dashboard →</a>
  `);
  await send(email, "[DeskFlow AI] Welcome! Your account is ready", html);
}

// ─── Email: OTP Verification — Feature 18 ─────────────────────────────────────
async function sendOTPEmail({ email, code, action, expiresAt }) {
  const actionLabels = {
    block_user:     "Block User Account",
    delete_account: "Delete Account",
    grant_admin:    "Grant Admin Role",
    restore_user:   "Restore Blocked User",
    delete_kb:      "Delete Knowledge Base Article"
  };
  const html = wrap("Action Verification Code — DeskFlow AI", `
    <h2>Your Verification Code</h2>
    <p>You requested to perform a sensitive action: <strong>${actionLabels[action] || action}</strong></p>
    <p>Enter this code to proceed:</p>
    <div style="text-align:center;margin:24px 0">
      <span style="font-size:36px;font-weight:900;letter-spacing:8px;color:#D4AF37;background:#0a1f20;padding:16px 28px;border-radius:12px;display:inline-block">${code}</span>
    </div>
    <p>This code expires at <strong>${new Date(expiresAt).toLocaleString()}</strong> (10 minutes).</p>
    <p style="color:#e74c3c">If you did not request this, please contact your administrator immediately.</p>
  `);
  await send(email, "[DeskFlow AI] Action Verification Code", html);
}

module.exports = {
  sendTicketCreated,
  sendTicketAssigned,
  sendTicketResolved,
  sendPasswordReset,
  sendWelcome,
  sendOTPEmail
};
