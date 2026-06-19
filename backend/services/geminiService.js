// backend/services/geminiService.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

const API_KEY = process.env.GEMINI_API_KEY || "";
let genAI = null;

if (API_KEY) {
  genAI = new GoogleGenerativeAI(API_KEY);
} else {
  console.warn("[GeminiService] GEMINI_API_KEY not set — falling back to rule-based AI.");
}

const SYSTEM_PROMPT = `You are Zia, a senior customer support specialist at DeskFlow — a modern SaaS platform for AI-powered customer support ticketing and team management.

YOUR PRIMARY JOB: Solve the customer's problem directly and efficiently in every single response.

CRITICAL RULES:
1. NEVER respond with a vague "please describe your issue" when the customer already described their problem. Read what they wrote and give a direct solution.
2. Lead with the SOLUTION first. Be action-oriented, not sympathy-first.
3. Use numbered steps for any process (reset, fix, setup, etc.).
4. Be warm and conversational — not robotic or overly formal.
5. For simple fixes: keep responses under 100 words. For step-by-step guides: be as detailed as needed.
6. If you truly need more info, ask ONE specific targeted question — never a vague "can you describe the issue?"
7. Always end with: "Is there anything else I can help you with, or would you like me to connect you with a live agent?"

DESKFLOW PRODUCT KNOWLEDGE:
- Password reset: "Forgot Password" link on the sign-in page → reset email arrives in 2 minutes (check spam too)
- Account locked: open a support ticket with your email, agents unlock within 1 hour
- Billing/Invoices: Dashboard → Billing section; 14-day money-back guarantee on all plans
- Refund requests: open a ticket (Category: Billing Issue) with invoice number → processed in 2 business days
- Support tickets: Dashboard → Support Tickets → Create New; agents respond within 2 hours
- Integrations: reconnect in Settings → Integrations; check that API keys haven't expired
- Feature questions: use FAQ Search in the left menu for step-by-step guides
- Validation errors: usually caused by expired session, incorrect field format, or permission issues`;

/**
 * Chat with Gemini — maintains conversation history context.
 * Falls back to rule-based reply if API key is missing.
 */
async function geminiChat(userMessage, history = [], lang = "en-US") {
  const langInstructions = {
    "hi-IN": " IMPORTANT: You MUST respond entirely in Hindi (हिन्दी). Write your complete reply in Hindi script only.",
    "ta-IN": " IMPORTANT: You MUST respond entirely in Tamil (தமிழ்). Write your complete reply in Tamil script only."
  };
  const systemPromptFinal = SYSTEM_PROMPT + (langInstructions[lang] || "");

  if (!genAI) {
    console.log("[GeminiService] No API key — using fallback for:", userMessage.substring(0, 60));
    return fallbackChat(userMessage);
  }

  // Try models in order — newer first, fallback to stable versions
  const MODELS_TO_TRY = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-latest"];

  for (const modelName of MODELS_TO_TRY) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPromptFinal
      });

      const formattedHistory = [];
      for (let i = 0; i + 1 < history.length; i += 2) {
        const u = history[i];
        const m = history[i + 1];
        if (u && m && u.role === "user" && m.role === "model") {
          formattedHistory.push(
            { role: "user",  parts: [{ text: u.text || "" }] },
            { role: "model", parts: [{ text: m.text || "" }] }
          );
        }
      }

      console.log(`[GeminiService] Trying model: ${modelName} | message: ${userMessage.substring(0, 60)}`);

      const chat = model.startChat({
        history: formattedHistory,
        generationConfig: { maxOutputTokens: 500, temperature: 0.7 }
      });

      const result = await chat.sendMessage(userMessage);
      const text = result.response.text();

      if (!text || !text.trim()) {
        console.warn(`[GeminiService] Empty response from ${modelName}`);
        continue;
      }

      console.log(`[GeminiService] Success with ${modelName}:`, text.trim().substring(0, 80));
      return { reply: text.trim(), source: "gemini", model: modelName };

    } catch (err) {
      console.error(`[GeminiService] Model ${modelName} failed:`, err.message);
    }
  }

  console.error("[GeminiService] All models failed — using smart fallback.");
  return fallbackChat(userMessage);
}

