const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");

let db;
let auth;
let isMock = false;
let FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || "";

// ── Load and initialize Firebase Admin SDK ──────────────────────────────────
if (FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);

    // Normalize private key — handles any level of newline escaping
    // (OneDrive on Windows can produce \n, \\n, or real newlines interchangeably)
    if (serviceAccount.private_key) {
      let pk = serviceAccount.private_key;
      // Replace any run of backslashes followed by 'n' → real newline
      pk = pk.replace(/\\+n/g, "\n");
      // Also clean up carriage returns
      pk = pk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      serviceAccount.private_key = pk;
    }

    // Guard: only initialize once (handles hot-reload / module cache)
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }

    db   = admin.firestore();
    auth = admin.auth();
    console.log("Firebase Admin SDK Initialized Successfully.");
    console.log(`  Project : ${serviceAccount.project_id}`);
    console.log(`  Account : ${serviceAccount.client_email}`);

    // ── Live connectivity test — catches revoked/rotated keys early ──────────
    // Run async so it doesn't block the module load; logs a warning if it fails
    setImmediate(async () => {
      try {
        await db.collection("_ping_").limit(1).get();
        console.log("  Firestore connectivity : OK");
      } catch (pingErr) {
        const code = pingErr.code || "";
        if (code === 7 || code === 16 || String(pingErr.message).includes("UNAUTHENTICATED") || String(pingErr.message).includes("PERMISSION_DENIED")) {
          console.error("\n╔══════════════════════════════════════════════════════╗");
          console.error("║  FIREBASE AUTH ERROR — SERVICE ACCOUNT KEY REVOKED   ║");
          console.error("╠══════════════════════════════════════════════════════╣");
          console.error("║  Your serviceAccountKey.json has been invalidated.   ║");
          console.error("║                                                      ║");
          console.error("║  FIX (takes ~2 minutes):                             ║");
          console.error("║  1. Firebase Console → Project Settings              ║");
          console.error("║  2. Service Accounts tab                             ║");
          console.error("║  3. Click \"Generate new private key\"                 ║");
          console.error("║  4. Download the JSON file                           ║");
          console.error("║  5. Rename it to serviceAccountKey.json              ║");
          console.error("║  6. Replace: backend/config/serviceAccountKey.json   ║");
          console.error("║  7. Restart the server                               ║");
          console.error("╚══════════════════════════════════════════════════════╝\n");
        } else {
          // Transient network error — not a key problem, just log briefly
          console.warn("  Firestore connectivity check warning:", pingErr.message);
        }
      }
    });

  } catch (error) {
    console.error("Error initializing Firebase, falling back to local database:", error.message);
    initializeMock();
  }
} else {
  console.warn("serviceAccountKey.json not found — using local JSON mock database.");
  initializeMock();
}

