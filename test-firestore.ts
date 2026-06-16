import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, limit, query } from "firebase/firestore";
import firebaseConfig from "./firebase-applet-config.json" with { type: "json" };

console.log("=== CLIENT-SIDE SDK ON NODES WITH FORCE EXIT ===");
const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

try {
  console.log("Attempting query on kofi_payments...");
  const q = query(collection(db, "kofi_payments"), limit(10));
  const snap = await getDocs(q);
  console.log("-> SUCCESS! size:", snap.size);
  snap.forEach((doc) => {
    console.log(`Document ID: [${doc.id}] :: Data:`, JSON.stringify(doc.data(), null, 2));
  });
} catch (err: any) {
  console.error("-> FAILED:", err.message || err);
} finally {
  console.log("Exiting process...");
  process.exit(0);
}