/**
 * Analyze sentiment using Gemini — returns Positive / Neutral / Negative + score + explanation.
 */
async function geminiSentiment(text) {
  if (!genAI) {
    return fallbackSentiment(text);
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Analyze the sentiment of this customer support message.
Respond ONLY with valid JSON: {"sentiment":"Positive"|"Neutral"|"Negative","score":0-100,"emoji":"😊"|"😐"|"😠","explanation":"one sentence"}

Message: "${text}"`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
    return { ...JSON.parse(raw), source: "gemini" };
  } catch (err) {
    console.error("[GeminiService] Sentiment error:", err.message);
    return fallbackSentiment(text);
  }
}

/**
 * Categorize a support ticket using Gemini.
 */
async function geminiCategorize(subject, description) {
  if (!genAI) {
    return fallbackCategorize(subject, description);
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Classify this support ticket into exactly ONE category.
Categories: "Technical Issue" | "Billing Issue" | "Account Issue" | "Feature Request" | "General Inquiry"
Respond ONLY with valid JSON: {"category":"...","confidence":0-100,"reason":"one sentence"}

Subject: "${subject}"
Description: "${description}"`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
    return { ...JSON.parse(raw), source: "gemini" };
  } catch (err) {
    console.error("[GeminiService] Categorize error:", err.message);
    return fallbackCategorize(subject, description);
  }
}

/**
 * Generate suggested agent responses using Gemini.
 */
async function geminiSuggestResponses(ticketContext) {
  if (!genAI) {
    return fallbackSuggest(ticketContext);
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `You are a customer support expert. Generate 3 professional response suggestions for a support agent.
Respond ONLY with valid JSON: {"suggestions":["response1","response2","response3"]}

Ticket context:
Category: ${ticketContext.category}
Sentiment: ${ticketContext.sentiment}
Subject: ${ticketContext.subject}
Description: ${ticketContext.description}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
    return { ...JSON.parse(raw), source: "gemini" };
  } catch (err) {
    console.error("[GeminiService] Suggest error:", err.message);
    return fallbackSuggest(ticketContext);
  }
}

/**
 * Search FAQ / KB using Gemini to match the best answer.
 */
async function geminiFaqSearch(query, articles = []) {
  if (!genAI || articles.length === 0) {
    return { answer: null, source: "none" };
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const articleText = articles.map((a, i) => `[${i}] Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
    const prompt = `Given these FAQ articles:\n${articleText}\n\nAnswer this customer question concisely (under 80 words): "${query}"\nIf no article matches, reply with "I don't have specific information on that. Please contact support."`;

    const result = await model.generateContent(prompt);
    return { answer: result.response.text(), source: "gemini" };
  } catch (err) {
    console.error("[GeminiService] FAQ error:", err.message);
    return { answer: null, source: "error" };
  }
}

// ─── Fallback rule-based implementations ────────────────────────────────────

