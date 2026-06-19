/* DeskFlow AI — Extended Features JS
   Features: Timeline, Agent Availability, Priority Badge, Quality Score,
             Satisfaction Prediction, Translation, Internal Notes, KB Gen, Reports
*/
(function (w) {
  "use strict";

  // ─── Auth helper ──────────────────────────────────────────────────────────
  const tok = () => localStorage.getItem("deskflow_token") || "";
  const me  = () => { try { return JSON.parse(localStorage.getItem("deskflow_user") || "{}"); } catch { return {}; } };

  async function apiFetch(url, opts = {}) {
    const headers = { "Content-Type": "application/json", Authorization: "Bearer " + tok(), ...(opts.headers || {}) };
    const res = await fetch(url, { ...opts, headers });
    return res;
  }

  // ─── 1. Priority Badge ────────────────────────────────────────────────────
  const PRIORITY_COLORS = {
    Critical: "#e74c3c", High: "#e67e22", Medium: "#f1c40f", Low: "#2ecc71"
  };
  function priorityBadge(priority) {
    const color = PRIORITY_COLORS[priority] || "#888";
    return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-size:10.5px;font-weight:800;background:${color}22;color:${color};border:1px solid ${color}44">
      <i class="ti ti-flag" style="font-size:9px"></i>${priority || "Low"}
    </span>`;
  }
  w.dfPriorityBadge = priorityBadge;

  // ─── 2. Ticket Timeline Renderer ─────────────────────────────────────────
  function renderTimeline(containerId, timeline) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!timeline || !timeline.length) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px">No timeline events yet.</div>';
      return;
    }
    el.innerHTML = timeline.map((t, i) => `
      <div style="display:flex;gap:12px;position:relative;padding-bottom:${i < timeline.length - 1 ? "16px" : "0"}">
        ${i < timeline.length - 1 ? `<div style="position:absolute;left:15px;top:32px;bottom:0;width:2px;background:var(--border-dim)"></div>` : ""}
        <div style="width:30px;height:30px;border-radius:50%;background:${t.color || "var(--gold)"}22;border:2px solid ${t.color || "var(--gold)"}44;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px">
          <i class="ti ${t.icon || "ti-point"}" style="font-size:13px;color:${t.color || "var(--gold)"}"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px;font-weight:600;color:var(--text-primary)">${escH(t.note || t.type || "")}</div>
          <div style="display:flex;gap:8px;margin-top:2px;flex-wrap:wrap">
            <span style="font-size:10.5px;color:var(--text-muted)">${escH(t.actor || "system")}</span>
            <span style="font-size:10.5px;color:var(--text-muted)">&middot;</span>
            <span style="font-size:10.5px;color:var(--text-muted)">${t.timestamp ? new Date(t.timestamp).toLocaleString() : ""}</span>
          </div>
        </div>
      </div>
    `).join("");
  }
  w.dfRenderTimeline = renderTimeline;

  function escH(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // ─── 3. Agent Availability Widget ────────────────────────────────────────
  const STATUS_ICONS = {
    online:     { icon: "ti-circle-check", color: "#2ecc71", label: "Online" },
    busy:       { icon: "ti-clock",        color: "#e67e22", label: "Busy" },
    in_meeting: { icon: "ti-video",        color: "#3498db", label: "In Meeting" },
    offline:    { icon: "ti-circle-x",     color: "#7f8c8d", label: "Offline" }
  };

  async function loadAgentAvailability(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Loading agents…</div>';
    try {
      const r = await apiFetch("/api/agents/availability");
      const d = await r.json();
      const agents = d.agents || [];
      if (!agents.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px">No agents available.</div>'; return; }
      el.innerHTML = agents.map(a => {
        const s = STATUS_ICONS[a.status] || STATUS_ICONS.offline;
        return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border-dim)">
          <div style="width:32px;height:32px;border-radius:50%;background:var(--glass);border:2px solid ${s.color}44;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--gold);flex-shrink:0">${(a.name||"A").charAt(0).toUpperCase()}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escH(a.name||a.email)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${escH(a.department||"")}</div>
          </div>
          <span style="display:flex;align-items:center;gap:4px;font-size:10.5px;color:${s.color};white-space:nowrap">
            <i class="ti ${s.icon}" style="font-size:11px"></i>${s.label}
          </span>
        </div>`;
      }).join("");
    } catch {
      el.innerHTML = '<div style="color:var(--danger);font-size:12px">Could not load agent availability.</div>';
    }
  }
  w.dfLoadAgentAvailability = loadAgentAvailability;

  // Set own availability (for agent pages)
  async function setAgentStatus(status) {
    try {
      await apiFetch("/api/agents/availability", { method: "PUT", body: JSON.stringify({ status }) });
      await apiFetch("/api/agents/heartbeat", { method: "POST" });
    } catch { /* non-fatal */ }
  }
  w.dfSetAgentStatus = setAgentStatus;

  // Heartbeat every 3 minutes for agents
  function startAgentHeartbeat() {
    const user = me();
    if (user.role !== "agent" && user.role !== "admin") return;
    const ping = () => apiFetch("/api/agents/heartbeat", { method: "POST" }).catch(() => {});
    ping();
    setInterval(ping, 3 * 60 * 1000);
  }
  w.dfStartAgentHeartbeat = startAgentHeartbeat;

  // ─── 4. Quality Score Renderer ────────────────────────────────────────────
  async function evaluateAndShowQuality(responseText, context, containerId) {
    const el = document.getElementById(containerId);
    if (!el || !responseText) return;
    el.innerHTML = '<span style="font-size:11px;color:var(--text-muted)"><i class="ti ti-loader-2" style="animation:spin .8s linear infinite;display:inline-block"></i> Evaluating…</span>';
    try {
      const r = await apiFetch("/api/ai/quality-score", {
        method: "POST",
        body: JSON.stringify({ response: responseText, context })
      });
      const d = await r.json();
      const grade = d.grade || "B";
      const gradeColor = { A:"#2ecc71", B:"#3498db", C:"#f1c40f", D:"#e67e22", F:"#e74c3c" }[grade] || "#888";
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--glass);border-radius:10px;border:1px solid var(--border-dim)">
          <div style="width:40px;height:40px;border-radius:50%;background:${gradeColor}22;border:2px solid ${gradeColor};display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;color:${gradeColor};flex-shrink:0">${grade}</div>
          <div style="flex:1">
            <div style="font-size:12px;font-weight:700;color:var(--text-primary)">Response Quality: ${d.overall || 0}/100</div>
            <div style="display:flex;gap:8px;margin-top:3px;flex-wrap:wrap">
              ${["professionalism","grammar","friendliness","completeness"].map(k =>
                `<span style="font-size:10px;color:var(--text-muted)">${k.charAt(0).toUpperCase()+k.slice(1)}: ${d[k]||0}</span>`
              ).join('<span style="color:var(--border)">·</span>')}
            </div>
            ${d.feedback ? `<div style="font-size:11px;color:var(--gold);margin-top:4px">${escH(d.feedback)}</div>` : ""}
          </div>
        </div>`;
    } catch {
      el.innerHTML = '<span style="font-size:11px;color:var(--danger)">Could not evaluate quality.</span>';
    }
  }
  w.dfEvaluateQuality = evaluateAndShowQuality;

  // ─── 5. Satisfaction Prediction ───────────────────────────────────────────
  async function predictSatisfaction(ticketId, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<span style="font-size:11px;color:var(--text-muted)"><i class="ti ti-loader-2" style="animation:spin .8s linear infinite;display:inline-block"></i> Predicting…</span>';
    try {
      const r = await apiFetch(`/api/tickets/${ticketId}/satisfaction-predict`, { method: "POST" });
      const d = await r.json();
      const starColor = d.predictedRating >= 4 ? "var(--success)" : d.predictedRating >= 3 ? "var(--warning)" : "var(--danger)";
      el.innerHTML = `
        <div style="padding:10px;background:var(--glass);border-radius:10px;border:1px solid var(--border-dim)">
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Predicted Satisfaction</div>
          <div style="font-size:20px;color:${starColor}">${d.stars || "★★★☆☆"}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px">Confidence: ${d.confidence || 0}%</div>
          ${d.suggestions?.length ? `<div style="margin-top:6px">${d.suggestions.map(s =>
            `<div style="font-size:11px;color:var(--gold);display:flex;align-items:center;gap:4px"><i class="ti ti-bulb" style="font-size:10px"></i> ${escH(s)}</div>`
          ).join("")}</div>` : ""}
        </div>`;
    } catch {
      el.innerHTML = '<span style="font-size:11px;color:var(--danger)">Prediction unavailable.</span>';
    }
  }
  w.dfPredictSatisfaction = predictSatisfaction;

  // ─── 6. Translation Widget ────────────────────────────────────────────────
  async function translateMessage(text, targetLang, callback) {
    try {
      const r = await apiFetch("/api/ai/translate", {
        method: "POST",
        body: JSON.stringify({ text, targetLang })
      });
      const d = await r.json();
      if (callback) callback(d.translated, d.detectedLang);
      return d;
    } catch {
      if (callback) callback(text, "unknown");
      return { translated: text };
    }
  }
  w.dfTranslate = translateMessage;

  // ─── 7. Reputation Badge ─────────────────────────────────────────────────
  const REP_TIERS = {
    Trusted:    { color: "#2ecc71", icon: "ti-shield-check" },
    Standard:   { color: "#3498db", icon: "ti-shield" },
    Caution:    { color: "#e67e22", icon: "ti-shield-half" },
    Restricted: { color: "#e74c3c", icon: "ti-shield-x" }
  };
  function reputationBadge(score, tier) {
    const t = REP_TIERS[tier] || REP_TIERS.Standard;
    return `<span title="Reputation Score: ${score}" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:700;background:${t.color}15;color:${t.color};border:1px solid ${t.color}33">
      <i class="ti ${t.icon}" style="font-size:10px"></i>${tier} (${score})
    </span>`;
  }
  w.dfReputationBadge = reputationBadge;

  // ─── 8. Internal Notes ───────────────────────────────────────────────────
  async function loadInternalNotes(ticketId, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    try {
      const r = await apiFetch(`/api/agents/tickets/${ticketId}/notes`);
      const d = await r.json();
      const notes = d.notes || [];
      if (!notes.length) {
        el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">No internal notes yet.</div>';
        return;
      }
      el.innerHTML = notes.map(n => `
        <div style="background:rgba(243,156,18,.06);border:1px solid rgba(243,156,18,.15);border-radius:10px;padding:10px;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <i class="ti ti-lock" style="font-size:11px;color:var(--warning)"></i>
            <span style="font-size:11px;font-weight:700;color:var(--warning)">Internal Note</span>
            <span style="font-size:10.5px;color:var(--text-muted);margin-left:auto">${escH(n.authorName||n.author)} · ${n.timestamp ? new Date(n.timestamp).toLocaleString() : ""}</span>
          </div>
          <div style="font-size:13px;color:var(--text-secondary)">${escH(n.text)}</div>
        </div>`
      ).join("");
    } catch {
      el.innerHTML = '<div style="color:var(--danger);font-size:12px">Could not load notes.</div>';
    }
  }
  w.dfLoadInternalNotes = loadInternalNotes;

  async function addInternalNote(ticketId, text, containerId) {
    if (!text.trim()) return;
    try {
      await apiFetch(`/api/agents/tickets/${ticketId}/notes`, {
        method: "POST",
        body: JSON.stringify({ text })
      });
      await loadInternalNotes(ticketId, containerId);
    } catch { /* non-fatal */ }
  }
  w.dfAddInternalNote = addInternalNote;

  // ─── 9. KB Generator ─────────────────────────────────────────────────────
  async function generateKBFromTicket(ticketId, resolution, publish, onSuccess) {
    try {
      const r = await apiFetch(`/api/tickets/${ticketId}/kb-generate`, {
        method: "POST",
        body: JSON.stringify({ resolution, publishImmediately: publish })
      });
      const d = await r.json();
      if (onSuccess) onSuccess(d);
      return d;
    } catch (err) {
      return { error: err.message };
    }
  }
  w.dfGenerateKB = generateKBFromTicket;

  // ─── 10. OTP Flow ────────────────────────────────────────────────────────
  async function requestOTP(action) {
    try {
      const r = await apiFetch("/api/admin/otp/request", { method: "POST", body: JSON.stringify({ action }) });
      const d = await r.json();
      return d;
    } catch {
      return { error: "OTP request failed" };
    }
  }
  async function verifyOTP(action, otp) {
    try {
      const r = await apiFetch("/api/admin/otp/verify", { method: "POST", body: JSON.stringify({ action, otp }) });
      const d = await r.json();
      return d;
    } catch {
      return { valid: false, message: "OTP verification failed" };
    }
  }
  w.dfRequestOTP = requestOTP;
  w.dfVerifyOTP  = verifyOTP;

  // ─── 11. File Attachment Scanner ─────────────────────────────────────────
  async function scanFile(file, onResult) {
    try {
      const r = await apiFetch("/api/agents/scan-file", {
        method: "POST",
        body: JSON.stringify({
          fileName:    file.name,
          fileSizeMB:  parseFloat((file.size / 1048576).toFixed(2)),
          mimeType:    file.type
        })
      });
      const d = await r.json();
      if (onResult) onResult(d);
      return d;
    } catch {
      const fallback = { safe: true, issues: [] };
      if (onResult) onResult(fallback);
      return fallback;
    }
  }
  w.dfScanFile = scanFile;

})(window);
