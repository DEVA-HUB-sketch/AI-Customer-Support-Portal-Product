// backend/routes/kbRoutes.js
const express = require("express");
const router  = express.Router();
const { db }  = require("../config/firebase");
const { log, ACTIONS } = require("../services/activityLogger");
const { verifyToken, requireRole } = require("../middleware/auth");

// Get all KB articles / FAQs
router.get("/", async (req, res) => {
  try {
    const search = (req.query.search || "").toLowerCase();
    const category = req.query.category || "";
    
    const kbRef = db.collection("kb");
    let snapshot;
    
    if (category) {
      snapshot = await kbRef.where("category", "==", category).get();
    } else {
      snapshot = await kbRef.get();
    }
    
    const articles = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (!search || data.question.toLowerCase().includes(search) || data.answer.toLowerCase().includes(search)) {
        articles.push({ id: doc.id, ...data });
      }
    });
    
    res.json(articles);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get unique categories
router.get("/categories", async (req, res) => {
  try {
    const snapshot = await db.collection("kb").get();
    const categories = new Set();
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.category) {
        categories.add(data.category);
      }
    });
    res.json(Array.from(categories));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/kb - Add a new KB article (admin only)
router.post("/", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const { question, answer, category } = req.body;
    if (!question || !answer || !category) {
      return res.status(400).json({ message: "All fields required" });
    }
    const docRef = await db.collection("kb").add({
      question,
      answer,
      category,
      createdAt: new Date().toISOString()
    });
    log({ userId: req.body.addedBy || "admin", email: req.body.addedBy || "admin", role: "admin",
          action: ACTIONS.KB_ARTICLE_ADDED,
          details: { question, category }, ip: req.clientIp });
    res.status(201).json({ message: "Article added", id: docRef.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// DELETE /api/kb/:id - Delete a KB article (admin only)
router.delete("/:id", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    await db.collection("kb").doc(req.params.id).delete();
    log({ userId: req.query.deletedBy || "admin", email: req.query.deletedBy || "admin", role: "admin",
          action: ACTIONS.KB_ARTICLE_DELETED,
          details: { articleId: req.params.id }, ip: req.clientIp });
    res.json({ message: "Article deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