function fallbackChat(message) {
  const clean = (message || "").toLowerCase();

  // Greetings
  if (/\bhello\b|\bhi\b|\bhey\b|\bgreetings\b/.test(clean) && clean.length < 30) {
    return { reply: "Hello! I'm Zia, your DeskFlow AI Assistant. I can help with account issues, billing, technical errors, integrations, and more. What can I help you with today?", source: "fallback" };
  }

  // Password
  if (/\bpassword\b/.test(clean)) {
    return { reply: "To reset your password:\n1. Go to the Sign-In page\n2. Click \"Forgot Password\"\n3. Enter your registered email — a reset link arrives in ~2 minutes\n4. Check your spam folder if you don't see it\n\nStill locked out after that? Open a support ticket and an agent will manually reset your account within 1 hour.", source: "fallback" };
  }

  // Login / Access
  if (/\blogin\b|\bsign.?in\b|\baccess\b|\blocked\b|\bunlock\b|\bauthentication\b/.test(clean)) {
    return { reply: "Login issues are usually fixed by one of these steps:\n1. Use \"Forgot Password\" on the sign-in page to reset your credentials\n2. Clear your browser cache and cookies, then retry\n3. Try an incognito/private browser window\n\nIf none of these work, open a support ticket with your registered email and the exact error message you see.", source: "fallback" };
  }

  // Refund
  if (/\brefund\b/.test(clean)) {
    return { reply: "We offer a 14-day money-back guarantee. Here's how to request a refund:\n1. Go to Dashboard → Support Tickets → Create New\n2. Set Category to \"Billing Issue\"\n3. Write \"Refund Request\" in the subject with your invoice number\n\nOur billing team processes refunds within 2 business days and confirms via email.", source: "fallback" };
  }

  // Billing / Payment
  if (/\bbilling\b|\bpayment\b|\binvoice\b|\bcharge\b|\bsubscription\b|\bplan\b/.test(clean)) {
    return { reply: "For billing concerns:\n- View invoices: Dashboard → Billing\n- Wrong charge: open a ticket (Category: Billing Issue) with your invoice number — resolved in 2 business days\n- Change/cancel plan: Dashboard → Settings → Subscription\n\nWhat specifically is the issue with your billing? I can point you directly to the right step.", source: "fallback" };
  }

  // Validation errors
  if (/\bvalidat/.test(clean)) {
    return { reply: "Validation errors are usually caused by:\n1. An expired session — sign out and sign back in, then retry\n2. A required field left empty or in the wrong format\n3. Insufficient permissions on your account role\n\nPlease note the exact error message and which screen it appeared on, then open a support ticket — our tech team will fix it within 2 hours.", source: "fallback" };
  }

  // Return / Provider issues
  if (/\breturn\b|\bprovider\b/.test(clean)) {
    return { reply: "For return or provider validation issues:\n1. Re-authenticate the provider in Settings → Integrations\n2. Check if the connected API key or credentials have expired\n3. Verify your account has the right permissions for that action\n\nIf the provider is still not validating, open a support ticket with the provider name and the exact error — our team will escalate it on your behalf.", source: "fallback" };
  }

  // Integration
  if (/\bintegrat|\bconnect\b|\bapi\b|\bwebhook\b/.test(clean)) {
    return { reply: "For integration issues:\n1. Go to Settings → Integrations and re-connect the service\n2. Make sure your API key/token hasn't expired — regenerate if needed\n3. Check that the integration has the correct permissions in both DeskFlow and the third-party platform\n\nStill not working? Open a ticket with the integration name and error details — tech team responds within 1 hour for integration issues.", source: "fallback" };
  }

  // Technical/Bug/Error
  if (/\bbug\b|\berror\b|\bcrash\b|\bbroken\b|\bnot work|\bissue\b|\bproblem\b|\bfail|\bwrong\b/.test(clean)) {
    return { reply: "To fix this quickly, I need a couple of details:\n1. What is the exact error message you see?\n2. Which page/feature were you using when it happened?\n3. Does it happen every time or only sometimes?\n\nYou can share this by opening a support ticket — our engineering team is notified immediately for errors and typically responds within 1 hour.", source: "fallback" };
  }

  // Feature / How-to questions
  if (/\bhow\b|\bwhat is\b|\bhow do\b|\bcan i\b|\bfeature\b|\bwhere\b/.test(clean)) {
    return { reply: "Great question! DeskFlow features include: AI-powered ticket management, real-time sentiment analysis, smart reply suggestions, a full knowledge base, conversation history, and analytics dashboards.\n\nFor step-by-step guides, check the FAQ Search section in the left menu — it's searchable and covers most common tasks. What specific feature are you asking about?", source: "fallback" };
  }

  // Agent / escalation request
  if (/\bspeak to\b|\btalk to\b|\bhuman\b|\bagent\b|\bescalat|\bperson\b|\bsupport team\b/.test(clean)) {
    return { reply: "I'll get you to a live agent right away. Here's the fastest way:\n1. Dashboard → Support Tickets → Create New\n2. Write \"URGENT — Needs Agent\" in the subject\n3. An agent will be assigned within 15 minutes during business hours (9AM–6PM IST, Mon–Sat)\n\nFor off-hours issues, we guarantee a response within 2 hours.", source: "fallback" };
  }

  // Default — still helpful
  return { reply: "I want to make sure I give you the right solution. Based on what you've shared, this sounds like it could be a technical or account issue.\n\nCould you tell me: are you seeing a specific error message, or is a feature simply not behaving as expected? That one detail will let me give you the exact fix rather than a general answer.", source: "fallback" };
}

