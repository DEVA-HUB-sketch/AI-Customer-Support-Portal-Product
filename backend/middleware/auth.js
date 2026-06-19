// backend/middleware/auth.js
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "deskflow_super_secret_jwt_2024";

/**
 * verifyToken — rejects requests that carry no valid JWT.
 * Attaches decoded payload to req.user on success.
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Access denied. Please sign in." });
  }
  const token = authHeader.split(" ")[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ message: "Session expired. Please sign in again." });
  }
}

/**
 * requireRole(...roles) — must be used AFTER verifyToken.
 * Rejects requests where req.user.role is not in the allowed list.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required." });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access forbidden. Insufficient permissions." });
    }
    next();
  };
}

module.exports = { verifyToken, requireRole };
