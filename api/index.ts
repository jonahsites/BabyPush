import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();

import { initializeApp as initializeClientApp } from "firebase/app";
import { 
  getFirestore as getClientFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  runTransaction, 
  serverTimestamp, 
  increment,
  collection,
  query,
  limit,
  getDocs
} from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json" with { type: "json" };

const clientApp = initializeClientApp(firebaseConfig);
const db = (firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== "(default)")
  ? getClientFirestore(clientApp, firebaseConfig.firestoreDatabaseId)
  : getClientFirestore(clientApp);

// Dedicated named app for verifying client project auth ID tokens dynamically
const authApp = admin.apps.find(app => app && app.name === "authApp") 
  || admin.initializeApp({ projectId: firebaseConfig.projectId }, "authApp");

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Clean base URL getter matching our main server helper
function getBaseUrl(req: express.Request): string {
  const origin = req.get("origin");
  if (origin && origin !== "null" && origin.startsWith("http")) {
    return origin.replace(/\/$/, "");
  }

  const referer = req.get("referer");
  if (referer && referer.startsWith("http")) {
    try {
      const url = new URL(referer);
      return url.origin;
    } catch (_) {}
  }

  const forwardedProto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = req.get("host") || "localhost:3000";
  return `${forwardedProto}://${host}`.replace(/\/$/, "");
}

const app = express();
app.disable("x-powered-by");

// In-memory rate limiting map for serverless runtime/local API proxy instances
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 300; // Limit to 300 requests/min to allow smooth gaming coordination