function fallbackSentiment(text) {
  const clean = (text || "").toLowerCase();
  const neg = ["urgent","broken","fail","error","crash","refund","worst","angry","frustrated","bug","terrible","hate","cannot","useless","disappointed"];
  const pos = ["thanks","thank you","great","awesome","perfect","good","happy","love","excellent","solved","helpful","appreciate"];
  let score = 0;
  neg.forEach(kw => { if (clean.includes(kw)) score -= 1; });
  pos.forEach(kw => { if (clean.includes(kw)) score += 1; });
  if (score < 0) return { sentiment: "Negative", score: 20, emoji: "😠", explanation: "Message contains negative indicators.", source: "fallback" };
  if (score > 0) return { sentiment: "Positive", score: 85, emoji: "😊", explanation: "Message contains positive indicators.", source: "fallback" };
  return { sentiment: "Neutral", score: 50, emoji: "😐", explanation: "No strong sentiment detected.", source: "fallback" };
}

function fallbackCategorize(subject = "", description = "") {
  const text = `${subject} ${description}`.toLowerCase();
  if (["invoice","billing","payment","charge","refund","subscription"].some(k => text.includes(k)))
    return { category: "Billing Issue", confidence: 80, reason: "Billing keywords detected.", source: "fallback" };
  if (["login","password","reset","locked","access","account"].some(k => text.includes(k)))
    return { category: "Account Issue", confidence: 80, reason: "Account keywords detected.", source: "fallback" };
  if (["api","bug","error","crash","slow","broken","server"].some(k => text.includes(k)))
    return { category: "Technical Issue", confidence: 80, reason: "Technical keywords detected.", source: "fallback" };
  if (["feature","request","suggest","improve","add"].some(k => text.includes(k)))
    return { category: "Feature Request", confidence: 70, reason: "Feature request keywords detected.", source: "fallback" };
  return { category: "General Inquiry", confidence: 60, reason: "No specific category detected.", source: "fallback" };
}

function fallbackSuggest({ category, sentiment }) {
  const suggestions = [];
  if (sentiment === "Negative") suggestions.push("I sincerely apologize for the inconvenience. Let me look into this immediately.");
  if (category === "Billing Issue") {
    suggestions.push("I've reviewed your billing details and will process the correction right away. Could you confirm the invoice number?");
    suggestions.push("Our billing team will contact you within 1 business day to resolve this matter.");
  } else if (category === "Account Issue") {
    suggestions.push("I've sent a password reset link to your registered email. Please check your inbox and spam folder.");
    suggestions.push("Your account has been unlocked. Please try logging in again and let us know if you face further issues.");
  } else if (category === "Technical Issue") {
    suggestions.push("Could you share your browser version and any error messages you're seeing? This will help us diagnose the issue faster.");
    suggestions.push("Our engineering team has been notified and is actively investigating. We'll update you within 2 hours.");
  } else {
    suggestions.push("Thank you for contacting DeskFlow support. I'm looking into your request and will respond shortly.");
    suggestions.push("Could you provide more details so I can assign this to the right department?");
  }
  return { suggestions, source: "fallback" };
}

/**
 * Deep ticket analysis — returns priority, category, department, urgency, expertise, sentiment, keywords.
 */