function initializeMock() {
  isMock = true;
  const mockDbPath = path.join(__dirname, "..", "db", "mockDb.json");

  // Local JSON Database Helper
  class MockFirestore {
    constructor(filePath) {
      this.filePath = filePath;
      this._ensureDbFile();
    }

    _ensureDbFile() {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, JSON.stringify({
          users: {}, tickets: {}, activity_logs: {}, notifications: {},
          ai_conversations: {}, ai_sentiment: {}, ai_categorizations: {},
          kb: {
            "1": { id: "1", category: "Account Access", question: "How do I reset my password?", answer: "Click 'Forgot Password' on the login screen, enter your email address, and fill out your new password to update your login credentials." },
            "2": { id: "2", category: "Billing", question: "Do you offer refunds?", answer: "Yes, we offer a 14-day money-back guarantee for all our premium billing subscriptions. Please submit a billing support ticket to request a refund." },
            "3": { id: "3", category: "Technical Support", question: "What integrations are supported?", answer: "DeskFlow AI supports native integrations with Slack, HubSpot, Jira, Salesforce, WhatsApp, and Shopify out of the box." },
            "4": { id: "4", category: "General Inquiry", question: "How does the AI chatbot work?", answer: "Our Zia AI Chatbot automatically reads customer messages, queries the local Help Center / FAQ Knowledge Base, performs sentiment checks, and resolves up to 80% of issues. It will escalate the conversation to a human support agent if it receives terms like 'human' or 'agent'." }
          }
        }, null, 2));
      }
    }

    _readAll() {
      this._ensureDbFile();
      try {
        return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      } catch (e) {
        return {};
      }
    }

    _writeAll(data) {
      this._ensureDbFile();
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    }

    _readCollection(col) {
      const allData = this._readAll();
      const colData = allData[col] || {};
      return Object.keys(colData).map(id => ({ ...colData[id], id }));
    }

    _readDoc(col, id) {
      const allData = this._readAll();
      return allData[col] ? allData[col][id] || null : null;
    }

    _writeDoc(col, id, data, merge = false) {
      const allData = this._readAll();
      if (!allData[col]) allData[col] = {};
      if (merge && allData[col][id]) {
        allData[col][id] = { ...allData[col][id], ...data };
      } else {
        allData[col][id] = data;
      }
      this._writeAll(allData);
    }

    _deleteDoc(col, id) {
      const allData = this._readAll();
      if (allData[col] && allData[col][id]) {
        delete allData[col][id];
        this._writeAll(allData);
      }
    }

    collection(colName) {
      const self = this;
      return {
        doc(docId) {
          const finalDocId = docId || Math.random().toString(36).substring(2, 15);
          return {
            id: finalDocId,
            async get() {
              const data = self._readDoc(colName, finalDocId);
              return {
                exists: !!data,
                id: finalDocId,
                data: () => data
              };
            },
            async set(data, options = {}) {
              self._writeDoc(colName, finalDocId, data, options.merge);
              return { id: finalDocId };
            },
            async update(data) {
              self._writeDoc(colName, finalDocId, data, true);
              return { id: finalDocId };
            },
            async delete() {
              self._deleteDoc(colName, finalDocId);
              return { id: finalDocId };
            }
          };
        },
        async add(data) {
          const docId = Math.random().toString(36).substring(2, 15);
          self._writeDoc(colName, docId, data, false);
          return {
            id: docId,
            async get() {
              const res = self._readDoc(colName, docId);
              return { exists: !!res, id: docId, data: () => res };
            }
          };
        },
        where(field, op, val) {
          const filters = [{ field, op, val }];
          return {
            where(f, o, v) {
              filters.push({ field: f, op: o, val: v });
              return this;
            },
            async get() {
              let docs = self._readCollection(colName);
              for (const filter of filters) {
                docs = docs.filter(doc => {
                  const itemVal = doc[filter.field];
                  if (filter.op === "==" || filter.op === "===") return itemVal === filter.val;
                  if (filter.op === "!=") return itemVal !== filter.val;
                  if (filter.op === "in") return Array.isArray(filter.val) && filter.val.includes(itemVal);
                  return true;
                });
              }
              return {
                empty: docs.length === 0,
                size:  docs.length,
                docs: docs.map(doc => ({
                  id: doc.id,
                  data: () => doc
                })),
                forEach(callback) {
                  docs.forEach(doc => callback({
                    id: doc.id,
                    data: () => doc
                  }));
                }
              };
            }
          };
        },
        async get() {
          const docs = self._readCollection(colName);
          return {
            empty: docs.length === 0,
            size:  docs.length,
            docs: docs.map(doc => ({
              id: doc.id,
              data: () => doc
            })),
            forEach(callback) {
              docs.forEach(doc => callback({
                id: doc.id,
                data: () => doc
              }));
            }
          };
        }
      };
    }
  }

  // Mock Authentication Helper
  class MockAuth {
    constructor(firestoreInstance) {
      this.db = firestoreInstance;
    }

    async createUser(properties) {
      const uid = Math.random().toString(36).substring(2, 15);
      const hashedPassword = await bcrypt.hash(properties.password, 10);
      const userData = {
        uid,
        email: properties.email.toLowerCase(),
        name: properties.displayName || "New User",
        password: hashedPassword,
        role: properties.role || "customer",
        createdAt: new Date().toISOString()
      };
      
      // Store user credentials
      this.db._writeDoc("users", uid, userData);
      return { uid, email: userData.email, displayName: userData.name };
    }

    async verifyPassword(email, rawPassword) {
      const users = this.db._readCollection("users");
      const user = users.find(u => u.email === email.toLowerCase());
      if (!user) throw new Error("User not found");
      
      const isMatch = await bcrypt.compare(rawPassword, user.password);
      if (!isMatch) throw new Error("Invalid password");
      return user;
    }
  }

  const firestoreDb = new MockFirestore(mockDbPath);
  db = firestoreDb;
  auth = new MockAuth(firestoreDb);
}

module.exports = {
  db,
  auth,
  isMock
};
