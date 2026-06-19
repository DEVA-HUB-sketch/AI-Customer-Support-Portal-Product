// frontend/firebase-init.js
// ─────────────────────────────────────────────────────────────────
// Firebase Web Configuration
// Get these values from:
//   Firebase Console → Project Settings → Your Apps → Web App
//   → SDK setup and configuration → Config
// ─────────────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAvM5db25jRE2Z5f4nN2AKgmi_jXbeO_pM",
  authDomain:        "deskflowai-27316.firebaseapp.com",
  projectId:         "deskflowai-27316",
  storageBucket:     "deskflowai-27316.firebasestorage.app",
  messagingSenderId: "2455272062",
  appId:             "1:2455272062:web:44738cac1088b6e028762f",
  measurementId:     "G-V55HHNYFRB"
};

// Initialize only once (guard against double-load)
if (!firebase.apps || !firebase.apps.length) {
  firebase.initializeApp(FIREBASE_CONFIG);
}

// Auth instance shared by signin.html and signup.html
const firebaseAuth = firebase.auth();

// Google provider — always prompt account selector so users can switch accounts
const googleProvider = new firebase.auth.GoogleAuthProvider();
googleProvider.addScope("email");
googleProvider.addScope("profile");
googleProvider.setCustomParameters({ prompt: "select_account" });