async function geminiAnalyzeTicket(subject, description, customerContext = {}) {
  if (!genAI) return fallbackAnalyzeTicket(subject, description);
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const historyText = (customerContext.recentTickets || []).length
      ? `\nPrevious tickets from this customer:\n` +
        customerContext.recentTickets.slice(0, 5).map((t, i) =>
          `  ${i + 1}. [${t.priority || "Low"}] ${t.subject} — ${t.status} (${t.category || ""})`
        ).join("\n")
      : "";

    const reputationText = customerContext.reputation
      ? `\nCustomer reputation score: ${customerContext.reputation.score}/100 (${customerContext.reputation.tier})`
      : "";

    const prompt = `Analyze this customer support ticket thoroughly.
${reputationText}${historyText}

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "category":"Technical Issue"|"Billing Issue"|"Account Issue"|"Feature Request"|"General Inquiry",
  "department":"Technical Support"|"Billing"|"Account Management"|"Product"|"General Support",
  "priority":"Critical"|"High"|"Medium"|"Low",
  "priorityReason":"one sentence explaining why this priority was chosen",
  "urgency":"Critical"|"High"|"Medium"|"Low",
  "expertise":["skill1","skill2"],
  "sentiment":"Positive"|"Neutral"|"Negative",
  "sentimentScore":0-100,
  "keywords":["kw1","kw2","kw3"],
  "fraudRisk":"none"|"low"|"medium"|"high",
  "summary":"one sentence AI analysis summary",
  "requiredExpertise":"specific technical skill or domain needed"
}

Subject: "${subject}"
Description: "${description}"`;

    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim().replace(/```json|```/g, "").trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error("[Gemini] analyzeTicket error:", err.message);
    return fallbackAnalyzeTicket(subject, description);
  }
}

function fallbackAnalyzeTicket(subject, description) {
  const cat = fallbackCategorize(subject, description);
  const sen = fallbackSentiment(`${subject} ${description}`);
  const text = `${subject} ${description}`.toLowerCase();
  let priority = "Low";
  if (["urgent","critical","emergency","outage","down"].some(k => text.includes(k))) priority = "Critical";
  else if (["error","broken","fail","crash","urgent"].some(k => text.includes(k))) priority = "High";
  else if (["issue","problem","not working"].some(k => text.includes(k))) priority = "Medium";
  return {
    category: cat.category, department: "General Support", priority,
    urgency: priority, expertise: [cat.category],
    sentiment: sen.sentiment, sentimentScore: sen.score,
    keywords: [], fraudRisk: "none", summary: subject
  };
}

/**
 * Translate text to a target language.
 */
async function geminiTranslate(text, targetLang, sourceLang = "auto") {
  if (!genAI) return { translated: text, detectedLang: sourceLang, source: "none" };
  try {
    const model  = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Translate the following text to ${targetLang}. ${sourceLang !== "auto" ? `Source language: ${sourceLang}.` : "Auto-detect source language."}
Respond ONLY with valid JSON: {"translated":"...","detectedLang":"...","confidence":0-100}

Text: "${text}"`;
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim().replace(/```json|```/g, "").trim();
    return { ...JSON.parse(raw), source: "gemini" };
  } catch (err) {
    console.error("[Gemini] translate error:", err.message);
    return { translated: text, detectedLang: sourceLang, source: "error" };
  }
}

/**
 * Evaluate response quality with detailed scoring.
 */
async function geminiEvaluateQuality(response, context = {}) {
  if (!genAI) return fallbackEvaluateQuality(response);
  try {
    const model  = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Evaluate this customer support response for quality.
Respond ONLY with valid JSON:
{
  "overall":0-100,
  "professionalism":0-100,
  "grammar":0-100,
  "friendliness":0-100,
  "completeness":0-100,
  "feedback":"brief improvement suggestion",
  "grade":"A"|"B"|"C"|"D"|"F"
}

Context: ${JSON.stringify(context)}
Response: "${response}"`;
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim().replace(/```json|```/g, "").trim();
    return { ...JSON.parse(raw), source: "gemini" };
  } catch (err) {
    console.error("[Gemini] quality error:", err.message);
    return fallbackEvaluateQuality(response);
  }
}

