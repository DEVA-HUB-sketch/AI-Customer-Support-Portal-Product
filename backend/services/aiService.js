// backend/services/aiService.js

/**
 * Analyzes the sentiment of a given text description.
 * @param {string} text 
 * @returns {string} - "Positive", "Neutral", or "Negative"
 */
function analyzeSentiment(text) {
  if (!text) return "Neutral";
  const clean = text.toLowerCase();
  
  const negativeKeywords = [
    "urgent", "broken", "fail", "error", "crash", "refund", "worst", "angry", 
    "frustrated", "bug", "terrible", "hate", "issue", "locked out", "cannot",
    "stop", "useless", "disappointed", "poor"
  ];
  
  const positiveKeywords = [
    "thanks", "thank you", "great", "awesome", "perfect", "good", "happy", 
    "love", "excellent", "solved", "helpful", "delighted", "appreciate"
  ];

  let score = 0;
  negativeKeywords.forEach(kw => {
    if (clean.includes(kw)) score -= 1;
  });
  positiveKeywords.forEach(kw => {
    if (clean.includes(kw)) score += 1;
  });

  if (score < 0) return "Negative";
  if (score > 0) return "Positive";
  return "Neutral";
}

/**
 * Categorizes a support ticket based on subject/description.
 * @param {string} subject 
 * @param {string} description 
 * @returns {string} - "Billing", "Account Access", "Technical Support", or "General Inquiry"
 */
function categorizeTicket(subject = "", description = "") {
  const cleanText = `${subject} ${description}`.toLowerCase();

  const billingKeywords = ["invoice", "price", "billing", "payment", "charge", "refund", "subscription", "pay", "card", "money"];
  const accountKeywords = ["login", "password", "reset", "signup", "register", "locked", "access", "sign in", "account", "profile"];
  const technicalKeywords = ["api", "integration", "error", "bug", "crash", "slow", "down", "broken", "code", "fail", "server", "website"];

  if (billingKeywords.some(kw => cleanText.includes(kw))) return "Billing";
  if (accountKeywords.some(kw => cleanText.includes(kw))) return "Account Access";
  if (technicalKeywords.some(kw => cleanText.includes(kw))) return "Technical Support";
  
  return "General Inquiry";
}

/**
 * Generates suggested responses for an agent based on ticket category and sentiment.
 * @param {string} category 
 * @param {string} sentiment 
 * @returns {string[]}
 */
function getSuggestedResponses(category, sentiment) {
  const replies = [];
  
  if (sentiment === "Negative") {
    replies.push("I sincerely apologize for the inconvenience this has caused you. Let me look into this issue immediately to get it resolved.");
  }

  switch (category) {
    case "Billing":
      replies.push("I have reviewed your billing subscription and verified your payment details. Let me process the correction for you.");
      replies.push("Could you please provide the billing invoice number and the last 4 digits of your payment method so we can proceed?");
      break;
    case "Account Access":
      replies.push("For your security, I have triggered a password reset link to your email. Please check your inbox and spam folder.");
      replies.push("I see that your account was temporarily locked due to multiple login attempts. I have unlocked it for you now.");
      break;
    case "Technical Support":
      replies.push("Thank you for reporting this issue. Could you please share your browser version, operating system, and any console error screenshots?");
      replies.push("Our engineering team has identified this bug and is actively deploying a fix. We will notify you as soon as it goes live.");
      break;
    default:
      replies.push("Thank you for reaching out to DeskFlow AI support. I am investigating your query and will update you shortly.");
      replies.push("Could you please share a bit more detail about your request so I can assign it to the correct department?");
  }

  return replies;
}

/**
 * AI Chatbot reply engine.
 * @param {string} message - User message
 * @param {object[]} history - Past messages in the session
 * @returns {object} - { reply: string, escalate: boolean, category: string }
 */
function getChatbotReply(message, history = []) {
  const clean = (message || "").toLowerCase();
  
  // 1. Escalation check
  const escalationKeywords = ["human", "agent", "person", "representative", "support", "speak to someone", "call me", "escalate"];
  if (escalationKeywords.some(kw => clean.includes(kw))) {
    return {
      reply: "I understand you would like to speak to a human agent. I have escalated this conversation and created a support ticket for you. An agent will reply shortly!",
      escalate: true,
      category: categorizeTicket("", message)
    };
  }

  // 2. FAQ matching
  if (clean.includes("password") || clean.includes("reset") || clean.includes("login")) {
    return {
      reply: "To reset your password, click 'Forgot Password' on the login screen, enter your email address, and follow the instructions sent to your inbox.",
      escalate: false,
      category: "Account Access"
    };
  }
  if (clean.includes("refund") || clean.includes("billing") || clean.includes("subscription") || clean.includes("invoice")) {
    return {
      reply: "We offer a 14-day money-back guarantee for billing subscriptions. If you need a refund or bill adjustment, please submit a billing ticket on your dashboard.",
      escalate: false,
      category: "Billing"
    };
  }
  if (clean.includes("integration") || clean.includes("api") || clean.includes("slack") || clean.includes("shopify")) {
    return {
      reply: "DeskFlow AI supports native integrations with Slack, HubSpot, Jira, Salesforce, Shopify, and WhatsApp. You can configure them in system settings.",
      escalate: false,
      category: "Technical Support"
    };
  }
  if (clean.includes("hello") || clean.includes("hi") || clean.includes("hey")) {
    return {
      reply: "Hello! I am Zia, your DeskFlow AI virtual assistant. How can I help you today? You can ask me questions about your account, billing, or technical features, or ask to speak to an agent.",
      escalate: false,
      category: "General Inquiry"
    };
  }

  // 3. Fallback context-aware response
  const category = categorizeTicket("", message);
  let reply = "I'm not sure I fully understand. Could you please elaborate? You can also ask to speak with a human support agent at any time.";
  
  if (category === "Billing") {
    reply = "It sounds like you have a billing inquiry. I can help with invoice lookups or subscription queries, or I can assign this to our accounts team.";
  } else if (category === "Account Access") {
    reply = "If you're having trouble accessing your account, please confirm if you're getting a specific error message during sign-in.";
  } else if (category === "Technical Support") {
    reply = "I've flagged this under technical support. If you are seeing an API or system error, please describe it, or type 'human' to escalate.";
  }

  return {
    reply,
    escalate: false,
    category
  };
}

module.exports = {
  analyzeSentiment,
  categorizeTicket,
  getSuggestedResponses,
  getChatbotReply
};