// Clear expired keys periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 180000); // Check every 3 minutes

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set up security headers for API requests
app.use((req, res, next) => {
  // 1. IP-Based Rate Limiting Protection
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() || req.socket.remoteAddress || "anonymous";
  const now = Date.now();

  let limitData = rateLimitMap.get(ip);
  if (!limitData || now > limitData.resetTime) {
    limitData = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, limitData);
  }

  limitData.count++;

  // Express standard limit tracking headers
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_MAX_REQUESTS);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, RATE_LIMIT_MAX_REQUESTS - limitData.count));
  res.setHeader("X-RateLimit-Reset", Math.ceil(limitData.resetTime / 1000));

  if (limitData.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      error: "Too Many Requests",
      message: "You are issuing requests too fast. Please take a slight breather and try again in a moment.",
    });
  }

  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  
  // CORS Configuration matching server.ts
  const allowedOrigins = [
    "https://ai.studio",
    "https://studio.google.com",
    "https://localhost:3000",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];

  const origin = req.headers.origin;
  if (origin) {
    const isAllowed = allowedOrigins.includes(origin) || 
      origin.endsWith(".google.com") || 
      origin.endsWith(".run.app") || 
      origin.endsWith(".googleusercontent.com");

    if (isAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,Content-Type,Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Health check endpoints for orchestration
app.get(["/health", "/healthz", "/api/health"], (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Database Connection Test Endpoint
app.get(["/api/test-db", "/test-db"], async (req, res) => {
  try {
    const q = query(collection(db, "users"), limit(1));
    const snap = await getDocs(q);
    res.json({ success: true, message: "Firestore read succeeded!", count: snap.size });
  } catch (err: any) {
    console.error("Firestore DB access error in diagnostics:", err);
    res.status(500).json({ success: false, error: err.message || err });
  }
});

// API Route: Configuration Status
app.get(["/api/config-status", "/config-status"], (req, res) => {
  res.json({
    stripeEnabled: !!stripe,
    hasSecretKey: !!process.env.STRIPE_SECRET_KEY,
    paypalEnabled: !!process.env.PAYPAL_CLIENT_ID,
    hasPaypalCredentials: !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
  });
});

// PayPal REST Helper Function
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const isLive = process.env.PAYPAL_MODE === "live";
  const host = isLive ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

  if (!clientId || !clientSecret) {
    throw new Error("PayPal API credentials are not configured");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${host}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to get PayPal token: ${errText}`);
  }

  const data = await response.json() as any;
  return data.access_token;
}

// API Route: Create PayPal Session Option
app.post(["/api/create-paypal-session", "/create-paypal-session"], async (req, res) => {
  const { tokens, userId } = req.body;

  const parsedTokens = Number(tokens);
  if (tokens === undefined || tokens === null || isNaN(parsedTokens) || parsedTokens <= 0 || parsedTokens > 10000 || !Number.isInteger(parsedTokens)) {
    return res.status(400).json({ error: "Invalid request data", message: "Token quantity must be a positive integer." });
  }
  if (typeof userId !== "string" || !userId || userId.trim().length === 0) {
    return res.status(400).json({ error: "Invalid request data", message: "User identifier must be non-empty." });
  }

  const sanitizedUserId = userId.trim();
  const baseUrl = getBaseUrl(req);

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    // Sandbox Checkout Simulation Mode
    const mockOrderId = `mock_paypal_${Date.now()}_u_${sanitizedUserId}_t_${parsedTokens}`;
    const mockOrderUrl = `${baseUrl}/?paypal=success&token=${mockOrderId}`;
    return res.json({ id: mockOrderId, url: mockOrderUrl, isSandbox: true });
  }

  try {
    const isLive = process.env.PAYPAL_MODE === "live";
    const host = isLive ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    const accessToken = await getPayPalAccessToken();

    const orderResponse = await fetch(`${host}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: "USD",
              value: `${parsedTokens}.00`
            },
            description: `${parsedTokens} Push Arena Game Tokens`,
            custom_id: `${sanitizedUserId}|${parsedTokens}`
          }
        ],
        application_context: {
          brand_name: "Push Arena Strollers",
          landing_page: "BILLING",
          user_action: "PAY_NOW",
          return_url: `${baseUrl}/?paypal=success&tokens=${parsedTokens}&userId=${sanitizedUserId}`,
          cancel_url: `${baseUrl}/?paypal=cancel`
        }
      })
    });

    if (!orderResponse.ok) {
      const errText = await orderResponse.text();
      throw new Error(`Failed to create PayPal order: ${errText}`);
    }

    const orderData = await orderResponse.json() as any;
    const approveLink = orderData.links.find((l: any) => l.rel === "approve");
    if (!approveLink) {
      throw new Error("No approval link returned from PayPal");
    }

    res.json({ id: orderData.id, url: approveLink.href });
  } catch (err: any) {
    console.error("PayPal Create Session error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API Route: Verify PayPal Payment
app.get(["/api/verify-paypal-payment", "/verify-paypal-payment"], async (req, res) => {
  const { token, tokens, userId } = req.query;
  if (!token) return res.status(400).json({ error: "Missing token (PayPal Order ID)" });

  // Handle Mock Sandbox Sessions
  if (typeof token === "string" && token.startsWith("mock_paypal_")) {
    const match = token.match(/_u_(.*)_t_(\d+)/);
    if (match) {
      const uId = match[1];
      const tks = parseInt(match[2]);
      return res.json({ 
        status: "paid", 
        tokens: tks,
        userId: uId,
        isSandbox: true
      });
    }
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) return res.status(500).json({ error: "PayPal is not configured in this environment" });

  try {
    const isLive = process.env.PAYPAL_MODE === "live";
    const host = isLive ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    const accessToken = await getPayPalAccessToken();

    // 1. Get current Order status
    const orderResponse = await fetch(`${host}/v2/checkout/orders/${token}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!orderResponse.ok) {
      const orderErr = await orderResponse.text();
      throw new Error(`Failed to fetch PayPal order status: ${orderErr}`);
    }

    let orderData = await orderResponse.json() as any;

    // 2. If APPROVED, capture it. If completed, it is already captured.
    if (orderData.status === "APPROVED") {
      const captureResponse = await fetch(`${host}/v2/checkout/orders/${token}/capture`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      });

      if (!captureResponse.ok) {
        const capErr = await captureResponse.text();
        throw new Error(`Failed to capture PayPal order: ${capErr}`);
      }

      orderData = await captureResponse.json() as any;
    }

    const isPaid = orderData.status === "COMPLETED";
    if (isPaid) {
      // Find custom_id / tokens / userId
      const purchaseUnit = orderData.purchase_units?.[0];
      const customId = purchaseUnit?.custom_id;
      let orderUserId = "";
      let orderTokens = 0;

      if (customId && customId.includes("|")) {
        const parts = customId.split("|");
        orderUserId = parts[0];
        orderTokens = parseInt(parts[1]) || 0;
      } else {
        // Fallback to query parameters
        orderUserId = (userId as string) || "";
        orderTokens = parseInt((tokens as string) || "0") || 0;
      }

      // Security check: verify payment amount matches requested tokens
      const amountValue = purchaseUnit?.amount?.value;
      if (amountValue) {
        const actualValue = parseFloat(amountValue);
        if (Math.abs(actualValue - orderTokens) > 0.01) {
          console.warn(`[PayPal Security] Amount value $${actualValue} does not match predicted tokens count ${orderTokens}`);
          orderTokens = Math.floor(actualValue); // Default to actual charged USD dollars
        }
      }

      if (!orderUserId || orderTokens <= 0) {
        throw new Error("Could not retrieve valid userId or tokens from PayPal order metadata.");
      }

      res.json({
        status: "paid",
        tokens: orderTokens,
        userId: orderUserId
      });
    } else {
      res.json({ status: orderData.status || "unpaid" });
    }
  } catch (err: any) {
    console.error("PayPal Capture error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API Route: Create Checkout Session
app.post(["/api/create-checkout-session", "/create-checkout-session"], async (req, res) => {
  const { tokens, userId } = req.body;

  // Strict input schema validation to prevent payload manipulation
  const parsedTokens = Number(tokens);
  if (tokens === undefined || tokens === null || isNaN(parsedTokens) || parsedTokens <= 0 || parsedTokens > 10000 || !Number.isInteger(parsedTokens)) {
    return res.status(400).json({ error: "Invalid request data", message: "Token quantity must be a positive integer between 1 and 10,000." });
  }
  if (typeof userId !== "string" || !userId || userId.trim().length === 0 || userId.length > 128) {
    return res.status(400).json({ error: "Invalid request data", message: "User identifier must be a valid, non-empty string under 128 characters." });
  }

  const sanitizedUserId = userId.trim();
  const baseUrl = getBaseUrl(req);

  if (!stripe) {
    // Sandbox Checkout Simulation Mode
    const mockSessionId = `mock_session_${Date.now()}_u_${sanitizedUserId}_t_${parsedTokens}`;
    const mockSessionUrl = `${baseUrl}/?payment=success&session_id=${mockSessionId}&sandbox=true`;
    return res.json({ id: mockSessionId, url: mockSessionUrl });
  }
  
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${parsedTokens} Game Tokens`,
              description: "Purchase tokens for Territory War",
            },
            unit_amount: parsedTokens * 100, // $1 per token
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${baseUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?payment=cancel`,
      metadata: {
        userId: sanitizedUserId,
        tokens: parsedTokens.toString(),
      },
    });

    res.json({ id: session.id, url: session.url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API Route: Verify Payment
app.get(["/api/verify-payment", "/verify-payment"], async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  // Handle Mock Sandbox Sessions
  if (typeof session_id === "string" && session_id.startsWith("mock_session_")) {
    const match = session_id.match(/_u_(.*)_t_(\d+)/);
    if (match) {
      const userId = match[1];
      const tokens = parseInt(match[2]);
      return res.json({ 
        status: "paid", 
        tokens,
        userId,
        isSandbox: true
      });
    }
  }

  if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id as string);
    if (session.payment_status === "paid") {
      res.json({ 
        status: "paid", 
        tokens: parseInt(session.metadata?.tokens || "0"),
        userId: session.metadata?.userId 
      });
    } else {
      res.json({ status: "unpaid" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API Route: Ko-fi Webhook Listener
app.post(["/api/kofi-webhook", "/kofi-webhook"], async (req, res) => {
  try {
    const { data } = req.body;
    if (!data) {
      console.error("Missing data field in Ko-fi webhook body:", req.body);
      return res.status(400).send("Bad Request: Missing data field");
    }

    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch (parseErr) {
      console.error("Failed to parse Ko-fi webhook JSON:", parseErr);
      return res.status(400).send("Bad Request: Invalid JSON in data");
    }

    // Secure Verification Token Check (User provided 29cd838f-4821-4584-b512-0c01d78e1686)
    const localVerificationToken = process.env.KOFI_VERIFICATION_TOKEN || "29cd838f-4821-4584-b512-0c01d78e1686";
    if (payload.verification_token !== localVerificationToken) {
      console.warn("Unauthorized Ko-fi verification token attempt:", payload.verification_token);
      return res.status(401).send("Unauthorized: Invalid verification token");
    }

    const transactionId = (payload.kofi_transaction_id || payload.message_id || "").toString().trim();
    if (!transactionId) {
      console.error("Missing transaction identifier fields in Ko-fi payload:", payload);
      return res.status(400).send("Bad Request: Missing transaction ID");
    }

    const amount = parseFloat(payload.amount) || 0.0;
    const fromName = (payload.from_name || "Anonymous").trim();
    const timestamp = payload.timestamp || new Date().toISOString();
    const type = payload.type || "Donation";
    const email = (payload.email || "").trim();
    const isSubscription = payload.is_subscription_payment || false;
    const message = payload.message || "";
    const currency = payload.currency || "USD";

    console.log(`[Ko-fi Webhook] Processing Transaction ${transactionId} - $${amount} from ${fromName}`);

    // Store in firestore database
    const paymentRef = doc(db, "kofi_payments", transactionId);
    const existingSnap = await getDoc(paymentRef);

    if (!existingSnap.exists()) {
      await setDoc(paymentRef, {
        transactionId,
        name: fromName,
        amount,
        currency,
        message,
        timestamp,
        type,
        email,
        isSubscription,
        claimed: false,
        claimedBy: null,
        claimedAt: null,
        createdAt: serverTimestamp()
      });
      console.log(`[Ko-fi Webhook] Successfully recorded payment of $${amount} under Tx: ${transactionId}`);
    } else {
      console.log(`[Ko-fi Webhook] Transaction ID ${transactionId} already exists, skipping duplication check.`);
    }

    res.status(200).send("OK");
  } catch (err: any) {
    console.error("Internal process error on Ko-fi webhook:", err);
    res.status(500).send("Internal Server Error");
  }
});

// API Route: PayPal Webhook Listener
app.post(["/api/paypal-webhook", "/paypal-webhook"], async (req, res) => {
  try {
    const payload = req.body;
    const eventType = payload.event_type || "";
    console.log(`[PayPal Webhook] Received event: ${eventType}`);

    let transactionId = "";
    let amount = 0.0;
    let fromName = "Anonymous";
    let email = "";
    let currency = "USD";

    if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
      const resource = payload.resource || {};
      transactionId = (resource.id || "").toString().trim();
      amount = parseFloat(resource.amount?.value) || 0.0;
      currency = resource.amount?.currency_code || "USD";
      if (resource.payer) {
        const givenName = resource.payer.name?.given_name || "";
        const surname = resource.payer.name?.surname || "";
        fromName = `${givenName} ${surname}`.trim() || "Anonymous";
        email = (resource.payer.email_address || "").trim();
      }
    } else if (eventType === "CHECKOUT.ORDER.APPROVED") {
      const resource = payload.resource || {};
      transactionId = (resource.id || "").toString().trim();
      const purchaseUnit = resource.purchase_units?.[0] || {};
      amount = parseFloat(purchaseUnit.amount?.value) || 0.0;
      currency = purchaseUnit.amount?.currency_code || "USD";
      if (resource.payer) {
        const givenName = resource.payer.name?.given_name || "";
        const surname = resource.payer.name?.surname || "";
        fromName = `${givenName} ${surname}`.trim() || "Anonymous";
        email = (resource.payer.email_address || "").trim();
      }
    } else {
      const resource = payload.resource || {};
      transactionId = (resource.id || payload.id || "").toString().trim();
      amount = parseFloat(resource.amount?.value || resource.value) || 0.0;
      currency = resource.amount?.currency_code || "USD";
    }

    if (!transactionId) {
      transactionId = (payload.id || "").toString().trim();
    }

    if (!transactionId) {
      console.error("Missing transaction identifier fields in PayPal payload:", payload);
      return res.status(400).send("Bad Request: Missing transaction ID");
    }

    console.log(`[PayPal Webhook] Processing Transaction ${transactionId} - $${amount} from ${fromName}`);

    // Store in firestore database
    const paymentRef = doc(db, "paypal_payments", transactionId);
    const existingSnap = await getDoc(paymentRef);

    if (!existingSnap.exists()) {
      await setDoc(paymentRef, {
        transactionId,
        name: fromName,
        amount,
        currency,
        email,
        timestamp: payload.create_time || new Date().toISOString(),
        eventType,
        claimed: false,
        claimedBy: null,
        claimedAt: null,
        createdAt: serverTimestamp()
      });
      console.log(`[PayPal Webhook] Successfully recorded payment of $${amount} under Tx: ${transactionId}`);
    } else {
      console.log(`[PayPal Webhook] Transaction ID ${transactionId} already exists, skipping duplication check.`);
    }

    res.status(200).send("OK");
  } catch (err: any) {
    console.error("Internal process error on PayPal webhook:", err);
    res.status(500).send("Internal Server Error");
  }
});

// API Route: Secure server-side PayPal claiming
app.post(["/api/claim-paypal", "/claim-paypal"], async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized", message: "Missing or invalid authorization token." });
    }

    const idToken = authHeader.split("Bearer ")[1];
    let decodedToken;
    try {
      decodedToken = await authApp.auth().verifyIdToken(idToken);
    } catch (tokenErr: any) {
      console.error("Firebase ID Token verification failed:", tokenErr);
      return res.status(401).json({ error: "Unauthorized", message: "Failed to verify user credentials." });
    }

    const userId = decodedToken.uid;
    const { transactionId } = req.body;

    if (!transactionId || typeof transactionId !== "string" || transactionId.trim().length === 0) {
      return res.status(400).json({ error: "Bad Request", message: "Please supply a valid transaction receipt ID." });
    }

    const trimmedTxId = transactionId.trim();
    const paymentRef = doc(db, "paypal_payments", trimmedTxId);
    
    const claimResult = await runTransaction(db, async (transaction) => {
      const paymentSnap = await transaction.get(paymentRef);
      if (!paymentSnap.exists()) {
        return { 
          success: false, 
          error: "NOT_FOUND", 
          message: "Transaction ID not found. PayPal webhooks can take up to 30 seconds to deliver. Please verify the transaction ID or Order ID from your receipt." 
        };
      }

      const paymentData = paymentSnap.data();
      if (!paymentData) {
        return { success: false, error: "NOT_FOUND", message: "Transaction details are empty." };
      }

      if (paymentData.claimed) {
        return { 
          success: false, 
          error: "ALREADY_CLAIMED", 
          message: `This transaction was already claimed on ${paymentData.claimedAt} by user ID ending in ...${paymentData.claimedBy.slice(-5)}` 
        };
      }

      const dollarValue = paymentData.amount || 0;
      if (dollarValue <= 0) {
        return { success: false, error: "INVALID_AMOUNT", message: "Payment transaction support amount is invalid." };
      }

      const tokenAmount = Math.floor(dollarValue * 1);

      const userRef = doc(db, "users", userId);
      const userSnap = await transaction.get(userRef);

      // 1. Set payment as claimed
      transaction.update(paymentRef, {
        claimed: true,
        claimedBy: userId,
        claimedAt: new Date().toISOString()
      });

      // 2. Add tokens & donation details
      const claimLog = {
        name: paymentData.name || "Anonymous",
        transactionId: trimmedTxId,
        tokenAmount,
        dollarValue,
        timestamp: new Date().toISOString()
      };

      if (!userSnap.exists()) {
        transaction.set(userRef, {
          currentTokens: tokenAmount,
          totalDonated: dollarValue,
          paypalClaims: [claimLog],
          displayName: paymentData.name || "Aesthetic Player"
        });
      } else {
        const userData = userSnap.data() || {};
        const oldTokens = userData.currentTokens || 0;
        const oldDonated = userData.totalDonated || 0;
        const oldClaims = userData.paypalClaims || [];

        transaction.update(userRef, {
          currentTokens: oldTokens + tokenAmount,
          totalDonated: oldDonated + dollarValue,
          paypalClaims: [...oldClaims, claimLog]
        });
      }

      // 3. Update global raised charity metrics
      const gameRef = doc(db, "games", "global");
      transaction.set(gameRef, {
        totalRaised: increment(dollarValue)
      }, { merge: true });

      return { success: true, dollarValue, tokenAmount, name: paymentData.name };
    });

    if (!claimResult.success) {
      return res.status(400).json({ error: claimResult.error, message: claimResult.message });
    }

    return res.json({
      success: true,
      message: `Successfully processed support of $${claimResult.dollarValue.toFixed(2)} from ${claimResult.name}!`,
      tokensAdded: claimResult.tokenAmount,
      amount: claimResult.dollarValue
    });

  } catch (err: any) {
    console.error("Error in claim-paypal endpoint:", err);
    res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
});

// API Route: Secure server-side Ko-fi claiming
app.post(["/api/claim-kofi", "/claim-kofi"], async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized", message: "Missing or invalid authorization token." });
    }

    const idToken = authHeader.split("Bearer ")[1];
    let decodedToken;
    try {
      decodedToken = await authApp.auth().verifyIdToken(idToken);
    } catch (tokenErr: any) {
      console.error("Firebase ID Token verification failed:", tokenErr);
      return res.status(401).json({ error: "Unauthorized", message: "Failed to verify user credentials." });
    }

    const userId = decodedToken.uid;
    const { transactionId } = req.body;

    if (!transactionId || typeof transactionId !== "string" || transactionId.trim().length === 0) {
      return res.status(400).json({ error: "Bad Request", message: "Please supply a valid transaction receipt ID." });
    }

    const trimmedTxId = transactionId.trim();
    const paymentRef = doc(db, "kofi_payments", trimmedTxId);
    
    const claimResult = await runTransaction(db, async (transaction) => {
      const paymentSnap = await transaction.get(paymentRef);
      if (!paymentSnap.exists()) {
        return { 
          success: false, 
          error: "NOT_FOUND", 
          message: "Transaction ID not found. Webhooks can take up to 30 seconds to deliver. Please verify the receipt ID as displayed on your Ko-fi email receipt layout." 
        };
      }

      const paymentData = paymentSnap.data();
      if (!paymentData) {
        return { success: false, error: "NOT_FOUND", message: "Transaction details are empty." };
      }

      if (paymentData.claimed) {
        return { 
          success: false, 
          error: "ALREADY_CLAIMED", 
          message: `This transaction was already claimed on ${paymentData.claimedAt} by user ID ending in ...${paymentData.claimedBy.slice(-5)}` 
        };
      }

      const dollarValue = paymentData.amount || 0;
      if (dollarValue <= 0) {
        return { success: false, error: "INVALID_AMOUNT", message: "Payment transaction support amount is invalid." };
      }

      // Token credit calculations (strictly 1 token per $1.00 USD)
      const tokenAmount = Math.floor(dollarValue * 1);

      const userRef = doc(db, "users", userId);
      const userSnap = await transaction.get(userRef);

      // 1. Set payment as claimed
      transaction.update(paymentRef, {
        claimed: true,
        claimedBy: userId,
        claimedAt: new Date().toISOString()
      });

      // 2. Add tokens & donation details
      const coffeesValue = Math.round(dollarValue / 3.0) || 1;
      const claimLog = {
        name: paymentData.name || "Anonymous",
        transactionId: trimmedTxId,
        coffees: coffeesValue,
        tokenAmount,
        dollarValue,
        timestamp: new Date().toISOString()
      };

      if (!userSnap.exists()) {
        transaction.set(userRef, {
          currentTokens: tokenAmount,
          totalDonated: dollarValue,
          kofiClaims: [claimLog],
          displayName: paymentData.name || "Aesthetic Player"
        });
      } else {
        const userData = userSnap.data() || {};
        const oldTokens = userData.currentTokens || 0;
        const oldDonated = userData.totalDonated || 0;
        const oldClaims = userData.kofiClaims || [];

        transaction.update(userRef, {
          currentTokens: oldTokens + tokenAmount,
          totalDonated: oldDonated + dollarValue,
          kofiClaims: [...oldClaims, claimLog]
        });
      }

      // 3. Update global raised charity metrics
      const gameRef = doc(db, "games", "global");
      transaction.set(gameRef, {
        totalRaised: increment(dollarValue)
      }, { merge: true });

      return { success: true, dollarValue, tokenAmount, name: paymentData.name };
    });

    if (!claimResult.success) {
      return res.status(400).json({ error: claimResult.error, message: claimResult.message });
    }

    return res.json({
      success: true,
      message: `Successfully processed support of $${claimResult.dollarValue.toFixed(2)} from ${claimResult.name}!`,
      tokensAdded: claimResult.tokenAmount,
      amount: claimResult.dollarValue
    });

  } catch (err: any) {
    console.error("Error in claim-kofi endpoint:", err);
    res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
});

// Export default Express app for Vercel Serverless Function runtime
export default app;