function fallbackEvaluateQuality(response) {
  const text  = (response || "").trim();
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;

  // Professionalism: greeting, proper closing, no slang
  const hasGreeting   = /^(hi|hello|dear|good (morning|afternoon|evening)|thank you for)/i.test(text);
  const hasClosing    = /\b(regards|sincerely|thank you|please (let me|feel free)|i hope|don't hesitate)\b/i.test(lower);
  const hasSlang      = /\b(gonna|wanna|kinda|lol|omg|btw|asap)\b/i.test(lower);
  const professionalism = Math.min(100, 55 + (hasGreeting ? 15 : 0) + (hasClosing ? 20 : 0) - (hasSlang ? 15 : 0));

  // Grammar: punctuation, capitalization, sentence length
  const endsWithPunct    = /[.!?]$/.test(text);
  const startsWithCap    = /^[A-Z]/.test(text);
  const avgWordLen       = text.replace(/\s+/g, "").length / (words || 1);
  const grammar = Math.min(100, 55 + (endsWithPunct ? 15 : 0) + (startsWithCap ? 15 : 0) + (avgWordLen > 3 && avgWordLen < 8 ? 10 : 0));

  // Friendliness: empathy words, positive tone
  const hasEmpathy  = /\b(sorry|apologize|understand|appreciate|happy to|glad|pleasure|certainly|absolutely)\b/i.test(lower);
  const hasPositive = /\b(great|excellent|perfect|wonderful|pleased|delighted)\b/i.test(lower);
  const friendliness = Math.min(100, 55 + (hasEmpathy ? 25 : 0) + (hasPositive ? 10 : 0) + (hasClosing ? 10 : 0));

  // Completeness: length, steps, solution keywords
  const hasSteps    = /(\d\.|step \d|first|second|then|finally|next)/i.test(lower);
  const hasSolution = /\b(please|try|click|go to|navigate|check|verify|ensure|follow|enter|select)\b/i.test(lower);
  const lengthScore = words < 10 ? 30 : words < 25 ? 55 : words < 60 ? 80 : words < 150 ? 90 : 75;
  const completeness = Math.min(100, Math.round(lengthScore * 0.5 + (hasSteps ? 20 : 0) + (hasSolution ? 20 : 0) + (hasClosing ? 10 : 0)));

  const overall = Math.round((professionalism + grammar + friendliness + completeness) / 4);
  const grade   = overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 65 ? "C" : overall >= 50 ? "D" : "F";

  const tips = [];
  if (!hasGreeting)    tips.push("start with a greeting");
  if (!hasEmpathy)     tips.push("add empathy (e.g. 'I understand…')");
  if (!hasSolution)    tips.push("include actionable steps");
  if (words < 20)      tips.push("expand the response");
  if (!hasClosing)     tips.push("add a polite closing");
  if (!endsWithPunct)  tips.push("end with proper punctuation");

  return {
    overall,
    professionalism,
    grammar,
    friendliness,
    completeness,
    grade,
    feedback: tips.length ? "Improve: " + tips.slice(0, 3).join(", ") + "." : "Well-structured response!",
    source: "local"
  };
}

/**
 * Predict customer satisfaction rating (1-5 stars) before ticket closure.
 */
async function geminiPredictSatisfaction(ticket) {
  if (!genAI) {
    const s = ticket.sentiment === "Positive" ? 4 : ticket.sentiment === "Negative" ? 2 : 3;
    return { predictedRating: s, stars: "★".repeat(s) + "☆".repeat(5 - s), confidence: 55, suggestions: [], source: "none" };
  }
  try {
    const model  = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Predict the customer satisfaction rating for this resolved support ticket.
Respond ONLY with valid JSON:
{
  "predictedRating":1-5,
  "stars":"e.g. ★★★★☆",
  "confidence":0-100,
  "reasoning":"one sentence",
  "suggestions":["improvement1","improvement2"]
}

Ticket: ${JSON.stringify({
  subject:     ticket.subject,
  sentiment:   ticket.sentiment,
  priority:    ticket.priority,
  messageCount:(ticket.messages||[]).length,
  resolutionTime: ticket.updatedAt && ticket.createdAt
    ? Math.round((new Date(ticket.updatedAt) - new Date(ticket.createdAt)) / 3600000) + "h"
    : "unknown"
})}`;
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim().replace(/```json|```/g, "").trim();
    return { ...JSON.parse(raw), source: "gemini" };
  } catch (err) {
    console.error("[Gemini] satisfaction error:", err.message);
    const s = 3;
    return { predictedRating: s, stars: "★★★☆☆", confidence: 50, suggestions: [], source: "error" };
  }
}

/**
 * Detect fraud/spam in ticket content.
 */
async function geminiDetectFraud(subject, description, email) {
  if (!genAI) return { isFraud: false, confidence: 0, reason: "" };
  try {
    const model  = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Is this customer support ticket fraudulent, spam, or bot-generated?
Respond ONLY with valid JSON: {"isFraud":true|false,"confidence":0-100,"reason":"brief explanation","type":"spam"|"bot"|"duplicate"|"abuse"|"none"}

Subject: "${subject}"
Description: "${description}"
Email: "${email}"`;
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim().replace(/```json|```/g, "").trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error("[Gemini] fraud detection error:", err.message);
    return { isFraud: false, confidence: 0, reason: "" };
  }
}

/**
 * Generate a Knowledge Base article from a resolved ticket.
 */
async function geminiGenerateKB(ticket, resolution) {
  if (!genAI) {
    return { question: ticket.subject, answer: resolution, category: ticket.category || "General Inquiry", tags: [] };
  }
  try {
    const model  = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Generate a professional Knowledge Base FAQ article from this resolved support ticket.
Respond ONLY with valid JSON:
{
  "question":"Clear, general question heading",
  "answer":"Step-by-step solution (use numbered lists where appropriate)",
  "category":"${ticket.category || "General Inquiry"}",
  "tags":["tag1","tag2","tag3"],
  "summary":"one-line summary for search results"
}

Ticket Subject: "${ticket.subject}"
Ticket Description: "${ticket.description}"
Resolution: "${resolution}"`;
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim().replace(/```json|```/g, "").trim();
    return { ...JSON.parse(raw), source: "gemini" };
  } catch (err) {
    console.error("[Gemini] KB generate error:", err.message);
    return { question: ticket.subject, answer: resolution, category: ticket.category || "General Inquiry", tags: [], source: "error" };
  }
}

/**
 * Generate AI recommendations for a weekly report.
 */
async function geminiWeeklyReport(reportData) {
  if (!genAI) return { recommendations: ["Increase agent coverage during peak hours.", "Follow up on pending tickets."] };
  try {
    const model  = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Based on this weekly support report, provide 3-5 actionable recommendations.
Respond ONLY with valid JSON: {"recommendations":["rec1","rec2","rec3"]}

Report Summary: ${JSON.stringify({
  totalCreated:    reportData.totalCreated,
  totalResolved:   reportData.totalResolved,
  resolutionRate:  reportData.resolutionRate,
  avgSatisfaction: reportData.avgSatisfaction,
  categoryBreakdown: reportData.categoryBreakdown
})}`;
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim().replace(/```json|```/g, "").trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error("[Gemini] weekly report error:", err.message);
    return { recommendations: ["Review unresolved tickets.", "Follow up with low-satisfaction customers."] };
  }
}

module.exports = {
  geminiChat,
  geminiSentiment,
  geminiCategorize,
  geminiSuggestResponses,
  geminiFaqSearch,
  geminiAnalyzeTicket,
  geminiTranslate,
  geminiEvaluateQuality,
  geminiPredictSatisfaction,
  geminiDetectFraud,
  geminiGenerateKB,
  geminiWeeklyReport
};
