/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Minus, RotateCcw } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { db, auth } from "./lib/firebase";
import { doc, onSnapshot, updateDoc, setDoc, getDoc, serverTimestamp, increment, collection, query, orderBy, limit, getDocs, arrayUnion } from "firebase/firestore";
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, User as FirebaseUser, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import SlingshotGame from "./components/SlingshotGame";
import { PayPalButton } from "./components/PayPalButton";

const GAME_ID = "global";

const GAME_OBSTACLES = [
  // --- LAYER 0: Bottom Spawn Defense (y = 205) ---
  // Left side horizontal baffle line
  { id: "line-0a", x: 15, y: 205, w: 55, h: 2 },
  // Right side horizontal baffle line
  { id: "line-0b", x: 130, y: 205, w: 55, h: 2 },
  // Core vertical divide near spawn area
  { id: "line-0c", x: 99, y: 190, w: 2, h: 25 },

  // --- LAYER 1: Near Spawn Area (y = 155) ---
  // Left side horizontal baffle line
  { id: "line-1a", x: 10, y: 155, w: 60, h: 2 },
  // Right side horizontal baffle line
  { id: "line-1b", x: 130, y: 155, w: 60, h: 2 },
  // Central vertical division corridor wall
  { id: "line-1c", x: 99, y: 140, w: 2, h: 30 },

  // --- LAYER 2: Mid-Lower Field (y = 115) ---
  // Extended centered baffle block line
  { id: "line-2a", x: 60, y: 115, w: 80, h: 2 },
  // Far outer edges to channel players into the gaps
  { id: "line-2b", x: 0, y: 115, w: 25, h: 2 },
  { id: "line-2c", x: 175, y: 115, w: 25, h: 2 },

  // --- LAYER 3: Middle Field (y = 80) ---
  // Checkerboard chicane panels (forces a winding flow)
  { id: "line-3a", x: 30, y: 80, w: 55, h: 2 },
  { id: "line-3b", x: 115, y: 80, w: 55, h: 2 },
  // Vertical checkpoint lanes
  { id: "line-3c", x: 45, y: 65, w: 2, h: 30 },
  { id: "line-3d", x: 153, y: 65, w: 2, h: 30 },

  // --- LAYER 4: Finish Approach Squeezes (y = 45) ---
  // Thick gate elements with narrow openings
  { id: "line-4a", x: 0, y: 45, w: 85, h: 2 },
  { id: "line-4b", x: 100, y: 45, w: 10, h: 2 },
  { id: "line-4c", x: 115, y: 45, w: 85, h: 2 },

  // --- LAYER 5: Front of Finish Line Shield (y = 25) ---
  { id: "line-5a", x: 80, y: 25, w: 40, h: 2 }
];

const OBSTACLE_COORDS_SET = (() => {
  const coords = new Set<string>();
  for (const obs of GAME_OBSTACLES) {
    for (let dx = 0; dx < obs.w; dx++) {
      for (let dy = 0; dy < obs.h; dy++) {
        coords.add(`${obs.x + dx},${obs.y + dy}`);
      }
    }
  }
  return coords;
})();

const PERMANENT_WALL_PIXELS = (() => {
  const pixels: { x: number; y: number }[] = [];
  for (const obs of GAME_OBSTACLES) {
    for (let dx = 0; dx < obs.w; dx++) {
      for (let dy = 0; dy < obs.h; dy++) {
        pixels.push({ x: obs.x + dx, y: obs.y + dy });
      }
    }
  }
  return pixels;
})();

const isObstacleVal = (x: number, y: number): boolean => {
  return OBSTACLE_COORDS_SET.has(`${x},${y}`);
};

const JACKPOT_SLICES = [
  { value: 50, color: '#eab308' }, // Golden/Yellow Jackpot
  { value: 5, color: '#ef4444' },  // Vibrant Red
  { value: 20, color: '#3b82f6' }, // Electric Blue
  { value: 10, color: '#10b981' }, // Emerald Green
  { value: 1, color: '#ec4899' },  // Hot Pink
  { value: 30, color: '#8b5cf6' }, // Neon Purple
  { value: 15, color: '#06b6d4' }, // Cyan
  { value: 40, color: '#f97316' }, // Blaze Orange
  { value: 2, color: '#14b8a6' },  // Teal
  { value: 25, color: '#a855f7' }, // Lavender/Purple
  { value: 8, color: '#f43f5e' },  // Rose
  { value: 35, color: '#6366f1' }  // Indigo
];

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<{ displayName: string, totalDonated: number, currentTokens: number } | null>(null);
  const [leaderboard, setLeaderboard] = useState<{ id: string, displayName: string, totalDonated: number }[]>([]);
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState(false);
  const [isPurchaseModalOpen, setIsPurchaseModalOpen] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [signUpDisplayName, setSignUpDisplayName] = useState("");
  const [isDevMode, setIsDevMode] = useState(false);
  const [isAbilitiesExpanded, setIsAbilitiesExpanded] = useState<boolean>(false);
  const [stripeConfig, setStripeConfig] = useState<{ stripeEnabled: boolean, hasSecretKey: boolean } | null>(null);
  const [paymentSuccessMessage, setPaymentSuccessMessage] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentLoading, setPaymentLoading] = useState<boolean>(false);
  const [customTokenAmount, setCustomTokenAmount] = useState<string>("250");
  const [activePurchaseTab, setActivePurchaseTab] = useState<'stripe' | 'paypal' | 'kofi'>('stripe');
  const [stripeTokenQuantity, setStripeTokenQuantity] = useState<number>(25);
  const [kofiName, setKofiName] = useState("");
  const [kofiTxId, setKofiTxId] = useState("");
  const [kofiAmount, setKofiAmount] = useState<string>("20");
  const [showKofiGuide, setShowKofiGuide] = useState(false);
  const [paypalTxId, setPaypalTxId] = useState("");
  const [showPaypalGuide, setShowPaypalGuide] = useState(false);
  const [devClaimAmount, setDevClaimAmount] = useState<number>(25);
  
  // Fetch Stripe Configuration Status on load
  useEffect(() => {
    fetch("/api/config-status")
      .then(res => res.json())
      .then(data => setStripeConfig(data))
      .catch(err => console.error("Could not fetch stripe config status", err));

    (window as any)._openPurchaseModal = () => {
      setIsPurchaseModalOpen(true);
    };
    return () => {
      delete (window as any)._openPurchaseModal;
    };
  }, []);
  
  const widthSize = 200;
  const heightSize = 250;
  const [liveTracking, setLiveTracking] = useState(false);
  
  const gridRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  
  const transformRef = useRef({ scale: 1, x: 0, y: 0 });
  const isDragging = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const draggedDistanceRef = useRef(0);
  const startScreenPos = useRef({ x: 0, y: 0 });

  // Initial Positions
  const initialBlue = { x: 49, y: 245 };
  const initialRed = { x: 149, y: 245 };

  // Login logic
  const handleLogin = async () => {
    setLoginError(null);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      console.error("Login failed", err);
      if (err.code === "auth/unauthorized-domain") {
        setLoginError(`Domain Unauthorized: "${window.location.hostname}" is not authorized on your Firebase console settings. Please add it to Authorized Domains.`);
      } else if (err.code === "auth/operation-not-allowed") {
        setLoginError('Google Sign-In is disabled in your Firebase console. Please go to Build > Authentication > Sign-in method tab, click "Add new provider", and enable "Google".');
      } else if (err.code === "auth/popup-blocked") {
        setLoginError("Popup was blocked by your browser. Please allow popups or open in a new tab.");
      } else if (err.code === "auth/popup-closed-by-user") {
        setLoginError(`Google sign-in popup closed immediately. Since you're running on custom domain "${window.location.hostname}", this is usually because it is not added to "Authorized Domains" inside your Firebase console settings.`);
      } else {
        setLoginError(err.message || String(err));
      }
    }
  };

  const handleEmailLoginOrSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    if (!email.trim() || !password) {
      setLoginError("Please enter both email and password.");
      return;
    }
    if (password.length < 6) {
      setLoginError("Password must be at least 6 characters.");
      return;
    }
    try {
      if (isSignUp) {
        if (!signUpDisplayName.trim()) {
          setLoginError("Please enter a callsign (display name) for your registry.");
          return;
        }
        const userCred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await updateProfile(userCred.user, {
          displayName: signUpDisplayName.trim()
        });
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (err: any) {
      console.error("Email auth failed", err);
      if (err.code === "auth/email-already-in-use") {
        setLoginError("This email is already registered. Please sign in instead!");
      } else if (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password" || err.code === "auth/user-not-found" || err.code === "auth/invalid-email") {
        setLoginError("Invalid credentials. Please verify your email and password.");
      } else if (err.code === "auth/weak-password") {
        setLoginError("Weak password: must be at least 6 characters.");
      } else {
        setLoginError(err.message || String(err));
      }
    }
  };

  const handleLogout = () => {
    setLoginError(null);
    signOut(auth);
  };

  const buyTokens = async (amount: number) => {
    if (!user) return;
    setPaymentLoading(true);
    setPaymentError(null);
    try {
      // Direct Firestore transaction updates for instant free tokens in production mode!
      const userRef = doc(db, "users", user.uid);
      await updateDoc(userRef, {
        currentTokens: increment(amount),
        totalDonated: increment(amount)
      });
      
      // Increment global charity collection
      const gameRef = doc(db, "games", GAME_ID);
      await setDoc(gameRef, {
        totalRaised: increment(amount)
      }, { merge: true });

      setPaymentSuccessMessage(`✨ Refilled +${amount} Tokens successfully for FREE! Thank you for supporting the humanitarian war game. Your contribution is logged! 🏆`);
      setIsPurchaseModalOpen(false);
    } catch (err: any) {
      console.error("Direct refilling failed", err);
      setPaymentError(err.message || String(err));
    } finally {
      setPaymentLoading(false);
    }
  };

  const creditKofiDonation = async (_dollarValue: number, _supporterName: string, transactionId: string, devAmount?: number) => {
    if (!user) {
      setPaymentError("You must be logged in to claim tokens.");
      return;
    }
    const trimmedTxId = transactionId.trim();
    if (!trimmedTxId) {
      setPaymentError("Please enter your Ko-fi Transaction ID or Receipt Code to claim.");
      return;
    }

    setPaymentLoading(true);
    setPaymentError(null);
    setPaymentSuccessMessage(null);

    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/claim-kofi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${idToken}`
        },
        body: JSON.stringify({ transactionId: trimmedTxId, devAmount })
      });

      if (!response.ok) {
        let errMsg = "Claim failed";
        try {
          const errData = await response.json();
          errMsg = errData.message || errData.error || errMsg;
        } catch (_) {}
        throw new Error(errMsg);
      }

      const data = await response.json();
      setPaymentSuccessMessage(`🎉 ${data.message} +${data.tokensAdded} Tokens credited successfully! ☕`);
      setIsPurchaseModalOpen(false);
      setKofiName("");
      setKofiTxId("");
    } catch (err: any) {
      console.error("Secure claim-kofi failed:", err);
      setPaymentError(err.message || String(err));
    } finally {
      setPaymentLoading(false);
    }
  };

  const creditPaypalDonation = async (transactionId: string, devAmount?: number) => {
    if (!user) {
      setPaymentError("You must be logged in to claim tokens.");
      return;
    }
    const trimmedTxId = transactionId.trim();
    if (!trimmedTxId) {
      setPaymentError("Please enter your PayPal Transaction ID or Order Code to claim.");
      return;
    }

    setPaymentLoading(true);
    setPaymentError(null);
    setPaymentSuccessMessage(null);

    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/claim-paypal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${idToken}`
        },
        body: JSON.stringify({ transactionId: trimmedTxId, devAmount })
      });

      if (!response.ok) {
        let errMsg = "Claim failed";
        try {
          const errData = await response.json();
          errMsg = errData.message || errData.error || errMsg;
        } catch (_) {}
        throw new Error(errMsg);
      }

      const data = await response.json();
      setPaymentSuccessMessage(`🎉 ${data.message} +${data.tokensAdded} Tokens credited successfully! 🚀`);
      setIsPurchaseModalOpen(false);
      setPaypalTxId("");
    } catch (err: any) {
      console.error("Secure claim-paypal failed:", err);
      setPaymentError(err.message || String(err));
    } finally {
      setPaymentLoading(false);
    }
  };

  const handleStripeCheckout = async (tokensCount: number) => {
    if (!user) {
      setPaymentError("You must be logged in to buy tokens.");
      return;
    }

    // Open a blank new tab immediately on the user's click gesture to bypass popup block regulations
    const checkoutWindow = window.open("", "_blank");
    if (checkoutWindow) {
      checkoutWindow.document.write(`
        <html>
          <head>
            <title>Redirecting to Stripe</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background-color: #fdfaf2;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                color: #000;
                text-align: center;
              }
              .border-box {
                border: 4px solid #000;
                padding: 30px;
                background: #fff;
                border-radius: 20px;
                box-shadow: 6px 6px 0px 0px #000;
                max-width: 400px;
              }
              h2 { text-transform: uppercase; margin-top: 0; margin-bottom: 10px; font-weight: 900; font-size: 1.5rem; }
              p { font-size: 14px; opacity: 0.8; margin-bottom: 20px; }
              .spinner {
                display: inline-block;
                width: 30px;
                height: 30px;
                border: 4px solid rgba(0,0,0,.15);
                border-radius: 50%;
                border-top-color: #000;
                animation: spin 0.8s linear infinite;
              }
              @keyframes spin { to { transform: rotate(360deg); } }
            </style>
          </head>
          <body>
            <div class="border-box">
              <h2>🔒 Secure Checkout</h2>
              <p>Preparing Stripe secure payment session...</p>
              <div class="spinner"></div>
            </div>
          </body>
        </html>
      `);
    }

    setPaymentLoading(true);
    setPaymentError(null);
    try {
      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tokens: tokensCount,
          userId: user.uid,
        }),
      });

      if (!response.ok) {
        let errMsg = "Stripe checkout creation failed";
        try {
          const errData = await response.json();
          errMsg = errData.message || errData.error || errMsg;
        } catch (_) {}
        throw new Error(errMsg);
      }

      const data = await response.json();
      if (data.url) {
        if (checkoutWindow) {
          checkoutWindow.location.href = data.url;
        } else {
          window.location.href = data.url;
        }
      } else {
        throw new Error("Could not retrieve checkout url");
      }
    } catch (err: any) {
      console.error("Stripe checkout failed:", err);
      if (checkoutWindow) {
        checkoutWindow.close();
      }
      setPaymentError(err.message || String(err));
    } finally {
      setPaymentLoading(false);
    }
  };

  // Sync Auth and User Profile
  useEffect(() => {
    let unsubUser: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (u) => {
      // Clean up previous listener if any
      if (unsubUser) {
        unsubUser();
        unsubUser = null;
      }

      setUser(u);
      if (u) {
        const userRef = doc(db, "users", u.uid);
        unsubUser = onSnapshot(userRef, (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            if (data.launchRef !== "launch_v1") {
              const tempName = data.displayName || u.displayName || "Unknown Wanderer";
              const cleanProfile = {
                displayName: tempName,
                photoURL: data.photoURL || u.photoURL || "https://api.dicebear.com/7.x/bottts/svg?seed=" + encodeURIComponent(tempName),
                totalDonated: 0,
                currentTokens: 5, // Reset to standard starting tokens
                kofiClaims: [],
                launchRef: "launch_v1",
                updatedAt: serverTimestamp()
              };
              setDoc(userRef, cleanProfile);
              setProfile(cleanProfile as any);
              setPaymentSuccessMessage("Welcome to the Official Launch of Baby Push! Dev mode is complete and accounts have been reset. Enjoy your 5 launching free tokens! 🍼🛡️");
            } else {
              setProfile(data as any);
            }
          } else {
            // Create profile
            const tempName = u.displayName || signUpDisplayName || "Unknown Wanderer";
            const newProfile = {
              displayName: tempName,
              photoURL: u.photoURL || "https://api.dicebear.com/7.x/bottts/svg?seed=" + encodeURIComponent(tempName),
              totalDonated: 0,
              currentTokens: 5,
              kofiClaims: [],
              launchRef: "launch_v1",
              updatedAt: serverTimestamp()
            };
            setDoc(userRef, newProfile);
            setProfile(newProfile as any);
            setPaymentSuccessMessage("Welcome to the Official Launch of Baby Push! You have been credited with 5 courtesy tokens as a welcome gift! Go control the strollers or deploy tactical support! 🍼🛡️");
          }
        }, (err: any) => {
          console.error("Error subscribing to user profile:", err);
          handleFirestoreError(err, 'listen', `users/${u.uid}`);
          
          if (err.code === "permission-denied") {
            setLoginError(`Firestore Permission Denied on user profile. Please deploy your "firestore.rules" file to your Firebase console.`);
          } else {
            setLoginError(`Profile loading error: ${err.message || err.code}`);
          }
        });
      } else {
        setProfile(null);
      }
    });

    return () => {
      unsubAuth();
      if (unsubUser) {
        unsubUser();
      }
    };
  }, []);

  // Sync Leaderboard (filtered to launch_v1 for official launch)
  useEffect(() => {
    const q = query(collection(db, "users"), orderBy("totalDonated", "desc"), limit(100));
    const unsub = onSnapshot(q, (snap) => {
      const donors = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as any))
        .filter(d => d.launchRef === "launch_v1" && d.totalDonated > 0);
      setLeaderboard(donors.slice(0, 10));
    });
    return () => unsub();
  }, []);

  // Handle Stripe Success Return
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    const paymentStatus = params.get("payment");

    if (paymentStatus === "success" && sessionId) {
      const verify = async () => {
        const res = await fetch(`/api/verify-payment?session_id=${sessionId}`);
        const data = await res.json();
        if (data.status === "paid") {
          // Update local state and trigger firebase update if needed
          const userRef = doc(db, "users", data.userId);
          await updateDoc(userRef, {
            currentTokens: increment(data.tokens)
          });
          if (data.isSandbox) {
            setPaymentSuccessMessage(`⚙️ Sandbox Refill: Successfully simulated refilling ${data.tokens} tokens! [Stripe environment variable is not configured on Vercel yet, so Sandbox Mode was automatically activated]`);
          } else {
            setPaymentSuccessMessage(`Refilled ${data.tokens} tokens successfully! Your direct contribution has been logged for global humanitarian aid.`);
          }
          // Clean up URL
          window.history.replaceState({}, document.title, "/");
        }
      };
      verify();
    }
  }, []);

  const [bluePos, setBluePos] = useState(initialBlue);
  const [redPos, setRedPos] = useState(initialRed);

  // Custom Sponsorship states
  const [sponsoredBabies, setSponsoredBabies] = useState<any[]>([]);
  const [selectedBabyId, setSelectedBabyId] = useState<string>('none');
  const [isSponsorCreateModalOpen, setIsSponsorCreateModalOpen] = useState(false);
  const [isSponsorListModalOpen, setIsSponsorListModalOpen] = useState(false);
  const [sponsorName, setSponsorName] = useState('');
  const [sponsorColor, setSponsorColor] = useState('#22c55e'); // Green default
  const [sponsorSide, setSponsorSide] = useState<'left' | 'right'>('left');

  // Great Reset states
  const [greatResetEvent, setGreatResetEvent] = useState<any>(null);
  const [showEpicResetAnimation, setShowEpicResetAnimation] = useState(false);
  const [isGreatResetModalOpen, setIsGreatResetModalOpen] = useState(false);
  
  const [blueRot, setBlueRot] = useState(-90);
  const [redRot, setRedRot] = useState(-90);
  
  const [totalRaised, setTotalRaised] = useState(0);
  const [mineAlert, setMineAlert] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<{
    side: 'blue' | 'red',
    type: 'move' | 'grid' | 'jackpot' | 'teleport' | 'wall' | 'mine' | 'slingshot' | 'landmark'
  } | null>(null);

  const [landmarks, setLandmarks] = useState<any[]>([]); // Array of Landmark objects
  const [landmarkName, setLandmarkName] = useState('');
  const [landmarkMessage, setLandmarkMessage] = useState('');
  const [landmarkColor, setLandmarkColor] = useState('#3b82f6');
  const [isLandmarkPlacing, setIsLandmarkPlacing] = useState<{
    name: string;
    message: string;
    color: string;
    side: 'blue' | 'red';
  } | null>(null);
  const [selectedLandmark, setSelectedLandmark] = useState<any | null>(null);

  const [userRole, setUserRole] = useState<'blue' | 'red' | 'admin' | 'none'>('none');
  const [mobileActiveSide, setMobileActiveSide] = useState<'blue' | 'red'>('blue');

  useEffect(() => {
    if (userRole === 'blue' || userRole === 'red') {
      setMobileActiveSide(userRole);
    }
  }, [userRole]);

  const [walls, setWalls] = useState<string[]>([]); // "x,y"
  const [mines, setMines] = useState<string[]>([]); // "x,y"
  const [minesRevealed, setMinesRevealed] = useState(false);
  const [blueMinesRevealed, setBlueMinesRevealed] = useState(false);
  const [redMinesRevealed, setRedMinesRevealed] = useState(false);
  const [logs, setLogs] = useState<{ msg: string, time: string }[]>([]);
  const [sprintBlue, setSprintBlue] = useState(0); // timestamp until end
  const [sprintRed, setSprintRed] = useState(0); // timestamp until end

  const [isWallBuilding, setIsWallBuilding] = useState<{ side: 'blue' | 'red', budget: number } | null>(null);
  const isWallBuildingRef = useRef<any>(null);
  useEffect(() => {
    isWallBuildingRef.current = isWallBuilding;
  }, [isWallBuilding]);
  const [jackpotResult, setJackpotResult] = useState<number | null>(null);
  const [jackpotSpinning, setJackpotSpinning] = useState<{ side: string, rotation: number, isFinished: boolean, resultValue: number } | null>(null);
  const [isLogOpen, setIsLogOpen] = useState(true);
  
  // Trails - using string keys "x,y"
  const [blueTrail, setBlueTrail] = useState<string[]>([]);
  const [redTrail, setRedTrail] = useState<string[]>([]);

  const [winner, setWinner] = useState<'blue' | 'red' | null>(null);

  const hasBlueSideMines = mines.some(coord => {
    const [mx] = coord.split(',').map(Number);
    return mx < widthSize / 2;
  });
  const hasRedSideMines = mines.some(coord => {
    const [mx] = coord.split(',').map(Number);
    return mx >= widthSize / 2;
  });

  const selectedBaby = useMemo(() => {
    if (selectedBabyId === 'none') return null;
    if (selectedBabyId === 'blue') return { name: 'Blue Baby', color: '#3b82f6', x: bluePos.x, y: bluePos.y };
    if (selectedBabyId === 'red') return { name: 'Red Baby', color: '#ef4444', x: redPos.x, y: redPos.y };
    return sponsoredBabies.find(b => b.id === selectedBabyId);
  }, [selectedBabyId, sponsoredBabies, bluePos, redPos]);

  const selectedName = selectedBaby?.name || 'None';
  const selectedColor = selectedBaby?.color || '#000';
  const selectedPos = { x: selectedBaby?.x || 0, y: selectedBaby?.y || 0 };

  const selectedBabySide = useMemo(() => {
    if (selectedBabyId === 'blue') return 'blue';
    if (selectedBabyId === 'red') return 'red';
    const baby = sponsoredBabies.find(b => b.id === selectedBabyId);
    return baby?.side === 'left' ? 'blue' : 'red';
  }, [selectedBabyId, sponsoredBabies]);

  const selectedSprintActive = useMemo(() => {
    const isBlue = selectedBabySide === 'blue';
    const sprintEnd = isBlue ? sprintBlue : sprintRed;
    return sprintEnd > Date.now();
  }, [selectedBabySide, sprintBlue, sprintRed]);

  const selectedSideHasMines = useMemo(() => {
    return selectedBabySide === 'blue' ? hasBlueSideMines : hasRedSideMines;
  }, [selectedBabySide, hasBlueSideMines, hasRedSideMines]);

  const selectedSideMinesRevealed = useMemo(() => {
    return selectedBabySide === 'blue' ? blueMinesRevealed : redMinesRevealed;
  }, [selectedBabySide, blueMinesRevealed, redMinesRevealed]);

  const [isInitializing, setIsInitializing] = useState(true);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [selectedExplainerButton, setSelectedExplainerButton] = useState<'move' | 'push' | 'tele' | 'wall' | 'mine' | 'sling' | 'landmark' | 'lucky'>('move');

  // Check win conditions (Finish Line goals at y <= 8)
  useEffect(() => {
    if (bluePos.y <= 8 && !winner && !isInitializing) {
      setWinner('blue');
      addLog("🏆 CHAMPIONSHIP LEG COMPLETED! Blue team crossed the Finish Line! 🍼🎉");
      // Credit bonus tokens on successful goal
      if (user) {
        const userRef = doc(db, "users", user.uid);
        updateDoc(userRef, { currentTokens: increment(100) })
          .then(() => {
            addLog("🎁 CHAMPIONSHIP LEG REWARD: Blue team earned 100 bonus tokens!");
          })
          .catch((err) => {
            console.error("Failed to credit win tokens:", err);
            setProfile(p => p ? { ...p, currentTokens: p.currentTokens + 100 } : null);
          });
      } else {
        setProfile(p => p ? { ...p, currentTokens: p.currentTokens + 100 } : null);
      }
    }
  }, [bluePos.y, winner, isInitializing, user]);

  useEffect(() => {
    if (redPos.y <= 8 && !winner && !isInitializing) {
      setWinner('red');
      addLog("🏆 CHAMPIONSHIP LEG COMPLETED! Red team crossed the Finish Line! 🍼🎉");
      // Credit bonus tokens on successful goal
      if (user) {
        const userRef = doc(db, "users", user.uid);
        updateDoc(userRef, { currentTokens: increment(100) })
          .then(() => {
            addLog("🎁 CHAMPIONSHIP LEG REWARD: Red team earned 100 bonus tokens!");
          })
          .catch((err) => {
            console.error("Failed to credit win tokens:", err);
            setProfile(p => p ? { ...p, currentTokens: p.currentTokens + 100 } : null);
          });
      } else {
        setProfile(p => p ? { ...p, currentTokens: p.currentTokens + 100 } : null);
      }
    }
  }, [redPos.y, winner, isInitializing, user]);

  useEffect(() => {
    const hasSeenOnboarding = localStorage.getItem("babypush_onboarded_v3");
    if (!hasSeenOnboarding) {
      setIsOnboardingOpen(true);
    }
  }, []);

  const handleCloseOnboarding = () => {
    localStorage.setItem("babypush_onboarded_v3", "true");
    setIsOnboardingOpen(false);
  };

  const canControl = (sideId: string) => {
    if (!user) return false;
    if (userRole === 'admin') return true;
    
    // Check if it's a sponsored baby
    const customBaby = sponsoredBabies.find(b => b.id === sideId);
    if (customBaby) {
      // Anyone who owns it can control, or anyone on its lane side can control!
      if (customBaby.ownerUid === user.uid) return true;
      const associatedSide = customBaby.side === 'left' ? 'blue' : 'red';
      return userRole === associatedSide;
    }
    
    return userRole === sideId;
  };

  const calculateActualSteps = (sideId: string, steps: number) => {
    const customBaby = sponsoredBabies.find(b => b.id === sideId);
    const primarySide = customBaby ? (customBaby.side === 'left' ? 'blue' : 'red') : sideId;
    const isSprinting = (primarySide === 'blue' ? sprintBlue : sprintRed) > Date.now();
    return isSprinting ? steps * 2 : steps;
  };

  // Sync with Firestore
  useEffect(() => {
    const gameRef = doc(db, "games", GAME_ID);

    // Initial check/setup
    const initGame = async () => {
      try {
        const snap = await getDoc(gameRef);
        if (!snap.exists()) {
          await setDoc(gameRef, {
            bluePos: initialBlue,
            redPos: initialRed,
            blueRot: -90,
            redRot: -90,
            blueTokens: 1000,
            redTokens: 1000,
            blueTrail: [],
            redTrail: [],
            walls: [],
            mines: [],
            minesRevealed: false,
            blueMinesRevealed: false,
            redMinesRevealed: false,
            logs: [{ msg: "🚀 Welcome to the Official Launch of Territory War Grid!", time: new Date().toLocaleTimeString() }],
            sprintBlue: 0,
            sprintRed: 0,
            totalRaised: 0,
            landmarks: [],
            sponsoredBabies: [],
            greatResetEvent: null,
            version: "launch_v1",
            updatedAt: serverTimestamp()
          });
        } else {
          const gameData = snap.data();
          if (gameData.version !== "launch_v1") {
            // FORCE RESET FOR OFFICIAL LAUNCH
            await setDoc(gameRef, {
              bluePos: initialBlue,
              redPos: initialRed,
              blueRot: -90,
              redRot: -90,
              blueTokens: 1000,
              redTokens: 1000,
              blueTrail: [],
              redTrail: [],
              walls: [],
              mines: [],
              minesRevealed: false,
              blueMinesRevealed: false,
              redMinesRevealed: false,
              logs: [{ msg: "🚀 Welcome to the Official Launch of Territory War Grid!", time: new Date().toLocaleTimeString() }],
              sprintBlue: 0,
              sprintRed: 0,
              totalRaised: 0,
              landmarks: [],
              sponsoredBabies: [],
              greatResetEvent: null,
              version: "launch_v1",
              updatedAt: serverTimestamp()
            });
          }
        }
      } catch (e: any) {
        if (e && (e.code === 'unavailable' || (e.message && e.message.includes('offline')))) {
          console.warn("Firestore is running offline or connection not established yet. Transitioning to offline/cache mode.");
        } else {
          handleFirestoreError(e, 'initialize', `games/${GAME_ID}`);
        }
      }
      setIsInitializing(false);
    };
    initGame();

    const unsubscribe = onSnapshot(gameRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        if (!snapshot.metadata.hasPendingWrites) {
          setBluePos(data.bluePos);
          setRedPos(data.redPos);
          setBlueRot(data.blueRot);
          setRedRot(data.redRot);
          setTotalRaised(data.totalRaised || 0);
          setBlueTrail(data.blueTrail || []);
          setRedTrail(data.redTrail || []);
          setWalls(data.walls || []);
          setMines(data.mines || []);
          setMinesRevealed(data.minesRevealed || false);
          setBlueMinesRevealed(data.blueMinesRevealed !== undefined ? data.blueMinesRevealed : (data.minesRevealed || false));
          setRedMinesRevealed(data.redMinesRevealed !== undefined ? data.redMinesRevealed : (data.minesRevealed || false));
          setLogs(data.logs || []);
          setSprintBlue(data.sprintBlue || 0);
          setSprintRed(data.sprintRed || 0);
          setLandmarks(data.landmarks || []);
          setSponsoredBabies(data.sponsoredBabies || []);
          setGreatResetEvent(data.greatResetEvent || null);
        }
      }
    }, (error) => {
      handleFirestoreError(error, 'listen', `games/${GAME_ID}`);
    });

    return () => unsubscribe();
  }, []);

  const lastSeenResetIdRef = useRef<string | null>(null);

  // Sync Great Reset event on mount without triggering it
  useEffect(() => {
    if (greatResetEvent?.id) {
      lastSeenResetIdRef.current = greatResetEvent.id;
    }
  }, []); // Only on mount

  // Sync selectedBabyId when user role updates initially
  useEffect(() => {
    if (userRole === 'blue') {
      setSelectedBabyId('blue');
    } else if (userRole === 'red') {
      setSelectedBabyId('red');
    } else if (userRole === 'admin') {
      setSelectedBabyId('blue');
    } else {
      setSelectedBabyId('none');
    }
  }, [userRole]);

  // Listen to the Great Reset spectacular event
  useEffect(() => {
    if (greatResetEvent && greatResetEvent.id && greatResetEvent.id !== lastSeenResetIdRef.current) {
      lastSeenResetIdRef.current = greatResetEvent.id;
      // Only show if the event is very recent (less than 5 seconds old)
      if (Date.now() - greatResetEvent.timestamp < 5000) {
        setShowEpicResetAnimation(true);
        const timer = setTimeout(() => {
          setShowEpicResetAnimation(false);
        }, 7000);
        return () => clearTimeout(timer);
      }
    }
  }, [greatResetEvent]);

  const addLog = async (msg: string) => {
    const newLog = { msg, time: new Date().toLocaleTimeString() };
    const latestLogs = [newLog, ...logs].slice(0, 10);
    setLogs(latestLogs);
    await updateFirebase({ logs: latestLogs });
  };

  const handleFirestoreError = (error: any, operation: string, path: string) => {
    if (error && (error.code === 'unavailable' || error.code === 'failed-precondition' || (error.message && error.message.toLowerCase().includes('offline')))) {
      console.warn(`[Firestore Offline Sync Mode] ${operation} on ${path}: Operations will sync when online.`);
      return;
    }
    const errInfo = {
      error: error.message || String(error),
      code: error.code,
      operation,
      path,
      authInfo: {
        userId: auth.currentUser?.uid,
        email: auth.currentUser?.email,
      }
    };
    console.error('Firestore Error:', JSON.stringify(errInfo));
  };

  const updateFirebase = async (updates: any) => {
    const path = `games/${GAME_ID}`;
    try {
      const gameRef = doc(db, "games", GAME_ID);
      await setDoc(gameRef, {
        ...updates,
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e: any) {
      handleFirestoreError(e, 'update', path);
    }
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    const grid = gridRef.current;
    if (!viewport || !grid) return;

    // Center the grid beautifully in the viewport on mount
    const vw = viewport.clientWidth || window.innerWidth;
    const vh = viewport.clientHeight || window.innerHeight;
    const gw = widthSize * 4;
    const gh = heightSize * 4;
    const isMobile = window.innerWidth < 768;
    transformRef.current.scale = isMobile ? 0.45 : 1.0;
    transformRef.current.x = (vw - gw * transformRef.current.scale) / 2;
    transformRef.current.y = (vh - gh * transformRef.current.scale) / 2;

    const update = () => {
      grid.style.transform = `translate(${transformRef.current.x}px, ${transformRef.current.y}px) scale(${transformRef.current.scale})`;
    };

    update();

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setLiveTracking(false); // Cancel live tracking on wheel zoom

      const rect = viewport.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Handle pinch-to-zoom or Ctrl+scroll (usually zoom gesture on trackpads and mice)
      if (e.ctrlKey) {
        const zoomSpeed = 0.01;
        const delta = -e.deltaY * zoomSpeed;
        const prevScale = transformRef.current.scale;
        const newScale = Math.min(Math.max(0.15, prevScale + delta), 5);

        transformRef.current.x -= (mx - transformRef.current.x) * (newScale / prevScale - 1);
        transformRef.current.y -= (my - transformRef.current.y) * (newScale / prevScale - 1);
        transformRef.current.scale = newScale;
      } else {
        // Normal trackpad panning / mouse scrolling
        transformRef.current.x -= e.deltaX;
        transformRef.current.y -= e.deltaY;
      }
      update();
    };

    const handleDragStart = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // Only left mouse button trigger drag
      if ((e.target as HTMLElement).closest('button, input, select, textarea, a') || isWallBuildingRef.current) return;
      
      // Prevent browser default selection or scrolling behaviors on drag
      e.preventDefault();
      
      setLiveTracking(false); // Cancel live tracking on manual pan drag
      isDragging.current = true;
      startPos.current = {
        x: e.clientX - transformRef.current.x,
        y: e.clientY - transformRef.current.y
      };
      startScreenPos.current = {
        x: e.clientX,
        y: e.clientY
      };
      draggedDistanceRef.current = 0;
      viewport.style.cursor = 'grabbing';
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      transformRef.current.x = e.clientX - startPos.current.x;
      transformRef.current.y = e.clientY - startPos.current.y;
      
      const dx = e.clientX - startScreenPos.current.x;
      const dy = e.clientY - startScreenPos.current.y;
      draggedDistanceRef.current = Math.hypot(dx, dy);
      
      update();
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      viewport.style.cursor = 'grab';
    };

    // Touch event listeners for seamless mobile/trackpad drag & pinch-to-zoom experience
    let isTouchDragging = false;
    let isPinching = false;
    let touchStartPos = { x: 0, y: 0 };
    let touchStartScreenPos = { x: 0, y: 0 };
    let initialTouchDist = 0;
    let initialScale = 1;
    let initialTouchMid = { x: 0, y: 0 };

    const getTouchDist = (t1: Touch, t2: Touch) => {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.hypot(dx, dy);
    };

    const getTouchMid = (t1: Touch, t2: Touch, r: DOMRect) => {
      return {
        x: (t1.clientX + t2.clientX) / 2 - r.left,
        y: (t1.clientY + t2.clientY) / 2 - r.top
      };
    };

    const handleTouchStart = (e: TouchEvent) => {
      if ((e.target as HTMLElement).closest('button, input, select, textarea, a') || isWallBuildingRef.current) return;
      setLiveTracking(false);

      if (e.touches.length === 1) {
        isTouchDragging = true;
        isPinching = false;
        touchStartPos = {
          x: e.touches[0].clientX - transformRef.current.x,
          y: e.touches[0].clientY - transformRef.current.y
        };
        touchStartScreenPos = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY
        };
        draggedDistanceRef.current = 0;
      } else if (e.touches.length === 2) {
        isTouchDragging = false;
        isPinching = true;
        initialTouchDist = getTouchDist(e.touches[0], e.touches[1]);
        initialScale = transformRef.current.scale;
        const r = viewport.getBoundingClientRect();
        initialTouchMid = getTouchMid(e.touches[0], e.touches[1], r);
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if ((e.target as HTMLElement).closest('button, input, select, textarea, a') || isWallBuildingRef.current) return;
      
      if (isTouchDragging && e.touches.length === 1) {
        e.preventDefault();
        transformRef.current.x = e.touches[0].clientX - touchStartPos.x;
        transformRef.current.y = e.touches[0].clientY - touchStartPos.y;
        
        const dx = e.touches[0].clientX - touchStartScreenPos.x;
        const dy = e.touches[0].clientY - touchStartScreenPos.y;
        draggedDistanceRef.current = Math.hypot(dx, dy);
        
        update();
      } else if (isPinching && e.touches.length === 2) {
        e.preventDefault();
        const dist = getTouchDist(e.touches[0], e.touches[1]);
        if (dist > 0 && initialTouchDist > 0) {
          const factor = dist / initialTouchDist;
          const prevScale = transformRef.current.scale;
          const newScale = Math.min(Math.max(0.15, initialScale * factor), 5);

          const r = viewport.getBoundingClientRect();
          const currentMid = getTouchMid(e.touches[0], e.touches[1], r);

          transformRef.current.x -= (currentMid.x - transformRef.current.x) * (newScale / prevScale - 1);
          transformRef.current.y -= (currentMid.y - transformRef.current.y) * (newScale / prevScale - 1);
          
          transformRef.current.scale = newScale;
          update();
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        isTouchDragging = false;
        isPinching = false;
      } else if (e.touches.length === 1) {
        isPinching = false;
        isTouchDragging = true;
        touchStartPos = {
          x: e.touches[0].clientX - transformRef.current.x,
          y: e.touches[0].clientY - transformRef.current.y
        };
        touchStartScreenPos = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY
        };
      }
    };

    const handleResize = () => {
      update();
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    viewport.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    viewport.addEventListener("dragstart", handleDragStart);
    
    viewport.addEventListener("touchstart", handleTouchStart, { passive: false });
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: false });
    
    window.addEventListener("resize", handleResize);

    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      viewport.removeEventListener("dragstart", handleDragStart);
      
      viewport.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      
      window.removeEventListener("resize", handleResize);
    };
  }, [user]);



  // Center & Lock on player team's baby in real time
  const centerOnBaby = () => {
    const viewport = viewportRef.current;
    const grid = gridRef.current;
    if (!viewport || !grid) return;

    let pos = bluePos;
    if (selectedBabyId === 'red') {
      pos = redPos;
    } else if (selectedBabyId !== 'blue' && selectedBabyId !== 'none') {
      const match = sponsoredBabies.find(b => b.id === selectedBabyId);
      if (match) {
        pos = { x: match.x, y: match.y };
      }
    }

    if (!pos) return;

    const vw = viewport.clientWidth || window.innerWidth;
    const vh = viewport.clientHeight || window.innerHeight;
    const scale = transformRef.current.scale;

    transformRef.current.x = vw / 2 - (pos.x * 4) * scale;
    transformRef.current.y = vh / 2 - (pos.y * 4) * scale;

    grid.style.transform = `translate(${transformRef.current.x}px, ${transformRef.current.y}px) scale(${scale})`;
  };

  useEffect(() => {
    if (liveTracking) {
      centerOnBaby();
    }
  }, [liveTracking, bluePos, redPos, sponsoredBabies, selectedBabyId]);

  const spendTokens = async (side: 'blue' | 'red', cost: number) => {
    if (!user) {
      addLog("You must be logged in to spend tokens!");
      return false;
    }
    if (!profile) {
      addLog("Your profile is still loading or offline. Please wait or try again!");
      return false;
    }
    if (profile.currentTokens < cost) {
      addLog(`Not enough tokens to spend ${cost} tokens! Buy more to support charity.`);
      setIsPurchaseModalOpen(true);
      return false;
    }

    const userRef = doc(db, "users", user.uid);
    try {
      await updateDoc(userRef, {
        currentTokens: increment(-cost),
        totalDonated: increment(cost)
      });
    } catch (e: any) {
      const errMsg = e.message || String(e);
      handleFirestoreError(e, 'update', `users/${user.uid}`);
      addLog(`⚠️ Token DB update failed: ${errMsg.slice(0, 75)}. Operating in client fallback mode!`);
      
      // Resilient Fallback: Set tokens in local state memory so the player is never locked out of gameplay functions!
      setProfile(prev => prev ? {
        ...prev,
        currentTokens: Math.max(0, prev.currentTokens - cost),
        totalDonated: prev.totalDonated + cost
      } : null);
      setTotalRaised(prev => prev + cost);
      
      return true;
    }

    // Global charity counter also goes up
    const gameRef = doc(db, "games", GAME_ID);
    try {
      await setDoc(gameRef, {
        totalRaised: increment(cost),
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) {
      handleFirestoreError(e, 'update', `games/${GAME_ID}`);
      // Don't fail the whole action if global counter failed, but user tokens were taken
    }

    return true;
  };

  const spendTokensSimple = async (cost: number) => {
    if (userRole === 'admin') return true; // Admins represent complete freedom
    if (!user) {
      addLog("You must be logged in to spend tokens!");
      return false;
    }
    if (!profile) {
      addLog("Your profile is still loading. Please try again!");
      return false;
    }
    if (profile.currentTokens < cost) {
      addLog(`Not enough tokens! Sponsoring or resetting requires ${cost} tokens.`);
      setIsPurchaseModalOpen(true);
      return false;
    }

    const userRef = doc(db, "users", user.uid);
    try {
      await updateDoc(userRef, {
        currentTokens: increment(-cost),
        totalDonated: increment(cost)
      });
      
      const gameRef = doc(db, "games", GAME_ID);
      await setDoc(gameRef, {
        totalRaised: increment(cost),
        updatedAt: serverTimestamp()
      }, { merge: true });
      
      return true;
    } catch (e: any) {
      console.warn("Client fallback trigger activated", e);
      setProfile(prev => prev ? {
        ...prev,
        currentTokens: Math.max(0, prev.currentTokens - cost),
        totalDonated: prev.totalDonated + cost
      } : null);
      setTotalRaised(prev => prev + cost);
      return true;
    }
  };

  const triggerGreatReset = async (target: 'blue' | 'red' | 'both' | string) => {
    if (userRole !== 'admin') {
      const success = await spendTokensSimple(1000);
      if (!success) return;
    }

    const newResetId = "reset-" + Date.now();
    let targetDesc = '';
    let updates: any = {};

    if (target === 'blue' || target === 'both') {
      updates.bluePos = initialBlue;
      updates.blueTrail = [];
      updates.blueRot = -90;
      setBluePos(initialBlue);
      setBlueRot(-90);
      setBlueTrail([]);
      targetDesc += 'Blue Team';
    }

    if (target === 'red' || target === 'both') {
      updates.redPos = initialRed;
      updates.redTrail = [];
      updates.redRot = -90;
      setRedPos(initialRed);
      setRedRot(-90);
      setRedTrail([]);
      if (targetDesc) targetDesc += ' & ';
      targetDesc += 'Red Team';
    }

    if (target === 'both') {
      targetDesc = 'Entire Battlefield (Both Teams)';
    }

    // Reset Custom Sponsored Baby Progress
    if (target.startsWith('baby-')) {
      const babyId = target;
      const babyObj = sponsoredBabies.find(b => b.id === babyId);
      if (babyObj) {
        targetDesc = `Custom Baby "${babyObj.name}"`;
        const updated = sponsoredBabies.map(b => {
          if (b.id === babyId) {
            return {
              ...b,
              x: b.initialX || 4,
              y: b.initialY || 245,
              trail: [],
              rot: -90
            };
          }
          return b;
        });
        setSponsoredBabies(updated);
        updates.sponsoredBabies = updated;
      }
    }

    if (!targetDesc) {
      targetDesc = target;
    }

    // Embed finalized detail into global broadcast alert
    updates.greatResetEvent = {
      id: newResetId,
      triggeredBy: profile?.displayName || user?.displayName || "Anonymous Commander",
      target: target,
      targetName: targetDesc,
      timestamp: Date.now()
    };

    await addLog(`🚨 ${profile?.displayName || user?.displayName || "Commander"} triggered THE GREAT RESET on ${targetDesc}!`);
    await updateFirebase(updates);
    setIsGreatResetModalOpen(false);
  };

  const handleRemoveSponsoredBaby = async (babyId: string) => {
    const babyObj = sponsoredBabies.find(b => b.id === babyId);
    if (!babyObj) return;

    if (user && (babyObj.ownerUid === user.uid || userRole === 'admin')) {
      const updated = sponsoredBabies.filter(b => b.id !== babyId);
      setSponsoredBabies(updated);
      
      if (selectedBabyId === babyId) {
        setSelectedBabyId(babyObj.side === 'left' ? 'blue' : 'red');
      }

      await addLog(`🍼 SPONSOR BABY REMOVED: "${babyObj.name}" was retired by their sponsor.`);
      await updateFirebase({ sponsoredBabies: updated });
    } else {
      await addLog("Permission denied: You do not own this sponsored baby!");
    }
  };

  const sponsorYourOwnBaby = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sponsorName.trim()) {
      addLog("Please enter a callsign for your sponsored baby.");
      return;
    }

    if (userRole !== 'admin') {
      const success = await spendTokensSimple(500);
      if (!success) return;
    }

    const babyId = "baby-" + Date.now();
    const isLeft = sponsorSide === 'left';
    
    // Each custom sponsored baby gets a dedicated separate 8-column wide track lane.
    // They spawn centered inside their isolated track lane (X: 4, Y: 245).
    const launchX = 4;
    const launchY = 245;

    const newBaby = {
      id: babyId,
      name: sponsorName.trim(),
      color: sponsorColor,
      ownerUid: user?.uid || "unknown",
      ownerName: profile?.displayName || user?.displayName || "Anonymous Spacer",
      x: launchX,
      y: launchY,
      initialX: launchX,
      initialY: launchY,
      rot: -90,
      trail: [],
      side: sponsorSide
    };

    const updated = [...sponsoredBabies, newBaby];
    setSponsoredBabies(updated);
    await updateFirebase({ sponsoredBabies: updated });
    await addLog(`🍼 NEW SPONSOR BABY DEPLOYED: "${newBaby.name}" with signature track color ${newBaby.color}!`);
    
    // Auto-select the newly sponsored baby!
    setSelectedBabyId(babyId);

    // Reset fields & close
    setSponsorName('');
    setIsSponsorCreateModalOpen(false);
  };

  const executeBatchMove = async (sideId: string, targetSideId: string, type: 'move' | 'grid', steps: number, direction: string) => {
    const customTargetBaby = sponsoredBabies.find(b => b.id === targetSideId);
    const customSourceBaby = sponsoredBabies.find(b => b.id === sideId);

    const targetSide = customTargetBaby ? (customTargetBaby.side === 'left' ? 'blue' : 'red') : (targetSideId === 'red' ? 'red' : 'blue');
    const spendingSide = customSourceBaby ? (customSourceBaby.side === 'left' ? 'blue' : 'red') : (sideId === 'red' ? 'red' : 'blue');
    const isLeftTarget = targetSide === 'blue';

    let currentPos = { x: 0, y: 0 };
    let currentTrail: string[] = [];
    let currentRot = -90;
    let babyName = "Baby Stroller";

    if (targetSideId === 'blue') {
      currentPos = bluePos;
      currentTrail = blueTrail;
      currentRot = blueRot;
      babyName = "Blue Team Stroller";
    } else if (targetSideId === 'red') {
      currentPos = redPos;
      currentTrail = redTrail;
      currentRot = redRot;
      babyName = "Red Team Stroller";
    } else if (customTargetBaby) {
      currentPos = { x: customTargetBaby.x, y: customTargetBaby.y };
      currentTrail = customTargetBaby.trail || [];
      currentRot = customTargetBaby.rot || -90;
      babyName = `👶 ${customTargetBaby.name}`;
    } else {
      return;
    }

    const cost = type === 'move' ? steps : steps * 2;
    const success = await spendTokens(spendingSide, cost);
    if (!success) return;

    let nextPos = { ...currentPos };
    let newTrailSegment: string[] = [];
    let nextRot = currentRot;

    const actualSteps = calculateActualSteps(spendingSide, steps);

    for (let i = 0; i < actualSteps; i++) {
        const temp = { ...nextPos };
        if (direction === 'up' && nextPos.y > 0) { nextPos.y -= 1; nextRot = -90; }
        if (direction === 'down' && nextPos.y < heightSize - 1) { nextPos.y += 1; nextRot = 90; }
        if (direction === 'left') {
           if (customTargetBaby) {
             if (nextPos.x > 0) { nextPos.x -= 1; nextRot = -180; }
           } else {
             if (isLeftTarget && nextPos.x > 0) { nextPos.x -= 1; nextRot = 180; }
             else if (!isLeftTarget && nextPos.x > widthSize / 2) { nextPos.x -= 1; nextRot = 180; }
           }
        }
        if (direction === 'right') {
           if (customTargetBaby) {
             if (nextPos.x < 7) { nextPos.x += 1; nextRot = 0; }
           } else {
             if (isLeftTarget && nextPos.x < (widthSize / 2) - 1) { nextPos.x += 1; nextRot = 0; }
             else if (!isLeftTarget && nextPos.x < widthSize - 1) { nextPos.x += 1; nextRot = 0; }
           }
        }
        
        if (nextPos.x !== temp.x || nextPos.y !== temp.y) {
          if (walls.includes(`${nextPos.x},${nextPos.y}`) || isObstacleVal(nextPos.x, nextPos.y)) {
            nextPos = temp; // Blocked
            break;
          }
          if (mines.includes(`${nextPos.x},${nextPos.y}`)) {
            setMineAlert(`🚨 BOOM! "${babyName}" hit a hidden mine! Sanitizing coordinates.`);
            addLog(`💥 "${babyName}" clicked onto a mine field!`);
            if (targetSideId === 'blue') {
              nextPos = initialBlue;
            } else if (targetSideId === 'red') {
              nextPos = initialRed;
            } else if (customTargetBaby) {
              nextPos = { x: customTargetBaby.initialX || 49, y: customTargetBaby.initialY || 245 };
            }
            break;
          }
          newTrailSegment.push(`${temp.x},${temp.y}`);
        } else {
          break;
        }
    }

    const finalTrail = [...currentTrail, ...newTrailSegment];
    const sourceName = customSourceBaby ? `👶 ${customSourceBaby.name}` : (sideId === 'blue' ? 'Blue' : 'Red');
    addLog(`💥 "${sourceName}" used ${cost} tokens to ${type === 'move' ? 'move' : 'push'} "${babyName}" ${actualSteps} steps`);

    const updates: any = {};
    if (targetSideId === 'blue') {
      updates.bluePos = nextPos;
      updates.blueRot = nextRot;
      updates.blueTrail = finalTrail;
      setBluePos(nextPos);
      setBlueRot(nextRot);
      setBlueTrail(finalTrail);
    } else if (targetSideId === 'red') {
      updates.redPos = nextPos;
      updates.redRot = nextRot;
      updates.redTrail = finalTrail;
      setRedPos(nextPos);
      setRedRot(nextRot);
      setRedTrail(finalTrail);
    } else if (customTargetBaby) {
      const updated = sponsoredBabies.map(b => {
        if (b.id === targetSideId) {
          return { ...b, x: nextPos.x, y: nextPos.y, rot: nextRot, trail: finalTrail };
        }
        return b;
      });
      setSponsoredBabies(updated);
      updates.sponsoredBabies = updated;
    }

    await updateFirebase(updates);
  };

  const executeSlingshotLaunch = async (sideId: string, pullX: number, pullY: number, maxPull: number) => {
    const customBaby = sponsoredBabies.find(b => b.id === sideId);
    const spendingSide = customBaby ? (customBaby.side === 'left' ? 'blue' : 'red') : (sideId === 'red' ? 'red' : 'blue');
    const isLeft = spendingSide === 'blue';

    const cost = 100;
    const success = await spendTokens(spendingSide, cost);
    if (!success) return false;

    let currentPos = { x: 0, y: 0 };
    let currentTrail: string[] = [];
    let babyName = "Baby Stroller";

    if (sideId === 'blue') {
      currentPos = bluePos;
      currentTrail = blueTrail;
      babyName = "Blue Team Stroller";
    } else if (sideId === 'red') {
      currentPos = redPos;
      currentTrail = redTrail;
      babyName = "Red Team Stroller";
    } else if (customBaby) {
      currentPos = { x: customBaby.x, y: customBaby.y };
      currentTrail = customBaby.trail || [];
      babyName = `👶 ${customBaby.name}`;
    } else {
      return false;
    }

    // Launch vector is the opposite of pull direction!
    const lX = -pullX;
    const lY = -pullY;
    const pullDistance = Math.sqrt(pullX * pullX + pullY * pullY);
    
    if (pullDistance < 5) return false;

    // Determine launch blocks, max is 25 blocks (corresponding to 100 pixels on grid)
    const ratio = Math.min(1, pullDistance / maxPull);
    const steps = Math.ceil(ratio * 25);

    const pullAngle = Math.atan2(lY, lX);
    const targetDeltaX = Math.round(Math.cos(pullAngle) * steps);
    const targetDeltaY = Math.round(Math.sin(pullAngle) * steps);

    // Calculate flight angle for baby rotation
    const flightAngleRad = Math.atan2(targetDeltaY, targetDeltaX);
    const nextRot = Math.round((flightAngleRad * 180) / Math.PI);

    // Track steps on grid
    const linePoints: { x: number; y: number }[] = [];
    const stepsCount = Math.max(Math.abs(targetDeltaX), Math.abs(targetDeltaY));

    if (stepsCount > 0) {
      for (let s = 1; s <= stepsCount; s++) {
        const t = s / stepsCount;
        const px = Math.round(currentPos.x + targetDeltaX * t);
        const py = Math.round(currentPos.y + targetDeltaY * t);
        if (
          linePoints.length === 0 ||
          linePoints[linePoints.length - 1].x !== px ||
          linePoints[linePoints.length - 1].y !== py
        ) {
          linePoints.push({ x: px, y: py });
        }
      }
    }

    let nextPos = { ...currentPos };
    let newTrailSegment: string[] = [];

    for (const pt of linePoints) {
      let inBound = false;
      if (customBaby) {
        if (pt.x >= 0 && pt.x <= 7 && pt.y >= 0 && pt.y < heightSize) {
          inBound = true;
        }
      } else {
        if (isLeft) {
          if (pt.x >= 0 && pt.x < widthSize / 2 && pt.y >= 0 && pt.y < heightSize) {
            inBound = true;
          }
        } else {
          if (pt.x >= widthSize / 2 && pt.x < widthSize && pt.y >= 0 && pt.y < heightSize) {
            inBound = true;
          }
        }
      }

      if (!inBound) break; // Terminate flight at map boundary

      if (walls.includes(`${pt.x},${pt.y}`) || isObstacleVal(pt.x, pt.y)) {
        break; // Terminate flight (blocked by wall or obstacle)
      }

      if (mines.includes(`${pt.x},${pt.y}`)) {
        setMineAlert(`🚨 BOOM! "${babyName}" slingshot hit a hidden mine! Resetting coordinates.`);
        addLog(`💥 "${babyName}" slingshot launched onto a mine!`);
        if (sideId === 'blue') {
          nextPos = initialBlue;
        } else if (sideId === 'red') {
          nextPos = initialRed;
        } else if (customBaby) {
          nextPos = { x: customBaby.initialX || 49, y: customBaby.initialY || 245 };
        }
        break;
      }

      newTrailSegment.push(`${nextPos.x},${nextPos.y}`);
      nextPos = pt;
    }

    const finalTrail = [...currentTrail, ...newTrailSegment];
    addLog(`🏹 "${babyName}" launched ${steps} flight blocks via Slingshot!`);

    const updates: any = {};
    if (sideId === 'blue') {
      updates.bluePos = nextPos;
      updates.blueRot = nextRot;
      updates.blueTrail = finalTrail;
      setBluePos(nextPos);
      setBlueRot(nextRot);
      setBlueTrail(finalTrail);
    } else if (sideId === 'red') {
      updates.redPos = nextPos;
      updates.redRot = nextRot;
      updates.redTrail = finalTrail;
      setRedPos(nextPos);
      setRedRot(nextRot);
      setRedTrail(finalTrail);
    } else if (customBaby) {
      const updated = sponsoredBabies.map(b => {
        if (b.id === sideId) {
          return { ...b, x: nextPos.x, y: nextPos.y, rot: nextRot, trail: finalTrail };
        }
        return b;
      });
      setSponsoredBabies(updated);
      updates.sponsoredBabies = updated;
    }

    await updateFirebase(updates);
    return true;
  };

  const handleBatchMove = async (steps: number, direction: string) => {
    if (!activeModal) return;
    const { side, type } = activeModal;
    if (type !== 'move' && type !== 'grid') return;

    const targetSideSide = type === 'move' ? side : (side === 'blue' ? 'red' : 'blue');
    // Close modal instantly on confirm click so the UI feels snappy and fast!
    setActiveModal(null);
    await executeBatchMove(side, targetSideSide, type, steps, direction);
  };

  const handleZoom = (direction: 'in' | 'out') => {
    const grid = gridRef.current;
    const viewport = viewportRef.current;
    if (!grid || !viewport) return;

    const zoomStep = 0.2;
    const prevScale = transformRef.current.scale;
    const newScale = Math.min(Math.max(0.2, direction === 'in' ? prevScale + zoomStep : prevScale - zoomStep), 5);

    if (newScale === prevScale) return;

    const isMobile = window.innerWidth < 768;
    if (isMobile) {
      const vw = viewport.clientWidth || window.innerWidth;
      const vh = viewport.clientHeight || window.innerHeight;
      const gw = widthSize * 4;
      const gh = heightSize * 4;
      transformRef.current.x = (vw - gw * newScale) / 2;
      transformRef.current.y = (vh - gh * newScale) / 2;
    } else {
      const rect = viewport.getBoundingClientRect();
      const mx = rect.width / 2;
      const my = rect.height / 2;

      transformRef.current.x -= (mx - transformRef.current.x) * (newScale / prevScale - 1);
      transformRef.current.y -= (my - transformRef.current.y) * (newScale / prevScale - 1);
    }
    transformRef.current.scale = newScale;

    grid.style.transform = `translate(${transformRef.current.x}px, ${transformRef.current.y}px) scale(${transformRef.current.scale})`;
  };

  const handleJackpot = async (sideId: string) => {
    const customBaby = sponsoredBabies.find(b => b.id === sideId);
    const spendingSide = customBaby ? (customBaby.side === 'left' ? 'blue' : 'red') : (sideId === 'red' ? 'red' : 'blue');

    const cost = 10;
    const success = await spendTokens(spendingSide, cost);
    if (!success) return;
    
    // Choose index from the JACKPOT_SLICES list
    const idx = Math.floor(Math.random() * JACKPOT_SLICES.length);
    const result = JACKPOT_SLICES[idx].value;
    
    // Calculate precise target rotation angle
    const segmentAngle = idx * 30 + 15;
    const targetAngle = -90 - segmentAngle; // aligns segment center with 12 o'clock pointer
    const finalRotation = 360 * 6 + targetAngle; // 6 full clockwise turns + alignment offset
    
    // Close the original prompt modal to let the wheel shine
    setActiveModal(null);
    
    // Begin wheel spin
    setJackpotSpinning({
      side: sideId as any,
      rotation: finalRotation,
      isFinished: false,
      resultValue: result
    });
    
    const babyName = customBaby ? `👶 ${customBaby.name}` : (sideId === 'blue' ? 'Blue' : 'Red');
    addLog(`🎰 "${babyName}" initiated the Jackpot fortune spin...`);
  };

  const handleTeleport = async (sideId: string) => {
    setActiveModal(null); // Instantly dismiss modal popup!
    const customBaby = sponsoredBabies.find(b => b.id === sideId);
    const spendingSide = customBaby ? (customBaby.side === 'left' ? 'blue' : 'red') : (sideId === 'red' ? 'red' : 'blue');
    const isLeft = spendingSide === 'blue';

    const cost = 5;
    const success = await spendTokens(spendingSide, cost);
    if (!success) return;
    
    let currentPos = { x: 0, y: 0 };
    let currentTrail: string[] = [];
    let babyName = "Baby Stroller";

    if (sideId === 'blue') {
      currentPos = bluePos;
      currentTrail = blueTrail;
      babyName = "Blue Team Stroller";
    } else if (sideId === 'red') {
      currentPos = redPos;
      currentTrail = redTrail;
      babyName = "Red Team Stroller";
    } else if (customBaby) {
      currentPos = { x: customBaby.x, y: customBaby.y };
      currentTrail = customBaby.trail || [];
      babyName = `👶 ${customBaby.name}`;
    } else {
      return;
    }

    const dx = Math.floor(Math.random() * 11) - 5;
    const dy = Math.floor(Math.random() * 11) - 5;
    
    let nx = currentPos.x + dx;
    let ny = currentPos.y + dy;
    
    // Bounds check
    nx = Math.max(0, Math.min(widthSize - 1, nx));
    ny = Math.max(0, Math.min(heightSize - 1, ny));
    // Side lock
    if (customBaby) {
      if (customBaby.side === 'left') {
        nx = Math.max(0, Math.min(30, nx));
      } else {
        nx = Math.max(170, Math.min(widthSize - 1, nx));
      }
    } else {
      if (isLeft) nx = Math.min((widthSize / 2) - 1, nx);
      else nx = Math.max(widthSize / 2, nx);
    }

    const update: any = {};

    // Calculate trail for teleport (connecting line)
    const teleportTrail: string[] = [];
    const steps = Math.max(Math.abs(nx - currentPos.x), Math.abs(ny - currentPos.y));
    for (let i = 1; i <= steps; i++) {
        const tx = Math.floor(currentPos.x + (nx - currentPos.x) * (i / steps));
        const ty = Math.floor(currentPos.y + (ny - currentPos.y) * (i / steps));
        teleportTrail.push(`${tx},${ty}`);
    }
    const finalTrail = [...currentTrail, ...teleportTrail];

    if (sideId === 'blue') {
      update.bluePos = { x: nx, y: ny };
      update.blueTrail = finalTrail;
      // Optimistic local state update to render instantly
      setBluePos({ x: nx, y: ny });
      setBlueTrail(finalTrail);
    } else if (sideId === 'red') {
      update.redPos = { x: nx, y: ny };
      update.redTrail = finalTrail;
      // Optimistic local state update to render instantly
      setRedPos({ x: nx, y: ny });
      setRedTrail(finalTrail);
    } else if (customBaby) {
      const updated = sponsoredBabies.map(b => {
        if (b.id === sideId) {
          return { ...b, x: nx, y: ny, trail: finalTrail };
        }
        return b;
      });
      setSponsoredBabies(updated);
      update.sponsoredBabies = updated;
    }
    
    addLog(`🔮 "${babyName}" teleported to ${nx}, ${ny}`);
    await updateFirebase(update);
    setActiveModal(null);
  };

  const handleMinefield = async (sideId: string) => {
    setActiveModal(null); // Instantly dismiss modal popup!
    const customBaby = sponsoredBabies.find(b => b.id === sideId);
    const spendingSide = customBaby ? (customBaby.side === 'left' ? 'blue' : 'red') : (sideId === 'red' ? 'red' : 'blue');
    const isLeft = spendingSide === 'blue';

    const cost = 20;
    const success = await spendTokens(spendingSide, cost);
    if (!success) return;
    
    let newMines = [...mines];
    for (let i = 0; i < 20; i++) {
        // Mine target logic: opponent's side
        let rx, ry;
        if (isLeft) {
            // Target opponent's side (right half)
            rx = Math.floor(Math.random() * (widthSize / 2)) + (widthSize / 2);
        } else {
            // Target opponent's side (left half)
            rx = Math.floor(Math.random() * (widthSize / 2));
        }
        ry = Math.floor(Math.random() * heightSize);
        newMines.push(`${rx},${ry}`);
    }
    setMines(newMines);
    const babyName = customBaby ? `👶 ${customBaby.name}` : (sideId === 'blue' ? 'Blue' : 'Red');
    addLog(`💣 "${babyName}" deployed a minefield in enemy territory!`);
    await updateFirebase({ 
        mines: newMines
    });
    setActiveModal(null);
  };

  const handleSprint = async (sideId: string) => {
    const customBaby = sponsoredBabies.find(b => b.id === sideId);
    const spendingSide = customBaby ? (customBaby.side === 'left' ? 'blue' : 'red') : (sideId === 'red' ? 'red' : 'blue');

    const cost = 10;
    const success = await spendTokens(spendingSide, cost);
    if (!success) return;
    
    const end = Date.now() + 30000;
    if (spendingSide === 'blue') setSprintBlue(end);
    else setSprintRed(end);
    
    const babyName = customBaby ? `👶 ${customBaby.name}` : (sideId === 'blue' ? 'Blue' : 'Red');
    addLog(`⚡ "${babyName}" activated Sprint Mode for 30s!`);
    await updateFirebase({ 
        [spendingSide === 'blue' ? 'sprintBlue' : 'sprintRed']: end
    });
    setActiveModal(null);
  };

  const handleRevealMines = async (side: 'blue' | 'red') => {
    // Only the team whose territory has these mines can reveal them.
    const sideMines = mines.filter(coord => {
      const [mx] = coord.split(',').map(Number);
      return side === 'blue' ? (mx < widthSize / 2) : (mx >= widthSize / 2);
    });

    if (sideMines.length === 0) {
      addLog(`⚠️ Reclaim Notice: There are no mines deployed on ${side === 'blue' ? 'Blue' : 'Red'} territory to reveal!`);
      return;
    }

    const isSideRevealed = side === 'blue' ? blueMinesRevealed : redMinesRevealed;
    if (isSideRevealed) {
      addLog(`⚠️ Reclaim Notice: Mines on specified ${side === 'blue' ? 'Blue' : 'Red'} territory are already revealed!`);
      return;
    }

    const cost = 100;
    const success = await spendTokens(side, cost);
    if (!success) return;

    if (side === 'blue') {
      setBlueMinesRevealed(true);
      await updateFirebase({ blueMinesRevealed: true });
    } else {
      setRedMinesRevealed(true);
      await updateFirebase({ redMinesRevealed: true });
    }
    
    addLog(`👁️ ${side === 'blue' ? 'Blue' : 'Red'} paid ${cost} tokens and revealed hidden enemy mines in their territory!`);
  };

  const handleClearMines = async (side: 'blue' | 'red') => {
    const sideMines = mines.filter(coord => {
      const [mx] = coord.split(',').map(Number);
      return side === 'blue' ? (mx < widthSize / 2) : (mx >= widthSize / 2);
    });

    if (sideMines.length === 0) {
      addLog(`⚠️ Reclaim Notice: There are no mines in ${side === 'blue' ? 'Blue' : 'Red'} territory to clear!`);
      return;
    }

    const isSideRevealed = side === 'blue' ? blueMinesRevealed : redMinesRevealed;
    if (!isSideRevealed) {
      addLog(`⚠️ Reclaim Notice: You must reveal hidden mines before you can clear them!`);
      return;
    }

    const cost = 150;
    const success = await spendTokens(side, cost);
    if (!success) return;

    // Remaining mines on the opposite player's side
    const remainingMines = mines.filter(coord => {
      const [mx] = coord.split(',').map(Number);
      return side === 'blue' ? (mx >= widthSize / 2) : (mx < widthSize / 2);
    });

    setMines(remainingMines);
    if (side === 'blue') {
      setBlueMinesRevealed(false);
      await updateFirebase({
        mines: remainingMines,
        blueMinesRevealed: false
      });
    } else {
      setRedMinesRevealed(false);
      await updateFirebase({
        mines: remainingMines,
        redMinesRevealed: false
      });
    }

    addLog(`🧹 ${side === 'blue' ? 'Blue' : 'Red'} paid ${cost} tokens and cleared all enemy mines in their territory!`);
  };

  const handleGridClick = async (e: React.MouseEvent) => {
    // If we've dragged more than 5 pixels, ignore this click as it was likely a pan update
    if (draggedDistanceRef.current > 5) {
      draggedDistanceRef.current = 0;
      return;
    }

    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const x = Math.floor((e.clientX - rect.left) / (4 * transformRef.current.scale));
    const y = Math.floor((e.clientY - rect.top) / (4 * transformRef.current.scale));

    // Case 1: Placing a 4x4 landmark!
    if (isLandmarkPlacing) {
      if (x < 0 || x > widthSize - 4 || y < 0 || y > heightSize - 4) {
        addLog("🏰 Landmark Notice: Landmark must be fully within map boundaries (top-left placement out of bounds)!");
        return;
      }

      const cost = 50;
      const side = isLandmarkPlacing.side;
      const success = await spendTokens(side, cost);
      if (!success) {
        setIsLandmarkPlacing(null);
        return;
      }

      const creatorName = user?.email?.split('@')[0] || (side === 'blue' ? 'Blue Leader' : 'Red Leader');
      const newLandmark = {
        id: `landmark-${Date.now()}`,
        x,
        y,
        name: isLandmarkPlacing.name || "Sovereign Outpost",
        message: isLandmarkPlacing.message || "A majestic monument stands here!",
        color: isLandmarkPlacing.color || (side === 'blue' ? '#3b82f6' : '#ef4444'),
        creatorSide: side,
        creatorName,
        createdAt: Date.now()
      };

      const updatedLandmarks = [...landmarks, newLandmark];
      setLandmarks(updatedLandmarks);
      addLog(`🏰 ${side === 'blue' ? 'Blue' : 'Red'} built landmark "${newLandmark.name}" at (${x},${y})!`);
      setIsLandmarkPlacing(null);
      await updateFirebase({
        landmarks: updatedLandmarks
      });
      return;
    }

    // Case 2: Building wall pixels
    if (isWallBuilding) {
      if (isObstacleVal(x, y)) {
        addLog("🚧 Core Battle Notice: Erecting custom barriers on permanent structures is forbidden!");
        return;
      }

      const side = isWallBuilding.side;
      const customBaby = sponsoredBabies.find(b => b.id === side);

      // Determine side-specific bounds for row blockage check
      const minX = customBaby ? 0 : (side === 'blue' ? 0 : Math.floor(widthSize / 2));
      const maxX = customBaby ? 7 : (side === 'blue' ? Math.floor(widthSize / 2) - 1 : widthSize - 1);
      const sideWidth = maxX - minX + 1;

      // Count blocked cells on row y including the new proposed cell
      let blockedCount = 0;
      for (let tx = minX; tx <= maxX; tx++) {
        const isProposed = (tx === x);
        const isExistingWall = walls.includes(`${tx},${y}`);
        const isPermanentObstacle = isObstacleVal(tx, y);
        const isLandmarkObstacle = landmarks && landmarks.some(lm => {
          return tx >= lm.x && tx < lm.x + 4 && y >= lm.y && y < lm.y + 4;
        });

        if (isProposed || isExistingWall || isPermanentObstacle || isLandmarkObstacle) {
          blockedCount++;
        }
      }

      if (blockedCount >= sideWidth) {
        addLog(`🚧 Blockade Refused: Completely barricading row ${y} is forbidden. You must leave at least one passable space!`);
        return;
      }

      const costPerPixel = 2;
      const success = await spendTokens(side, costPerPixel);
      if (!success) return;

      const newWalls = [...walls, `${x},${y}`];
      
      const newBudget = isWallBuilding.budget - costPerPixel;

      setWalls(newWalls);
      const babyName = customBaby ? `👶 ${customBaby.name}` : (side === 'blue' ? 'Blue' : 'Red');
      addLog(`${babyName} built a wall pixel at ${x},${y}`);
      await updateFirebase({ 
          walls: newWalls
      });

      if (newBudget <= 0) {
        setIsWallBuilding(null);
      } else {
        setIsWallBuilding({ ...isWallBuilding, budget: newBudget });
      }
      return;
    }

    // Case 3: Inspecting a landmark
    const clickedLandmark = landmarks.find(lm => {
      return x >= lm.x && x < lm.x + 4 && y >= lm.y && y < lm.y + 4;
    });

    if (clickedLandmark) {
      setSelectedLandmark(clickedLandmark);
    }
  };

  const handleReset = async () => {
    const updates = {
      bluePos: initialBlue,
      redPos: initialRed,
      blueRot: -90,
      redRot: -90,
      blueTokens: 1000,
      redTokens: 1000,
      blueTrail: [],
      redTrail: [],
      walls: [],
      mines: [],
      minesRevealed: false,
      blueMinesRevealed: false,
      redMinesRevealed: false,
      logs: [{ msg: "🚀 Field fully purged & reset to Launch Mode! Ready for action.", time: new Date().toLocaleTimeString() }],
      sprintBlue: 0,
      sprintRed: 0,
      sponsoredBabies: [],
      totalRaised: 0,
      landmarks: [],
      version: "launch_v1"
    };
    
    setBluePos(initialBlue);
    setRedPos(initialRed);
    setBlueRot(-90);
    setRedRot(-90);
    setBlueTrail([]);
    setRedTrail([]);
    setWalls([]);
    setMines([]);
    setMinesRevealed(false);
    setBlueMinesRevealed(false);
    setRedMinesRevealed(false);
    setLogs([{ msg: "🚀 Field fully purged & reset to Launch Mode! Ready for action.", time: new Date().toLocaleTimeString() }]);
    setSprintBlue(0);
    setSprintRed(0);
    setSponsoredBabies([]);
    setTotalRaised(0);
    setLandmarks([]);

    await updateFirebase(updates);
  };

  if (!user) {
    return (
      <div 
        className="w-screen h-screen overflow-hidden bg-[#eae6dc] flex items-center justify-center relative font-sans p-4"
        style={{
          backgroundImage: 'radial-gradient(#1e1a15 8%, transparent 8%)',
          backgroundSize: '24px 24px'
        }}
      >
        <motion.div 
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="max-w-md md:max-w-4xl w-full bg-[#fdfaf2] border-4 border-black rounded-3xl p-6 sm:p-10 text-center md:text-left shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden"
        >
          {/* Decorative design banners */}
          <div className="absolute top-0 right-0 w-24 h-6 bg-yellow-400 border-b-4 border-l-4 border-black -skew-x-12 transform translate-x-4 -translate-y-1" />
          <div className="absolute bottom-0 left-0 w-28 h-8 bg-rose-400 border-t-4 border-r-4 border-black -skew-x-12 transform -translate-x-4 translate-y-1" />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-10 lg:gap-12 items-stretch">
            {/* Left Column: Branding, Gift, and Info */}
            <div className="flex flex-col justify-center text-center md:text-left space-y-4">
              {/* Icon/Logo */}
              <div className="text-6xl mb-2 select-none animate-pulse">👶🍼🛡️</div>

              <h1 className="text-3xl sm:text-4xl font-black text-black tracking-tight uppercase leading-none">
                BABY PUSH!
              </h1>
              <p className="text-[10px] text-rose-500 font-extrabold uppercase tracking-widest font-mono">
                🏆 Territory War Grid v2.0 🏆
              </p>

              <p className="text-xs sm:text-sm text-black/85 leading-relaxed font-semibold">
                Drive smart strollers, paint the canvas with your signature team path, deploy strategic fortress barriers, and trigger slingshot launches in real-time.
              </p>

              <div className="bg-yellow-101 border-2 border-black p-4 rounded-2xl text-left shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                <h4 className="text-xs font-black uppercase text-black mb-1 flex items-center gap-1.5">
                  🎁 GIFT FOR NEW COMMANDERS
                </h4>
                <p className="text-[11px] font-bold text-black/80 leading-snug">
                  Every Commander gets <strong className="text-blue-600 font-black">5 Courtesy Tokens</strong> credited to their Google account on first login! No payment required.
                </p>
              </div>
            </div>

            {/* Right Column: Actions and Forms */}
            <div className="md:border-l-2 md:border-dashed md:border-black/15 md:pl-6 lg:pl-10 flex flex-col justify-center">
              <button 
                onClick={handleLogin}
                className="w-full py-4 bg-[#3b82f6] text-white font-black text-xs uppercase tracking-widest rounded-2xl border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-1 active:translate-y-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all cursor-pointer flex items-center justify-center gap-3 mb-4"
              >
                <span className="text-lg">⚙️</span>
                <span>Sign In with Google Account</span>
              </button>

              <div className="my-4 flex items-center justify-center gap-2">
                <div className="h-[2px] bg-black/10 flex-1" />
                <span className="text-[9px] font-black uppercase text-black/55 tracking-wider font-mono">OR ACCESS BY EMAIL</span>
                <div className="h-[2px] bg-black/10 flex-1" />
              </div>

              <form onSubmit={handleEmailLoginOrSignUp} className="space-y-3.5 text-left mb-4">
                {isSignUp && (
                  <div>
                    <label className="text-[10px] font-black uppercase text-black/70 block mb-1">Commander Callsign *</label>
                    <input
                      type="text"
                      placeholder="e.g. Maverick"
                      value={signUpDisplayName}
                      onChange={(e) => setSignUpDisplayName(e.target.value)}
                      className="w-full bg-white border-2 border-black rounded-xl px-3 py-2 font-bold text-xs text-black placeholder-black/40 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] focus:outline-none focus:translate-y-[1px] focus:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)]"
                      required
                    />
                  </div>
                )}
                <div>
                  <label className="text-[10px] font-black uppercase text-black/70 block mb-1">Email Address *</label>
                  <input
                    type="email"
                    placeholder="commander@battlegrid.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-white border-2 border-black rounded-xl px-3 py-2 font-bold text-xs text-black placeholder-black/40 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] focus:outline-none focus:translate-y-[1px] focus:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)]"
                    required
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-black/70 block mb-1">Secret Password *</label>
                  <input
                    type="password"
                    placeholder="••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-white border-2 border-black rounded-xl px-3 py-2 font-bold text-xs text-black placeholder-black/40 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] focus:outline-none focus:translate-y-[1px] focus:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)]"
                    required
                  />
                </div>

                <button
                  type="submit"
                  className={`w-full py-3 ${isSignUp ? 'bg-emerald-400 hover:bg-emerald-500' : 'bg-amber-400 hover:bg-amber-500'} text-black font-black text-xs uppercase tracking-wider rounded-xl border-3 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-[5px_5px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all cursor-pointer text-center block`}
                >
                  {isSignUp ? '✨ DEPLOY ACCOUNT' : '🔑 AUTHORIZED SIGN IN'}
                </button>

                <div className="text-center pt-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setIsSignUp(!isSignUp);
                      setLoginError(null);
                    }}
                    className="text-[9px] text-[#3b82f6] hover:underline font-black uppercase tracking-widest cursor-pointer inline-block"
                  >
                    {isSignUp ? 'Already registered? Sign In Instead' : 'Create Custom Callsign & New Account'}
                  </button>
                </div>
              </form>
            </div>
          </div>

          {loginError && (
            <div className="mt-6 bg-rose-50 border-2 border-rose-500 text-rose-950 p-4 rounded-xl text-left text-[11px] font-bold font-mono">
              <span className="text-rose-600 uppercase font-black block mb-1">⚠️ SIGN IN ISSUE</span>
              <p className="opacity-95 leading-normal">{loginError}</p>
              <div className="border-t border-rose-300 mt-2.5 pt-2 text-[10px] space-y-1 text-black/70">
                <p>Ensure this domain is authorized under <strong className="font-extrabold">Authorized Domains</strong> in your Firebase Console:</p>
                <code className="block bg-white p-1 rounded border border-[#ef4444]/35 text-[10px] text-center select-all mt-1">{window.location.hostname}</code>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div 
      ref={viewportRef}
      className="w-screen h-screen overflow-hidden bg-[#eae6dc] cursor-grab select-none flex items-start justify-start relative font-sans"
      style={{
        backgroundImage: 'radial-gradient(#1e1a15 8%, transparent 8%)',
        backgroundSize: '24px 24px',
        touchAction: 'none'
      }}
    >
      {/* EPIC SPECTACULAR RESETS SCREEN TAKE OVER */}
      {showEpicResetAnimation && (
        <div className="fixed inset-0 z-[1000] flex flex-col items-center justify-center bg-black/95 text-white p-6 font-mono text-center select-none overflow-hidden">
          {/* Neon warning grid */}
          <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,_rgba(0,0,0,0.25)_50%),_linear-gradient(90deg,_rgba(255,0,0,0.06),_rgba(0,255,0,0)_95%)] bg-[size:100%_4px,_6px_100%] pointer-events-none" />
          
          <motion.div 
            initial={{ scale: 0.5, rotate: -15, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ type: "spring", stiffness: 120 }}
            className="relative z-10 max-w-2xl bg-black border-4 border-red-600 rounded-3xl p-8 sm:p-12 shadow-[0_0_50px_10px_rgba(239,68,68,0.5)]"
          >
            {/* Pulsing nuclear icon container */}
            <div className="text-8xl mb-6 select-none animate-bounce">☣️💥🚨</div>
            
            <h1 className="text-4xl sm:text-6xl font-black uppercase tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-red-500 via-yellow-400 to-orange-500">
              THE GREAT RESET
            </h1>
            
            <div className="h-1 bg-gradient-to-r from-transparent via-red-600 to-transparent my-6" />

            <div className="text-base sm:text-lg font-black uppercase tracking-wider text-rose-400 font-mono mb-2">
              🚨 TACTICAL CATACLYSM DETONATED 🚨
            </div>

            <p className="text-sm sm:text-lg text-white/90 leading-relaxed font-bold">
              Commander <span className="text-yellow-400 font-black underline decoration-dashed decoration-2">{greatResetEvent?.triggeredBy || "An Unknown Elder"}</span> spent <span className="text-emerald-400 font-black font-mono">1,000 Faction Tokens</span> to initiate a tactical battlefield clearance on:
            </p>

            <div className="mt-4 px-4 py-3 border-2 border-red-500 bg-red-950/40 rounded-xl inline-block text-xl uppercase font-extrabold text-red-100 tracking-tight shadow-[0_0_15px_rgba(239,68,68,0.4)] animate-pulse">
              🎯 TARGET: {greatResetEvent?.targetName ? greatResetEvent.targetName.toUpperCase() : (greatResetEvent?.target === 'both' ? 'ENTIRE BATTLEGRID (BOTH TEAMS)' : (greatResetEvent?.target === 'blue' ? 'BLUE TEAM STROLLER' : (greatResetEvent?.target === 'red' ? 'RED TEAM STROLLER' : 'CUSTOM SPONSOR BABY')))}
            </div>

            <div className="mt-8 text-[11px] uppercase tracking-widest text-white/50 animate-pulse">
              🛡️ Sanitizing coordinates... purging paths... wiping trail indices...
            </div>
          </motion.div>
        </div>
      )}

      {/* SPONSORED BABIES LIST SIDE CARD */}
      {isSponsorListModalOpen && (
        <div className="fixed left-4 md:left-6 top-32 md:top-24 z-[100] p-0 w-72 max-w-[calc(100vw-32px)]">
          <motion.div 
            initial={{ x: -40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            className="w-full bg-[#fdfaf2] border-4 border-black rounded-3xl p-5 text-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden"
          >
            <div className="flex justify-between items-center border-b-3 border-black pb-2 mb-3">
              <h3 className="font-black text-sm uppercase tracking-wider flex items-center gap-1.5 text-black font-mono">
                <span>🍼</span> Sponsored Babies
              </h3>
              <button 
                type="button"
                onClick={() => setIsSponsorListModalOpen(false)}
                className="w-6 h-6 flex items-center justify-center border border-black bg-rose-500 hover:bg-rose-600 rounded text-white font-mono text-[9px] font-black cursor-pointer shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.2"
              >✕</button>
            </div>

            <div className="space-y-1.5 max-h-[250px] overflow-y-auto pr-1">
              {sponsoredBabies && sponsoredBabies.length === 0 ? (
                <div className="text-[10px] text-gray-500 italic py-6 text-center uppercase font-bold font-sans">
                  No sponsored babies active
                </div>
              ) : (
                sponsoredBabies.map(b => (
                  <div
                    key={b.id}
                    onClick={() => {
                      setSelectedBabyId(b.id);
                      setIsSponsorListModalOpen(false);
                      addLog(`Unit switched to: ${b.name}`);
                    }}
                    className={`w-full flex flex-col p-2 border-2 border-black rounded-xl transition-all text-left cursor-pointer font-black text-xs uppercase ${
                      selectedBabyId === b.id 
                        ? 'bg-orange-100 text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] border-orange-500' 
                        : 'bg-white text-black hover:bg-orange-50'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center gap-1 font-sans font-black text-[10px] uppercase truncate">
                        <span>👶</span>
                        <span className="truncate">{b.name}</span>
                      </div>
                      <div className="flex items-center gap-1.5 font-mono text-[7px] opacity-70">
                        <span>({b.x}, {b.y})</span>
                        {user && (b.ownerUid === user.uid || userRole === 'admin') && (
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              await handleRemoveSponsoredBaby(b.id);
                            }}
                            className="px-1.5 py-0.5 bg-rose-500 hover:bg-rose-600 border border-black rounded text-white font-sans font-black text-[7.5px] uppercase tracking-wider cursor-pointer shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 transition-transform"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-1 text-[7px] font-mono opacity-60">
                      <span>Side: {b.side}</span>
                      <span style={{ color: b.color }} className="font-black">● ACTIVE</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                setIsSponsorListModalOpen(false);
                setIsSponsorCreateModalOpen(true);
              }}
              className="mt-4 w-full py-2 bg-yellow-300 hover:bg-yellow-400 text-black rounded-xl border-2 border-black font-black uppercase text-[9px] tracking-wider transition-all hover:-translate-y-0.5 active:translate-y-0.5 cursor-pointer shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] text-center"
            >
              ➕ Sponsor Your Own (500 T)
            </button>
          </motion.div>
        </div>
      )}

      {/* SPONSOR YOUR BABY MODAL */}
      {isSponsorCreateModalOpen && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="max-w-md w-full bg-[#fdfaf2] border-4 border-black rounded-3xl p-6 sm:p-8 text-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden"
          >
            {/* Visual Header */}
            <div className="text-center mb-4">
              <span className="text-4xl block mb-2 select-none">🍼🛝👶</span>
              <h3 className="font-black text-2xl uppercase tracking-tight text-black">Sponsor Your Own Baby</h3>
              <p className="text-[10px] text-emerald-600 font-extrabold uppercase tracking-wider font-mono">
                🎁 Launch a custom stroller to the war battle grid (500 Tokens)
              </p>
            </div>

            <form onSubmit={sponsorYourOwnBaby} className="space-y-4">
              {/* Name */}
              <div>
                <label className="text-[10px] font-black uppercase tracking-wider block mb-1">Stroller Callsign / Name</label>
                <input 
                  type="text" 
                  value={sponsorName} 
                  onChange={(e) => setSponsorName(e.target.value)} 
                  placeholder="e.g. Speed Demon, Bubble Blow, etc." 
                  maxLength={16}
                  className="w-full bg-white text-black font-bold p-2.5 border-2 border-black rounded-xl focus:outline-none focus:ring-0 placeholder:text-gray-400"
                />
              </div>

              {/* Color Preset Choice */}
              <div>
                <label className="text-[10px] font-black uppercase tracking-wider block mb-1 col-span-full">Signature Laser Path Glow Color</label>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { hex: '#22c55e', name: 'Lime' },
                    { hex: '#06b6d4', name: 'Cyan' },
                    { hex: '#a855f7', name: 'Purple' },
                    { hex: '#ec4899', name: 'Pink' },
                    { hex: '#f97316', name: 'Orange' },
                    { hex: '#eab308', name: 'Gold' },
                    { hex: '#3b82f6', name: 'Blue' },
                    { hex: '#ef4444', name: 'Red' }
                  ].map((preset) => {
                    const isChosen = sponsorColor === preset.hex;
                    return (
                      <button
                        key={`preset-${preset.hex}`}
                        type="button"
                        onClick={() => setSponsorColor(preset.hex)}
                        className={`py-1.5 rounded-lg border-2 border-black font-black text-[9px] uppercase transition-all flex items-center justify-center gap-1 cursor-pointer ${
                          isChosen ? 'bg-black text-white scale-105' : 'bg-white hover:bg-gray-100'
                        }`}
                        style={{ borderRightColor: preset.hex, borderRightWidth: '6px' }}
                      >
                        {preset.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Spawn Side Selector */}
              <div>
                <label className="text-[10px] font-black uppercase tracking-wider block mb-1">Initial Deployment Spawn Territory</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setSponsorSide('left')}
                    className={`py-2 px-3 border-2 border-black rounded-xl font-black text-xs uppercase cursor-pointer transition-all ${
                      sponsorSide === 'left' ? 'bg-[#ebf8ff] border-blue-500 text-blue-700 shadow-[2px_2px_0px_0px_#3b82f6]' : 'bg-white hover:bg-gray-50'
                    }`}
                  >
                    💙 Left (Blue Side)
                  </button>
                  <button
                    type="button"
                    onClick={() => setSponsorSide('right')}
                    className={`py-2 px-3 border-2 border-black rounded-xl font-black text-xs uppercase cursor-pointer transition-all ${
                      sponsorSide === 'right' ? 'bg-[#fff5f5] border-red-500 text-red-700 shadow-[2px_2px_0px_0px_#ef4444]' : 'bg-white hover:bg-gray-50'
                    }`}
                  >
                    ❤️ Right (Red Side)
                  </button>
                </div>
              </div>

              {/* Submit Buttons */}
              <div className="pt-2">
                <button
                  type="submit"
                  className="w-full py-3 bg-emerald-300 hover:bg-emerald-400 text-black border-3 border-black text-xs font-black uppercase tracking-widest rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 transition-all text-center cursor-pointer"
                >
                  🚀 LAUNCH COMPACT {userRole === 'admin' ? 'FREE (ADMIN)' : '500 TOKENS'}
                </button>
              </div>
            </form>

            <div className="text-center mt-4">
              <button 
                type="button"
                onClick={() => setIsSponsorCreateModalOpen(false)}
                className="text-black/55 hover:text-black font-black text-[10px] uppercase tracking-wider underline cursor-pointer"
              >
                Close & Dismiss
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* THE GREAT RESET MODAL */}
      {isGreatResetModalOpen && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="max-w-md w-full bg-[#fdfaf2] border-4 border-black rounded-3xl p-6 sm:p-8 text-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden"
          >
            {/* Pulsing neon red border lines */}
            <div className="absolute inset-x-0 top-0 h-1.5 bg-red-500 animate-pulse" />

            <div className="text-center mb-6">
              <span className="text-5xl block mb-2 select-none animate-bounce">🚨</span>
              <h3 className="font-black text-2xl sm:text-3xl uppercase tracking-tighter text-rose-600">THE GREAT RESET</h3>
              <p className="text-[10px] text-rose-500 font-extrabold uppercase tracking-widest font-mono mt-1">
                💥 Tactical Purge - Clear Paths & Reset Spawn Station 💥
              </p>
            </div>

            <div className="bg-yellow-100 border-2 border-black p-4 rounded-2xl mb-6 text-xs text-left leading-relaxed font-bold">
              ⚡ <strong className="uppercase">Tactical Report:</strong> Running the nuclear purges instantly wipe coordinates and trail markings on the chosen stroller faction.
              <p className="mt-1 text-[11px] text-black/70">Wipe progress, clear obstacles, or reset your custom baby's territory.</p>
            </div>

            <div className="space-y-3">
              <label className="text-[10px] font-black uppercase tracking-wider block mb-1">Target Faction for Elimination:</label>
              
              {/* Reset Blue Stroller */}
              <button
                type="button"
                onClick={() => triggerGreatReset('blue')}
                className="w-full py-2.5 bg-blue-100 hover:bg-blue-200 text-blue-800 border-2 border-black font-black text-xs uppercase rounded-xl flex items-center justify-between px-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 cursor-pointer"
              >
                <span>💙 Reset Blue Team Stroller</span>
                <span className="bg-white border text-[9px] px-1.5 rounded">{userRole === 'admin' ? 'FREE' : '1000 T'}</span>
              </button>

              {/* Reset Red Stroller */}
              <button
                type="button"
                onClick={() => triggerGreatReset('red')}
                className="w-full py-2.5 bg-red-100 hover:bg-red-200 text-red-800 border-2 border-black font-black text-xs uppercase rounded-xl flex items-center justify-between px-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 cursor-pointer"
              >
                <span>❤️ Reset Red Team Stroller</span>
                <span className="bg-white border text-[9px] px-1.5 rounded">{userRole === 'admin' ? 'FREE' : '1000 T'}</span>
              </button>

              {/* Reset All Strollers */}
              <button
                type="button"
                onClick={() => triggerGreatReset('both')}
                className="w-full py-2.5 bg-yellow-400 hover:bg-yellow-500 text-black border-2 border-black font-black text-xs uppercase rounded-xl flex items-center justify-between px-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 cursor-pointer"
              >
                <span>💥 Reset BOTH Core Teams</span>
                <span className="bg-white border text-[9px] px-1.5 rounded">{userRole === 'admin' ? 'FREE' : '1000 T'}</span>
              </button>

              {/* Reset Custom Babies */}
              {sponsoredBabies && sponsoredBabies.length > 0 && (
                <div className="border-t border-black/10 pt-3 space-y-2 max-h-40 overflow-y-auto pr-1">
                  <label className="text-[8.5px] font-black uppercase text-black/50 tracking-wider">Reset Sponsored Baby:</label>
                  {sponsoredBabies.map(b => (
                    <button
                      key={`reset-baby-${b.id}`}
                      type="button"
                      onClick={() => triggerGreatReset(b.id)}
                      className="w-full py-2 bg-white hover:bg-gray-50 border-2 border-black font-black text-xs rounded-xl flex items-center justify-between px-4 shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] cursor-pointer"
                      style={{ borderLeftColor: b.color, borderLeftWidth: '6px' }}
                    >
                      <span className="text-black leading-none uppercase text-[10px]">👶 {b.name}</span>
                      <span className="text-[9px] opacity-70 font-mono">{userRole === 'admin' ? 'FREE' : '1000 T'}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* If player is admin, show full hard clean option */}
              {userRole === 'admin' && (
                <button
                  type="button"
                  onClick={async () => {
                    await handleReset();
                    setIsGreatResetModalOpen(false);
                  }}
                  className="w-full py-2 bg-purple-600 hover:bg-purple-700 text-white border-2 border-black font-black text-xs uppercase rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 cursor-pointer"
                >
                  ⚡ FULL FIELD INSTANT PURGE (ADMIN CLEAN)
                </button>
              )}
            </div>

            <div className="text-center mt-6">
              <button 
                type="button"
                onClick={() => setIsGreatResetModalOpen(false)}
                className="text-black/55 hover:text-black font-black text-[10px] uppercase tracking-wider underline cursor-pointer"
              >
                Dismiss & Dismiss
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Team Selection Overlay */}
      {userRole === 'none' && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-[#eae6dc]/80 backdrop-blur-sm p-4 overflow-y-auto">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="max-w-4xl w-full bg-[#fdfaf2] border-4 border-black rounded-2xl md:rounded-3xl p-5 sm:p-10 md:p-12 text-center shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] md:shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden my-auto"
          >
            {/* Playful neobrutalist corner background strips */}
            <div className="absolute top-0 right-0 w-24 h-6 bg-yellow-400 border-b-4 border-l-4 border-black -skew-x-12 transform translate-x-4 -translate-y-1" />
            <div className="absolute bottom-0 left-0 w-28 h-8 bg-rose-400 border-t-4 border-r-4 border-black -skew-x-12 transform -translate-x-4 translate-y-1" />
            
            <motion.h1 
              initial={{ y: -10 }}
              animate={{ y: 0 }}
              className="text-2xl sm:text-4xl md:text-6xl font-black text-black tracking-tight uppercase"
            >
              Pick Your Side
            </motion.h1>
            <p className="text-black/60 text-[10px] sm:text-xs mt-1 sm:mt-2 uppercase tracking-widest font-mono font-bold mb-6 sm:mb-10">
              ⚡ Territory War Grid v2.0 ⚡
            </p>
            
            <div className="grid grid-cols-2 md:grid-cols-2 gap-3 sm:gap-6 md:gap-8 relative z-10 max-w-3xl mx-auto">
              <button 
                onClick={() => setUserRole('blue')}
                className="group relative overflow-hidden bg-[#3b82f6] text-white border-3 md:border-4 border-black p-3 sm:p-6 md:p-8 rounded-xl md:rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] md:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 hover:-translate-x-0.5 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] md:hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:translate-x-0.5 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all duration-150 cursor-pointer text-center flex flex-col items-center justify-center w-full"
              >
                <div className="mb-3 sm:mb-6 flex items-center justify-center h-20 w-20 sm:h-56 sm:w-56 md:h-64 md:w-64">
                  <img 
                    src="https://lh3.googleusercontent.com/d/1SNCMihirT-5iX9Fp_AZTclJTJ0P5kae4" 
                    alt="Blue Stroller" 
                    className="w-20 h-20 sm:w-56 sm:h-56 md:w-64 md:h-64 object-contain -rotate-90 group-hover:scale-105 transition-transform duration-150 drop-shadow-[4px_4px_0px_rgba(0,0,0,0.3)] sm:drop-shadow-[8px_8px_0px_rgba(0,0,0,0.35)]"
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div className="text-[13px] sm:text-xl md:text-3xl font-black tracking-tight leading-none">TEAM BLUE</div>
                <div className="text-[8px] sm:text-[10px] md:text-[11px] text-blue-100 font-bold uppercase tracking-wider font-mono mt-1 sm:mt-2 leading-none">Strategic Defense</div>
              </button>
              
              <button 
                onClick={() => setUserRole('red')}
                className="group relative overflow-hidden bg-[#ef4444] text-white border-3 md:border-4 border-black p-3 sm:p-6 md:p-8 rounded-xl md:rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] md:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 hover:-translate-x-0.5 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] md:hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:translate-x-0.5 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all duration-150 cursor-pointer text-center flex flex-col items-center justify-center w-full"
              >
                <div className="mb-3 sm:mb-6 flex items-center justify-center h-20 w-20 sm:h-56 sm:w-56 md:h-64 md:w-64">
                  <img 
                    src="https://lh3.googleusercontent.com/d/1MBQVettULlTDGfz3HDLUojv_4kj7dlkx" 
                    alt="Red Stroller" 
                    className="w-20 h-20 sm:w-56 sm:h-56 md:w-64 md:h-64 object-contain -rotate-90 group-hover:scale-105 transition-transform duration-150 drop-shadow-[4px_4px_0px_rgba(0,0,0,0.3)] sm:drop-shadow-[8px_8px_0px_rgba(0,0,0,0.35)]"
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div className="text-[13px] sm:text-xl md:text-3xl font-black tracking-tight leading-none">TEAM RED</div>
                <div className="text-[8px] sm:text-[10px] md:text-[11px] text-red-100 font-bold uppercase tracking-wider font-mono mt-1 sm:mt-2 leading-none">Aggressive Maneuver</div>
              </button>
            </div>
            
            <div className="mt-6 sm:mt-10 flex flex-col sm:flex-row gap-3 items-center justify-center relative z-10 w-full max-w-md mx-auto">
              <button 
                onClick={() => setUserRole('admin')}
                className="w-full sm:w-auto px-4 py-2 bg-yellow-300 text-black border-2 border-black rounded-xl text-[10px] sm:text-xs font-black uppercase tracking-widest hover:bg-yellow-400 transition-colors shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 active:translate-x-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] cursor-pointer"
              >
                🕶️ Spectate / Admin
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Mine Alert Popup */}
      {mineAlert && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <motion.div 
            initial={{ rotate: -5, scale: 0.9 }}
            animate={{ rotate: 0, scale: 1 }}
            className="bg-yellow-300 border-4 border-black p-8 rounded-3xl max-w-sm w-full text-center shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden"
          >
            <div className="text-6xl mb-4 animate-bounce">💥</div>
            <h2 className="text-3xl font-black text-black uppercase tracking-tight">KABOOM!</h2>
            <p className="text-black font-mono text-xs font-bold uppercase tracking-wider mt-2 mb-6">
              You hit an explosive mine and got blown back to spawn!
            </p>
            <button 
              onClick={() => setMineAlert(null)}
              className="w-full py-3 bg-red-500 hover:bg-red-600 text-white font-black border-3 border-black rounded-xl hover:-translate-y-0.5 active:translate-y-0.5 transition-all uppercase text-xs tracking-wider shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] cursor-pointer"
            >
              RE-ENTER ENEMY GRID &rarr;
            </button>
          </motion.div>
        </div>
      )}

      {/* Onboarding / Help Modal */}
      {isOnboardingOpen && (
        <div className="fixed inset-0 z-[350] flex items-center justify-center bg-black/75 backdrop-blur-md p-4 overflow-y-auto">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="max-w-xl w-full bg-[#fdfaf2] border-4 border-black rounded-2xl md:rounded-3xl p-6 sm:p-8 text-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden my-auto animate-fadeIn"
          >
            {/* Title & Close button */}
            <div className="flex justify-between items-center border-b-2 border-black pb-3 mb-4">
              <div className="flex items-center gap-2">
                <span className="text-2xl animate-spin" style={{ animationDuration: '6s' }}>🍼</span>
                <h2 className="text-xl sm:text-2xl font-black uppercase tracking-tight text-black">BABY PUSH! ACADEMY</h2>
              </div>
              <button 
                onClick={handleCloseOnboarding} 
                className="text-gray-600 hover:text-black hover:bg-gray-200 border-2 border-black rounded-xl px-2.5 py-1 text-xs font-black transition-all cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5"
              >
                ✕ Close
              </button>
            </div>

            {/* Step Navigation Tabs */}
            <div className="grid grid-cols-4 gap-1 sm:gap-2 mb-6">
              {[
                { title: "🐣 Goal", icon: "🐣" },
                { title: "🎮 Strategy", icon: "🎮" },
                { title: "🕹️ Buttons", icon: "🕹️" },
                { title: "💝 Charity", icon: "💝" }
              ].map((tab, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setOnboardingStep(idx)}
                  className={`py-1.5 px-1 rounded-xl border-2 border-black font-black text-[9px] sm:text-xs uppercase tracking-tight transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 ${
                    onboardingStep === idx 
                      ? "bg-yellow-300 text-black shadow-[1px_1px_0px_0px_rgba(0,0,0,1)]" 
                      : "bg-white text-black/60 hover:text-black"
                  }`}
                >
                  <span className="mr-1">{tab.icon}</span>{tab.title}
                </button>
              ))}
            </div>

            {/* Slide Content */}
            <div className="min-h-[290px] md:min-h-[280px] flex flex-col justify-between">
              {onboardingStep === 0 && (
                <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
                  <h3 className="text-base sm:text-lg font-black uppercase tracking-tight text-[#3b82f6] mb-2 flex items-center gap-1.5">
                    🐣 Welcome to the Baby Grid!
                  </h3>
                  <p className="text-xs sm:text-sm text-black/80 font-medium leading-relaxed mb-3">
                    Baby Push! is an interactive, real-time multiplayer <strong>Territory War & Goal-Line Race</strong>. Drive your stroller vehicle across the canvas, painting the grid with your team's signature trail to claim territory.
                  </p>
                  <h4 className="text-[10px] font-extrabold uppercase mt-1.5 mb-1 text-black/50 tracking-wider">🏁 Ultimate Win Condition</h4>
                  <p className="text-xs text-black/75 leading-relaxed mb-4">
                    The absolute goal is to steer your team's baby vehicle all the way to the top of the map to cross the <strong>Finish Goal Area</strong>! Or cooperate with teammates to expand total zone paint coverage while obstructing opponents from getting through.
                  </p>
                  <div className="grid grid-cols-2 gap-3 bg-yellow-50 border-2 border-dashed border-black/30 p-3 rounded-xl">
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 bg-[#3b82f6] rounded border border-black flex items-center justify-center text-white text-[10px] font-black">B</div>
                      <span className="text-[11px] font-black uppercase">Team Blue (Left Spawn)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 bg-[#ef4444] rounded border border-black flex items-center justify-center text-white text-[10px] font-black">R</div>
                      <span className="text-[11px] font-black uppercase">Team Red (Right Spawn)</span>
                    </div>
                  </div>
                </motion.div>
              )}

              {onboardingStep === 1 && (
                <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
                  <h3 className="text-base sm:text-lg font-black uppercase tracking-tight text-[#ef4444] mb-2 flex items-center gap-1.5">
                    🛡️ Combat & Weapons
                  </h3>
                  <p className="text-xs sm:text-sm text-black/80 font-medium leading-relaxed mb-3">
                    Navigate manually with your keyboard, or support your faction using <strong>Game Tokens</strong> to launch dynamic tactical operations:
                  </p>
                  <ul className="text-[11px] sm:text-xs text-black/80 font-bold space-y-1.5">
                    <li className="flex items-start gap-1.5">
                      <span>🚧</span>
                      <div><strong>Erect Walls:</strong> Block off narrow choke points and shelter your team's territory from enemy sliders.</div>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span>💣</span>
                      <div><strong>Deploy Minefields:</strong> Seed 20 invisible mines on enemy soil. Detonating a mine blows strikers back to spawn!</div>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span>🏹</span>
                      <div><strong>Baby Slingshot:</strong> Paint dynamic, wide-scale circular zones at great distance with pull-and-release physics.</div>
                    </li>
                  </ul>
                </motion.div>
              )}

              {onboardingStep === 2 && (
                <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
                  <h3 className="text-base sm:text-lg font-black uppercase tracking-tight text-purple-700 mb-1 flex items-center gap-1.5">
                    🕹️ Learn about each Button
                  </h3>
                  <p className="text-[10px] sm:text-xs text-black/60 mb-3 font-black uppercase">
                    Select a button icon to read its tactical role & cost:
                  </p>

                  {/* Button Chooser Row */}
                  <div className="flex flex-wrap gap-1.5 p-2 bg-yellow-50 border-2 border-dashed border-black/30 rounded-xl mb-3 justify-center sm:justify-start">
                    {[
                      { id: 'move', label: '💥 Move', color: 'bg-blue-100' },
                      { id: 'push', label: '♟️ Push', color: 'bg-emerald-100' },
                      { id: 'tele', label: '🔮 Tele', color: 'bg-indigo-100' },
                      { id: 'wall', label: '🚧 Wall', color: 'bg-amber-100' },
                      { id: 'mine', label: '💣 Mine', color: 'bg-red-100' },
                      { id: 'sling', label: '🏹 Sling', color: 'bg-rose-100' },
                      { id: 'landmark', label: '🏰 Mark', color: 'bg-emerald-250' },
                      { id: 'lucky', label: '🎰 Lucky', color: 'bg-yellow-200' },
                    ].map((btn) => (
                      <button
                        key={btn.id}
                        type="button"
                        onClick={() => setSelectedExplainerButton(btn.id as any)}
                        className={`px-2 py-1 text-[9px] font-black uppercase rounded-lg border-2 border-black transition-all cursor-pointer ${
                          selectedExplainerButton === btn.id 
                            ? 'bg-yellow-300 font-extrabold scale-105 shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)]' 
                            : `${btn.color} hover:bg-white/80`
                        }`}
                      >
                        {btn.label}
                      </button>
                    ))}
                  </div>

                  {/* Explainer Box */}
                  <div className="border-2 border-black rounded-xl p-3 bg-white min-h-[95px] text-left shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                    {selectedExplainerButton === 'move' && (
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-black text-xs uppercase text-blue-600">💥 BATCH MOVE</span>
                          <span className="text-[8px] bg-sky-100 text-sky-800 border border-sky-300 px-1 py-0.5 rounded font-black">1 Token / Step</span>
                        </div>
                        <p className="text-[11px] leading-snug text-black/80 font-medium">
                          Slide your baby's stroller a specified distance in a preset direction. Excellent for carving out major initial trails in wide open lanes.
                        </p>
                      </div>
                    )}
                    {selectedExplainerButton === 'push' && (
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-black text-xs uppercase text-emerald-600">♟️ SPACE PUSH</span>
                          <span className="text-[8px] bg-emerald-100 text-emerald-800 border border-emerald-300 px-1 py-0.5 rounded font-black">2 Tokens / Step</span>
                        </div>
                        <p className="text-[11px] leading-snug text-black/80 font-medium">
                          Force-paints and captures nodes in a dense surrounding block around your baby stroller. Essential for defensive claims and establishing blockades.
                        </p>
                      </div>
                    )}
                    {selectedExplainerButton === 'tele' && (
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-black text-xs uppercase text-indigo-600">🔮 INSTANT TELEPORT</span>
                          <span className="text-[8px] bg-indigo-100 text-indigo-800 border border-indigo-300 px-1 py-0.5 rounded font-black">5 Tokens</span>
                        </div>
                        <p className="text-[11px] leading-snug text-black/80 font-medium">
                          Evade traps and solid enemy partitions! Immediately teleports your baby cruiser to a random secure spot within a nearby radius.
                        </p>
                      </div>
                    )}
                    {selectedExplainerButton === 'wall' && (
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-black text-xs uppercase text-amber-600">🚧 ERECT CHOKE WALLS</span>
                          <span className="text-[8px] bg-amber-100 text-amber-800 border border-amber-300 px-1 py-0.5 rounded font-black">2 Tokens / Pixel block</span>
                        </div>
                        <p className="text-[11px] leading-snug text-black/80 font-medium">
                          Erect concrete wall segments. Specify your budget and then simple click any free point on the live arena grid to erect protective fortresses.
                        </p>
                      </div>
                    )}
                    {selectedExplainerButton === 'mine' && (
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-black text-xs uppercase text-red-600">💣 SEED STEALTH MINES</span>
                          <span className="text-[8px] bg-red-100 text-red-800 border border-red-350 px-1 py-0.5 rounded font-black">20 Tokens</span>
                        </div>
                        <p className="text-[11px] leading-snug text-black/80 font-medium">
                          Sows 20 invisible danger landmines directly deep into opponent territory. Any stroller running into one explodes, setting them all the way back to startup spawn!
                        </p>
                      </div>
                    )}
                    {selectedExplainerButton === 'sling' && (
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-black text-xs uppercase text-rose-600">🏹 LAUNCH SLINGSHOT</span>
                          <span className="text-[8px] bg-rose-100 text-rose-800 border border-rose-300 px-1 py-0.5 rounded font-black">100 Tokens</span>
                        </div>
                        <p className="text-[11px] leading-snug text-black/80 font-medium">
                          Drag and release physical slingshot bands on the active canvas. Flings a paint bomb at great distances, claiming wide zones instantly!
                        </p>
                      </div>
                    )}
                    {selectedExplainerButton === 'landmark' && (
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-black text-xs uppercase text-emerald-800">🏰 ERECT LANDMARK</span>
                          <span className="text-[8px] bg-emerald-100 text-emerald-800 border border-emerald-300 px-1 py-0.5 rounded font-black">50 Tokens</span>
                        </div>
                        <p className="text-[11px] leading-snug text-black/80 font-medium">
                          Create a magnificent 4x4 permanent structure anywhere on the grid! Choose a unique name, customized color, and personalized message that any team player can click and inspect.
                        </p>
                      </div>
                    )}
                    {selectedExplainerButton === 'lucky' && (
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-black text-xs uppercase text-yellow-700">🎰 ROTATE JACKPOT</span>
                          <span className="text-[8px] bg-yellow-100 text-yellow-800 border border-yellow-350 px-1 py-0.5 rounded font-black">10 Tokens</span>
                        </div>
                        <p className="text-[11px] leading-snug text-black/80 font-medium">
                          Spin the magical mechanical jackpot wheel! Chance to hit a jackpot, automatically gifting your baby from 1 to 50 free forward rollouts!
                        </p>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}

              {onboardingStep === 3 && (
                <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
                  <h3 className="text-base sm:text-lg font-black uppercase tracking-tight text-emerald-700 mb-2 flex items-center gap-1.5">
                    💝 Powering Charity Global Aid
                  </h3>
                  <p className="text-xs sm:text-sm text-black/80 font-medium leading-relaxed mb-3">
                    This battle serves a higher purpose. Every single game token represents a <strong>$1 direct contribution</strong> to real-world global humanitarian aid.
                  </p>
                  <p className="text-xs text-black/70 leading-relaxed mb-3">
                    Refill tokens with <strong>Starter, Tactician, or Tycoon</strong> packs inside the store. Real-world payments go directly to aid channels, logging your name onto our live <strong>Hall of Fame Leaderboard</strong>.
                  </p>
                  <div className="bg-[#ecfdf5] border-2 border-[#10b981] p-3 rounded-xl text-center font-bold">
                    <span className="text-[10px] font-black text-emerald-800 uppercase tracking-wider leading-none">
                      🏆 100% OF REAL STORE COINS DIRECTLY AID HUMANITARIAN EFFORTS
                    </span>
                  </div>
                </motion.div>
              )}

              {/* Bottom Action bar */}
              <div className="flex justify-between items-center border-t-2 border-black/10 pt-4 mt-6">
                <button
                  type="button"
                  onClick={() => setOnboardingStep((prev) => Math.max(0, prev - 1))}
                  disabled={onboardingStep === 0}
                  className={`px-3 py-1.5 rounded-xl border-2 border-black text-xs font-black uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 cursor-pointer select-none ${
                    onboardingStep === 0 
                      ? "opacity-45 cursor-not-allowed bg-gray-100" 
                      : "bg-white hover:bg-gray-50 text-black"
                  }`}
                >
                  &larr; Prev
                </button>

                {/* Dot Index */}
                <div className="flex gap-1.5">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      onClick={() => setOnboardingStep(i)}
                      className={`w-2.5 h-2.5 rounded-full border border-black cursor-pointer transition-all ${
                        onboardingStep === i ? "bg-black scale-110" : "bg-white"
                      }`}
                    />
                  ))}
                </div>

                {onboardingStep < 3 ? (
                  <button
                    type="button"
                    onClick={() => setOnboardingStep((prev) => Math.min(3, prev + 1))}
                    className="px-4 py-1.5 bg-yellow-300 hover:bg-yellow-400 text-black border-2 border-black text-xs font-black uppercase rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 active:translate-x-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] cursor-pointer select-none"
                  >
                    Next &rarr;
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleCloseOnboarding}
                    className="px-4 py-1.5 bg-emerald-400 hover:bg-emerald-500 text-white font-black border-2 border-black text-xs font-black uppercase rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 active:translate-x-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] cursor-pointer select-none"
                  >
                    🚀 Enter Battle!
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Stripe Payment Success Alert */}
      {paymentSuccessMessage && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 text-black">
          <motion.div 
            initial={{ rotate: 3, scale: 0.9 }}
            animate={{ rotate: 0, scale: 1 }}
            className="bg-green-300 border-4 border-black p-8 rounded-3xl max-w-md w-full text-center shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden"
          >
            <div className="text-6xl mb-4 animate-bounce">🎉</div>
            <h2 className="text-3xl font-black uppercase tracking-tight text-black">THANK YOU!</h2>
            <p className="font-mono text-[11px] font-black uppercase tracking-wider mt-3 mb-6 block leading-relaxed text-emerald-950">
              {paymentSuccessMessage}
            </p>
            <button 
              onClick={() => setPaymentSuccessMessage(null)}
              className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black border-3 border-black rounded-xl hover:-translate-y-0.5 active:translate-y-0.5 transition-all uppercase text-xs tracking-wider shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] cursor-pointer"
            >
              LET'S BATTLE &rarr;
            </button>
          </motion.div>
        </div>
      )}

      {/* Batch Move Modal */}
      {activeModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <motion.div 
            initial={{ scale: 0.95 }}
            animate={{ scale: 1 }}
            className={`bg-white border-4 border-black p-6 rounded-3xl shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative font-sans text-black ${activeModal.type === 'slingshot' ? 'w-88' : 'w-80'}`}
          >
            {/* Decorative corner tag */}
            <div className={`absolute top-0 right-0 px-3 py-1 text-[9px] font-black uppercase text-white border-b-3 border-l-3 border-black rounded-tr-[12px] ${activeModal.side === 'blue' ? 'bg-[#3b82f6]' : 'bg-[#ef4444]'}`}>
              {activeModal.side} team
            </div>

            <h3 className="text-black font-black mb-4 uppercase tracking-tight text-lg mt-2 flex items-center gap-2">
              {activeModal.type === 'move' ? `💥 Move ${activeModal.side}` : 
               activeModal.type === 'grid' ? `♟️ Push Grid` :
               activeModal.type === 'teleport' ? `🔮 Teleport` :
               activeModal.type === 'mine' ? `💣 Minefield` :
               activeModal.type === 'jackpot' ? `🎰 Jackpot Spin` :
               activeModal.type === 'slingshot' ? `🏹 Baby Slingshot` :
               `🚧 Erect Wall`}
            </h3>
            
            {activeModal.type === 'slingshot' ? (
              <SlingshotGame
                side={activeModal.side}
                userTokens={profile?.currentTokens || 0}
                isDevMode={isDevMode}
                onLaunch={async (pullX, pullY, maxPull) => {
                  const success = await executeSlingshotLaunch(activeModal.side, pullX, pullY, maxPull);
                  if (success) {
                    setActiveModal(null);
                  }
                  return success;
                }}
                onCancel={() => setActiveModal(null)}
              />
            ) : activeModal.type === 'landmark' ? (
              <form onSubmit={(e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                const name = formData.get('landmark-name') as string;
                const message = formData.get('landmark-message') as string;
                const color = formData.get('landmark-color') as string;
                setActiveModal(null);
                setIsLandmarkPlacing({
                  name,
                  message,
                  color,
                  side: activeModal.side
                });
                addLog(`⚙️ Configured landmark logic. Click anywhere on grid to place!`);
              }}>
                <div className="space-y-4 text-left">
                  <p className="text-black/85 text-[10px] font-bold leading-relaxed">
                    Erect a permanent 4x4 landmark structure on the arena grid. Custom landmarks cost <span className="font-extrabold text-emerald-600">50 tokens</span> and display your custom message instantly when clicked!
                  </p>
                  <div>
                    <label className="text-black/70 font-black text-[10px] uppercase block mb-1">Landmark Name</label>
                    <input 
                      name="landmark-name" 
                      type="text" 
                      maxLength={30}
                      placeholder="e.g., Mount Olympus"
                      className="w-full bg-yellow-50 border-3 border-black rounded-xl px-3 py-2 text-black font-black outline-none focus:bg-yellow-105 text-xs"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-black/70 font-black text-[10px] uppercase block mb-1">Custom Message</label>
                    <textarea 
                      name="landmark-message"
                      maxLength={120}
                      rows={3}
                      placeholder="e.g., Welcome to the peak!"
                      className="w-full bg-yellow-50 border-3 border-black rounded-xl px-3 py-2 text-black font-black outline-none focus:bg-yellow-105 text-xs resize-none"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-black/70 font-black text-[10px] uppercase block mb-1">Landmark Color</label>
                    <div className="flex items-center gap-2">
                      <input 
                        name="landmark-color" 
                        type="color" 
                        defaultValue={activeModal.side === 'blue' ? '#3b82f6' : '#ef4444'}
                        className="w-10 h-10 border-3 border-black rounded-xl p-0.5 cursor-pointer bg-white"
                        required
                      />
                      <span className="text-black/50 text-[10px] font-bold uppercase select-none">Choose any color</span>
                    </div>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button 
                      type="button"
                      onClick={() => setActiveModal(null)}
                      className="flex-1 px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-black border-2 border-black text-xs font-black uppercase transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button 
                      type="submit"
                      className={`flex-1 px-4 py-2 rounded-xl text-white text-xs font-black uppercase border-2 border-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all cursor-pointer ${activeModal.side === 'blue' ? 'bg-[#3b82f6]' : 'bg-[#ef4444]'}`}
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              </form>
            ) : activeModal.type === 'move' || activeModal.type === 'grid' ? (
              <form onSubmit={(e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                const steps = parseInt(formData.get('steps') as string);
                const dir = formData.get('direction') as string;
                setActiveModal(null); // Instantly dismiss modal upon hitting confirm!
                handleBatchMove(steps, dir);
              }}>
                <div className="space-y-4">
                  <div>
                    <label className="text-black/70 font-black text-[10px] uppercase block mb-1">
                      Steps ({activeModal.type === 'move' ? '1' : '2'} tokens per step)
                    </label>
                    <input 
                      name="steps" 
                      type="number" 
                      min="1" 
                      defaultValue="10"
                      className="w-full bg-yellow-50 border-3 border-black rounded-xl px-3 py-2 text-black font-black outline-none focus:bg-yellow-105"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-black/70 font-black text-[10px] uppercase block mb-1">Direction</label>
                    <div className="relative">
                      <select 
                        name="direction"
                        className="w-full bg-white border-3 border-black rounded-xl px-3 py-2 text-black font-black outline-none appearance-none"
                      >
                        <option value="up">▲ Up</option>
                        <option value="down">▼ Down</option>
                        <option value="left">◀ Left</option>
                        <option value="right">▶ Right</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button 
                      type="button"
                      onClick={() => setActiveModal(null)}
                      className="flex-1 px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-black border-2 border-black text-xs font-black uppercase transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button 
                      type="submit"
                      className={`flex-1 px-4 py-2 rounded-xl text-white text-xs font-black uppercase border-2 border-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all cursor-pointer ${activeModal.side === 'blue' ? 'bg-[#3b82f6]' : 'bg-[#ef4444]'}`}
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              </form>
            ) : (
                <div className="space-y-4">
                   <p className="text-black/80 text-xs font-bold leading-relaxed">
                     {activeModal.type === 'teleport' ? "🔮 Teleport to a random safe zone within 5 range blocks? (Cost: 5 tokens)" :
                      activeModal.type === 'mine' ? "💣 Disperse a barrage of 20 invisible stealth mines across the grid? (Cost: 20 tokens)" :
                      activeModal.type === 'jackpot' ? "🎰 Spin the physical wheel for a random payload of 1 to 50 moves! (Cost: 10 tokens)" :
                      "How many tokens do you want to assign to this fortification? (Wall costs 2 tokens per pixel)"}
                   </p>
                   {activeModal.type === 'wall' && (
                     <div>
                       <label className="text-black/70 font-black text-[10px] uppercase block mb-1">Tokens (Multiples of 2)</label>
                       <input 
                         id="wall-budget"
                         type="number" 
                         min="2" 
                         step="2"
                         defaultValue="20"
                         className="w-full bg-yellow-50 border-3 border-black rounded-xl px-3 py-2 text-black font-black outline-none focus:bg-yellow-105"
                         required
                       />
                     </div>
                   )}
                   <div className="flex gap-3 pt-2">
                    <button 
                      type="button"
                      onClick={() => setActiveModal(null)}
                      className="flex-1 px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-black border-2 border-black text-xs font-black uppercase transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button 
                      type="button"
                      onClick={() => {
                        if (activeModal.type === 'teleport') handleTeleport(activeModal.side);
                        else if (activeModal.type === 'mine') handleMinefield(activeModal.side);
                        else if (activeModal.type === 'jackpot') handleJackpot(activeModal.side);
                        else if (activeModal.type === 'wall') { 
                          const budget = parseInt((document.getElementById('wall-budget') as HTMLInputElement)?.value || "0");
                          if (budget >= 2) {
                            setIsWallBuilding({ side: activeModal.side, budget }); 
                            setActiveModal(null); 
                          }
                        }
                      }}
                      className={`flex-1 px-4 py-2 rounded-xl text-white text-xs font-black uppercase border-2 border-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all cursor-pointer ${activeModal.side === 'blue' ? 'bg-[#3b82f6]' : 'bg-[#ef4444]'}`}
                    >
                      Confirm
                    </button>
                  </div>
                </div>
            )}
          </motion.div>
        </div>
      )}

      {/* Real Spinning Jackpot Wheel */}
      {jackpotSpinning !== null && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#fffef4] border-4 border-black p-6 rounded-3xl max-w-sm w-full shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] text-center relative overflow-hidden"
          >
            {/* Top decorative banner */}
            {(() => {
              const customBaby = sponsoredBabies.find(b => b.id === jackpotSpinning.side);
              if (customBaby) {
                return (
                  <div 
                    className="text-[10px] font-black uppercase inline-block px-3 py-1 border-2 border-black rounded-full mb-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] text-white"
                    style={{ backgroundColor: customBaby.color }}
                  >
                    🎰 {customBaby.name} Jackpot
                  </div>
                );
              }
              return (
                <div className={`text-[10px] font-black uppercase inline-block px-3 py-1 border-2 border-black rounded-full mb-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] text-black ${
                  jackpotSpinning.side === 'blue' ? 'bg-blue-200' : 'bg-red-200'
                }`}>
                  🎰 {jackpotSpinning.side === 'blue' ? 'Blue Team' : 'Red Team'} jackpot
                </div>
              );
            })()}

            <h3 className="font-sans font-black text-2xl text-black uppercase tracking-tight mb-6">
              {jackpotSpinning.isFinished ? "🎉 SPIN COMPLETE! 🎉" : "🌀 SPINNING WHEEL... 🌀"}
            </h3>

            {/* Wheel Container with Pointer */}
            <div className="relative w-64 h-64 mx-auto mb-6 flex items-center justify-center">
              {/* Little neo-brutalist pointer at 12 o'clock */}
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[10px] border-r-[10px] border-t-[16px] border-l-transparent border-r-transparent border-t-rose-600 z-20" />
              <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[12px] border-r-[12px] border-t-[18px] border-l-transparent border-r-transparent border-t-black z-10" />

              {/* Spinning Wheel */}
              <motion.div
                initial={{ rotate: 0 }}
                animate={{ rotate: jackpotSpinning.rotation }}
                transition={{ 
                  type: "spring",
                  damping: 18, 
                  stiffness: 50,
                  mass: 1.2
                }}
                className="w-full h-full rounded-full border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] relative select-none origin-center"
                onAnimationComplete={() => {
                  setJackpotSpinning(prev => prev ? { ...prev, isFinished: true } : null);
                }}
              >
                {/* SVG representing the segmented slices */}
                <svg viewBox="0 0 200 200" className="w-full h-full rounded-full overflow-hidden select-none pointer-events-none">
                  {JACKPOT_SLICES.map((slice, i) => (
                    <g key={i} transform={`rotate(${i * 30}, 100, 100)`}>
                      {/* Wedge segment */}
                      <path 
                        d="M 100 100 L 200 100 A 100 100 0 0 1 186.6 150 Z" 
                        fill={slice.color} 
                        stroke="black" 
                        strokeWidth="3.5" 
                      />
                      {/* Text segment centered radial offset */}
                      <g transform="rotate(15, 100, 100)">
                        <text 
                          x="152" 
                          y="105" 
                          fontWeight="900" 
                          textAnchor="middle" 
                          fontSize="13px" 
                          fill="white"
                          fontFamily="sans-serif"
                          stroke="black"
                          strokeWidth="2.5"
                          paintOrder="stroke"
                          transform="rotate(90, 152, 105)"
                        >
                          {slice.value}
                        </text>
                      </g>
                    </g>
                  ))}
                  {/* Outer circle line helper */}
                  <circle cx="100" cy="100" r="99" fill="none" stroke="black" strokeWidth="3" />
                  {/* Center cap cover hub */}
                  <circle cx="100" cy="100" r="18" fill="white" stroke="black" strokeWidth="4" />
                  <circle cx="100" cy="100" r="8" fill="black" />
                </svg>
              </motion.div>
            </div>

            {/* Post-Spin Celebration & Actions */}
            <div className="h-20 flex flex-col items-center justify-center">
              {jackpotSpinning.isFinished ? (
                <motion.div 
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="flex flex-col items-center gap-2"
                >
                  <p className="text-sm font-bold text-black/70">
                    WON <span className="text-xl font-black text-rose-600 border px-2 py-0.5 rounded-md bg-yellow-200 border-black">{jackpotSpinning.resultValue}</span> STEPS!
                  </p>
                  
                  <button
                    onClick={() => {
                      const { side, resultValue } = jackpotSpinning;
                      const customBaby = sponsoredBabies.find(b => b.id === side);
                      const rot = customBaby ? (customBaby.rot || -90) : (side === 'blue' ? blueRot : redRot);
                      let dir = 'right';
                      if (rot === -90) dir = 'up';
                      if (rot === 90) dir = 'down';
                      if (rot === 180) dir = 'left';
                      if (rot === 0) dir = 'right';
                      
                      executeBatchMove(side, side, 'move', resultValue, dir);
                      const babyName = customBaby ? `👶 ${customBaby.name}` : (side === 'blue' ? 'Blue' : 'Red');
                      addLog(`${babyName} executed their jackpot of ${resultValue} steps!`);
                      setJackpotSpinning(null);
                    }}
                    className="px-6 py-2 rounded-xl bg-yellow-300 hover:bg-yellow-400 border-2 border-black font-black text-xs uppercase tracking-wider text-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all cursor-pointer"
                  >
                    🚀 Let's Move!
                  </button>
                </motion.div>
              ) : (
                <div className="text-black/50 font-bold text-xs flex items-center gap-2 animate-pulse">
                  <span>⚙️</span> Physics engine deciding your fate...
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}

      {/* Wall Building Hint */}
      {isWallBuilding && (
        <div className={`fixed top-32 left-1/2 -translate-x-1/2 z-[80] text-black px-4 py-2 rounded-full font-bold text-sm shadow-xl animate-bounce bg-yellow-300 border-2 border-black`}>
          CLICK GRID TO PLACE WALL PIXELS ({isWallBuilding.budget / 2} LEFT)
          <button onClick={() => setIsWallBuilding(null)} className="ml-4 text-black/60 underline text-xs font-black">FINISH &times;</button>
        </div>
      )}

      {/* Landmark Building Hint */}
      {isLandmarkPlacing && (
        <div className="fixed top-32 left-1/2 -translate-x-1/2 z-[80] text-black px-5 py-2.5 rounded-full font-black text-xs shadow-xl animate-bounce bg-emerald-300 border-2 border-black flex items-center gap-2 select-none">
          <span>🏰</span>
          <span>CLICK MAP GRID TO POSITION "{isLandmarkPlacing.name.toUpperCase()}" (4x4 GRID)</span>
          <button onClick={() => setIsLandmarkPlacing(null)} className="ml-3 text-black/60 hover:text-black underline text-[9.5px] font-black uppercase cursor-pointer">Cancel &times;</button>
        </div>
      )}

      {/* Selected Landmark Info Modal */}
      {selectedLandmark && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
          <motion.div 
            initial={{ scale: 0.95 }}
            animate={{ scale: 1 }}
            className="bg-white border-4 border-black p-6 rounded-3xl shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative font-sans text-black w-80 text-left"
          >
            {/* Header side tag */}
            <div className="absolute top-0 right-0 px-3 py-1 text-[9px] font-black uppercase text-white border-b-3 border-l-3 border-black rounded-tr-[12px]" style={{ backgroundColor: selectedLandmark.color || '#10b981' }}>
              {selectedLandmark.creatorSide} team
            </div>
            
            <div className="flex items-center gap-2 mb-3 mt-2 pr-12">
              <span className="text-2xl select-none">🏰</span>
              <div>
                <h3 className="font-black text-base uppercase leading-tight tracking-tight break-words">{selectedLandmark.name}</h3>
                <p className="text-[9px] text-black/50 font-black uppercase">Built by {selectedLandmark.creatorName}</p>
              </div>
            </div>

            <div className="border-3 border-black rounded-2xl p-4 mb-4 font-bold text-xs bg-gray-50 leading-relaxed break-words" style={{ borderLeftColor: selectedLandmark.color || '#10b981', borderLeftWidth: '8px' }}>
              "{selectedLandmark.message}"
            </div>

            <div className="flex items-center justify-between text-[8px] text-black/40 font-black uppercase mb-4">
              <span>📍 GPS: {selectedLandmark.x}, {selectedLandmark.y} (4x4)</span>
              <span>🕒 {new Date(selectedLandmark.createdAt).toLocaleDateString()}</span>
            </div>

            <button 
              type="button"
              onClick={() => setSelectedLandmark(null)}
              className="w-full py-2 bg-yellow-300 hover:bg-yellow-400 text-black border-2 border-black rounded-xl text-xs font-black uppercase shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all cursor-pointer text-center"
            >
              Close
            </button>
          </motion.div>
        </div>
      )}

      {/* FIXED BOTTOM HUD (DESKTOP) */}
      <div className="hidden md:flex fixed bottom-0 left-0 w-full h-24 bg-[#fcfaf4] border-t-4 border-black items-center justify-between px-6 z-50 shadow-[0_-5px_0px_0px_rgba(0,0,0,1)] text-black">
        
        {/* Left Section: Token Wallet & Faction Command Hub */}
        <div className="flex items-center gap-3">
          {/* Neobrutalist Token Wallet Card */}
          <div className="flex items-center gap-2.5 bg-emerald-50 border-2 border-black px-3.5 py-1.5 rounded-xl shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] select-none">
            <div className="flex flex-col text-left">
              <span className="text-[7.5px] font-black uppercase text-[#047857] tracking-wider">Your Tokens</span>
              <span className="text-xs sm:text-sm font-black text-black font-mono leading-none mt-0.5 whitespace-nowrap">
                🪙 {profile?.currentTokens ?? 0}
              </span>
            </div>
            <button 
              onClick={() => setIsPurchaseModalOpen(true)}
              className="px-2 py-1 bg-yellow-300 hover:bg-yellow-400 text-black border-2 border-black text-[8px] font-black uppercase rounded-lg shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] active:translate-y-[1px] active:shadow-none transition-all cursor-pointer font-sans"
              title="Buy more tokens to support the server & charity!"
            >
              + ADD
            </button>
          </div>

          {userRole !== 'none' && (
            <div className="flex items-center gap-2 bg-[#fdfaf2] border-2 border-black px-4 py-2 rounded-xl shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] select-none font-mono">
              <span className="text-[10px] sm:text-xs font-black uppercase text-black select-none">🍼 HUB:</span>
              
              {/* Blue Baby control */}
              <button
                type="button"
                onClick={() => {
                  setSelectedBabyId('blue');
                  addLog("Switching control to Blue Baby");
                }}
                className={`px-2.5 py-1 rounded-lg border border-black cursor-pointer uppercase font-black text-[8.5px] sm:text-[10px] tracking-tight transition-all ${
                  selectedBabyId === 'blue' 
                    ? 'bg-blue-600 text-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]' 
                    : 'bg-white text-blue-600 hover:bg-blue-50'
                }`}
              >
                💙 Blue Baby
              </button>
              
              {/* Red Baby control */}
              <button
                type="button"
                onClick={() => {
                  setSelectedBabyId('red');
                  addLog("Switching control to Red Baby");
                }}
                className={`px-2.5 py-1 rounded-lg border border-black cursor-pointer uppercase font-black text-[8.5px] sm:text-[10px] tracking-tight transition-all ${
                  selectedBabyId === 'red' 
                    ? 'bg-red-600 text-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]' 
                    : 'bg-white text-red-600 hover:bg-red-50'
                }`}
              >
                ❤️ Red Baby
              </button>

              {/* Sponsored Babies List trigger */}
              <button
                type="button"
                onClick={() => setIsSponsorListModalOpen(true)}
                className="px-2.5 py-1 bg-orange-100 text-black rounded-lg border border-black cursor-pointer uppercase font-black text-[8.5px] sm:text-[10px] tracking-wider hover:opacity-90 active:translate-y-0.5 shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] active:shadow-none"
              >
                👶 Sponsored Babies
              </button>
              
              <button 
                onClick={() => setActiveModal({ side: 'blue', type: 'landmark' })}
                className="px-2.5 py-1 bg-blue-105 border border-black rounded-lg text-black font-black text-[8.5px] sm:text-[10px] tracking-wider hover:opacity-90 active:translate-y-0.5 shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] active:shadow-none cursor-pointer"
              >
                🏰 MARK B
              </button>
              <button 
                onClick={() => setActiveModal({ side: 'red', type: 'landmark' })}
                className="px-2.5 py-1 bg-red-105 border border-black rounded-lg text-black font-black text-[8.5px] sm:text-[10px] tracking-wider hover:opacity-90 active:translate-y-0.5 shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] active:shadow-none cursor-pointer"
              >
                🏰 MARK R
              </button>
            </div>
          )}
        </div>

        {/* Middle Column: Unified 8 Abilities Deck targeting the currently selected unit */}
        <div className={`flex items-center gap-1.5 transition-all ${!canControl(selectedBabyId) ? 'opacity-30 pointer-events-none grayscale' : ''}`}>
          <button
            type="button"
            onClick={() => setIsAbilitiesExpanded(true)}
            className="h-11 px-6 flex items-center gap-2 bg-[#ffde43] hover:bg-[#ffe04d] border-2 border-black rounded-xl text-black font-black text-[11px] uppercase tracking-wider hover:-translate-y-0.5 active:translate-y-0.5 shadow-[2.5px_2.5px_0px_0px_rgba(0,0,0,1)] cursor-pointer select-none transition-all"
            title="Deploy strategic powers"
            id="tactical-abilities-menu-btn"
          >
            <span>⚔️</span>
            <span>Tactical Abilities</span>
            <span className="text-[9px] bg-black text-[#ffde43] font-mono px-1.5 py-0.5 rounded font-black uppercase tracking-tighter shadow-sm ml-1.5">
              Menu &bull; {selectedBabySide.toUpperCase()}
            </span>
          </button>
        </div>

        {/* Right Column: Global actions and controls deck */}
        <div className="flex items-center gap-2 select-none">
          {/* Snap-Lock tracking tracker */}
          <button 
            onClick={() => setLiveTracking(!liveTracking)}
            className={`h-12 px-3 flex flex-col items-center justify-center border-2 border-black rounded-xl hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] text-black cursor-pointer uppercase transition-all ${liveTracking ? 'bg-emerald-300 font-extrabold shadow-[3px_3px_0px_0px_#047857]' : 'bg-gray-100 hover:bg-gray-200 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]'}`}
            title="Auto lock camera tracking onto our selected Baby Stroller."
          >
            <div className="text-[8px] font-black tracking-wider">📡 LIVE TRACK</div>
            <div className="text-[7.5px] font-black mt-0.5">{liveTracking ? '🔒 LOCKED' : '🔓 OFF'}</div>
          </button>

          {/* Glowing hot red great reset button */}
          <button 
            onClick={() => setIsGreatResetModalOpen(true)}
            className="w-12 h-12 flex items-center justify-center bg-red-600 hover:bg-red-700 border-2 border-black rounded-xl hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] text-white cursor-pointer relative animate-[pulse_1.5s_infinite]"
            style={{ boxShadow: '0 0 15px #ef4444' }}
            title="The Great Reset: sabotage a chosen racer or reset all lines (1,000 Tokens)"
          >
            <RotateCcw size={18} className="font-bold stroke-[3] text-white" />
          </button>
          
          {/* Zoom controls hub */}
          <div className="flex items-center border-2 border-black bg-white rounded-xl shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] overflow-hidden">
            <button 
              onClick={() => handleZoom('in')}
              className="w-8 h-8 flex items-center justify-center bg-gray-50 hover:bg-gray-150 text-black border-r-2 border-black cursor-pointer font-black"
            >
              <Plus size={14} className="stroke-[3]" />
            </button>
            <button 
              onClick={() => handleZoom('out')}
              className="w-8 h-8 flex items-center justify-center bg-gray-50 hover:bg-gray-150 text-black cursor-pointer font-black"
            >
              <Minus size={14} className="stroke-[3]" />
            </button>
          </div>
        </div>

        {/* Logs container anchor floating tab */}
        <div className="fixed right-4 md:right-6 bottom-28 z-[60] flex flex-col items-end gap-2.5">
           <button 
             onClick={() => setIsLogOpen(!isLogOpen)}
             className="bg-[#fcfaf4] border-2 border-black px-4 py-1.5 rounded-full text-black hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-transform cursor-pointer"
           >
             <div className="text-[10px] uppercase font-black tracking-wider flex items-center gap-1.5">
               <span>📜</span> {isLogOpen ? 'Hide Logs' : 'Show Logs'}
             </div>
           </button>
           
           {isLogOpen && (
             <motion.div 
               initial={{ opacity: 0, y: 10, scale: 0.95 }}
               animate={{ opacity: 1, y: 0, scale: 1 }}
               className="w-72 max-w-[calc(100vw-32px)] h-64 bg-[#fffef4] border-3 border-black rounded-2xl p-4 overflow-y-auto font-mono text-[9px] shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-black text-left"
             >
               <div className="text-black/50 uppercase tracking-widest font-black mb-2.5 border-b-2 border-black pb-1.5 flex justify-between">
                 <span>🌐 Activity Log</span>
               </div>
               {logs.length === 0 && <div className="text-black/30 italic mt-6 text-center">Empty ledger state</div>}
               {logs.map((log, i) => (
                 <div key={i} className="text-black/80 mb-1 pl-1 line-clamp-2">
                   <span className="text-black/40 font-black">[{log.time}]</span> {log.msg}
                 </div>
               ))}
             </motion.div>
           )}
        </div>

      </div>

      {/* MOBILE-ONLY BOTTOM HUD (Glow/Neobrutalist buttons drawer) */}
      <div className="flex md:hidden fixed bottom-0 left-0 w-full bg-[#fcfaf4] border-t-4 border-black z-50 p-3 shadow-[0_-4px_0px_0px_rgba(0,0,0,1)] text-black flex-col select-none font-sans">
        {/* Row 1: Active Stroller details, Telemetry info, and budget indicators */}
        <div className="flex items-center justify-between mb-2 pb-2 border-b border-black/10">
          <div className="flex gap-1.5 items-center">
            {/* Minimal Unit selector dropdown */}
            <select
              value={selectedBabyId}
              onChange={(e) => {
                setSelectedBabyId(e.target.value);
                addLog(`Selector switched target unit to: ${e.target.value}`);
              }}
              className="text-[9px] font-black uppercase border border-black rounded bg-white px-1 py-0.5 cursor-pointer max-w-[120px] outline-none"
            >
              <option value="blue">💙 Blue Team</option>
              <option value="red">❤️ Red Team</option>
              {sponsoredBabies && sponsoredBabies.map(b => (
                <option key={b.id} value={b.id}>👶 {b.name.toUpperCase()}</option>
              ))}
            </select>

            <span className="text-[7.5px] font-mono opacity-50 font-bold">({selectedPos.x}, {selectedPos.y})</span>

            {/* Sprint timer active badge */}
            {selectedSprintActive && (
              <span className="text-[7px] bg-cyan-100 text-[#0891b2] border border-cyan-300 px-1 py-0.2 rounded font-black animate-pulse font-mono">
                ⚡ RUN
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Great Reset trigger */}
            <button 
              type="button"
              onClick={() => setIsGreatResetModalOpen(true)}
              className="w-6 h-6 flex items-center justify-center bg-red-600 border border-black rounded shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] font-black text-white cursor-pointer select-none animate-[pulse_1.5s_infinite]"
              style={{ boxShadow: '0 0 8px #ef4444' }}
              title="Sabotage Reset"
            >
              <RotateCcw size={10} className="text-white fill-white stroke-[3.5]" />
            </button>
          </div>
          <div className="flex items-center gap-1.5 mt-1 border-t border-black/10 pt-1">
            <button 
              onClick={() => setActiveModal({ side: 'blue', type: 'landmark' })}
              className="px-2 py-0.5 bg-blue-105 border border-black rounded text-black font-black text-[8px] uppercase tracking-tight cursor-pointer"
            >
              🏰 MARK B
            </button>
            <button 
              onClick={() => setActiveModal({ side: 'red', type: 'landmark' })}
              className="px-2 py-0.5 bg-red-105 border border-black rounded text-black font-black text-[8px] uppercase tracking-tight cursor-pointer"
            >
              🏰 MARK R
            </button>
          </div>
        </div>

        {/* Dynamic Mines clear options row if selected stroller has minefields nearby */}
        {selectedSideHasMines && (
          <div className="flex items-center justify-between gap-1.5 pb-2 mb-2 border-b border-black/10">
            <span className="text-[8px] font-black uppercase text-amber-900 flex items-center gap-0.5">⚠️ SIDE MINES DETECTED:</span>
            {!selectedSideMinesRevealed ? (
              <button 
                type="button"
                onClick={() => handleRevealMines(selectedBabySide)}
                className="px-2 py-0.5 bg-amber-200 hover:bg-amber-300 border border-black rounded text-black font-black text-[8px] uppercase tracking-tight cursor-pointer"
              >
                👁️ REVEAL (100)
              </button>
            ) : (
              <button 
                type="button"
                onClick={() => handleClearMines(selectedBabySide)}
                className="px-2 py-0.5 bg-rose-200 hover:bg-rose-300 border border-black rounded text-black font-black text-[8px] uppercase tracking-tight cursor-pointer"
              >
                🧹 CLEAR (150)
              </button>
            )}
          </div>
        )}

        {/* Specialized Mobile actions grid (2 rows of 4 buttons) and Zoom */}
        <div className="flex flex-col gap-2">
          <div className={`grid grid-cols-4 gap-1.5 transition-all ${!canControl(selectedBabyId) ? 'opacity-30 pointer-events-none grayscale' : ''}`}>
            <button 
              type="button"
              onClick={() => setActiveModal({ side: selectedBabySide, type: 'move' })}
              className="py-1.5 px-0.5 flex flex-col items-center justify-center bg-[#3b82f6] border border-black rounded-lg text-white font-black uppercase shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] text-[9px] cursor-pointer"
            >
              <span className="text-xs">💥</span>
              <span>MOVE</span>
            </button>
            
            <button 
              type="button"
              onClick={() => setActiveModal({ side: selectedBabySide, type: 'grid' })}
              className="py-1.5 px-0.5 flex flex-col items-center justify-center bg-blue-50 border border-black rounded-lg text-black font-black uppercase shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] text-[9px] cursor-pointer"
            >
              <span className="text-xs">♟️</span>
              <span>PUSH</span>
            </button>

            <button 
              type="button"
              onClick={() => handleTeleport(selectedBabyId)}
              className="py-1.5 px-0.5 flex flex-col items-center justify-center bg-purple-100 border border-black rounded-lg text-black font-black uppercase shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] text-[9px] cursor-pointer"
            >
              <span className="text-xs">🔮</span>
              <span>TELE</span>
            </button>

            <button 
              type="button"
              onClick={() => setActiveModal({ side: selectedBabySide, type: 'wall' })}
              className="py-1.5 px-0.5 flex flex-col items-center justify-center bg-slate-100 border border-black rounded-lg text-black font-black uppercase shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] text-[9px] cursor-pointer"
            >
              <span className="text-xs">🚧</span>
              <span>WALL</span>
            </button>

            <button 
              type="button"
              onClick={() => setActiveModal({ side: selectedBabySide, type: 'mine' })}
              className="py-1.5 px-0.5 flex flex-col items-center justify-center bg-orange-100 border border-black rounded-lg text-black font-black uppercase shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] text-[9px] cursor-pointer"
            >
              <span className="text-xs">💣</span>
              <span>MINE</span>
            </button>

            <button 
              type="button"
              onClick={() => handleJackpot(selectedBabyId)}
              className="py-1.5 px-0.5 flex flex-col items-center justify-center bg-yellow-150 border border-black rounded-lg text-black font-black uppercase shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] text-[9px] cursor-pointer"
            >
              <span className="text-xs">🎰</span>
              <span>LUCK</span>
            </button>

            <button 
              type="button"
              onClick={() => handleSprint(selectedBabyId)}
              className="py-1.5 px-0.5 flex flex-col items-center justify-center bg-cyan-150 border border-black rounded-lg text-black font-black uppercase shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] text-[9px] cursor-pointer"
            >
              <span className="text-xs">🏃</span>
              <span>RUN</span>
            </button>

            <button 
              type="button"
              onClick={() => setActiveModal({ side: selectedBabySide, type: 'slingshot' })}
              className="py-1.5 px-0.5 flex flex-col items-center justify-center bg-rose-150 border border-black rounded-lg text-black font-black uppercase shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] text-[9px] cursor-pointer animate-pulse"
            >
              <span className="text-xs">🏹</span>
              <span>SLING</span>
            </button>
          </div>

          {/* Quick Zoom adjustment row */}
          <div className="flex items-center justify-center gap-4 bg-black/5 py-1 rounded-lg">
            <span className="text-[8.5px] font-black uppercase tracking-tight opacity-65 font-sans">ADJUST MAGNIFICATION:</span>
            <div className="flex items-center border border-black rounded bg-white overflow-hidden h-5.5">
              <button type="button" onClick={() => handleZoom('in')} className="px-3 bg-gray-50 border-r border-black font-black text-xs select-none">+</button>
              <button type="button" onClick={() => handleZoom('out')} className="px-3 bg-gray-50 font-black text-xs select-none">-</button>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile-only Compact Header Bar */}
      <div className="block md:hidden fixed top-0 left-0 w-full bg-[#fcfaf4] border-b-4 border-black z-50 px-4 py-3 text-black shadow-[0_3px_0px_0px_rgba(0,0,0,1)] font-sans">
        <div className="flex items-center justify-between">
          {/* User profile & Token status */}
          <div className="flex items-center gap-2">
            {user ? (
              <div className="flex items-center gap-1.5 bg-white border-2 border-black rounded-xl p-1 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                <img src={user.photoURL || ""} alt="User profile avatar" className="w-5 h-5 rounded border border-black" referrerPolicy="no-referrer" />
                <span className="text-[9px] bg-green-200 text-black border border-black font-black uppercase tracking-wider px-1.5 rounded-sm font-mono">{profile?.currentTokens || 0} Tokens</span>
                <button 
                  onClick={() => setIsPurchaseModalOpen(true)}
                  className="text-[8px] bg-yellow-300 hover:bg-yellow-400 text-black border border-black font-black uppercase px-1 py-0.5 rounded cursor-pointer transition-all font-sans font-black"
                >
                  + BUY
                </button>
              </div>
            ) : (
              <button 
                onClick={handleLogin}
                className="px-2.5 py-1.5 bg-yellow-300 text-black text-[9px] font-black uppercase tracking-wider rounded-xl border-2 border-black shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] cursor-pointer"
              >
                Sign In
              </button>
            )}

            {/* User and Tokens indicators remaining cleanly */}
          </div>

          {/* Charity and leaderboard trigger */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button 
              onClick={() => {
                setOnboardingStep(0);
                setIsOnboardingOpen(true);
              }}
              className="bg-sky-300 border-2 border-black w-6 h-6 flex items-center justify-center rounded-lg shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 text-black font-black text-xs cursor-pointer select-none"
              title="How to Play"
            >
              ❓
            </button>
            <button 
              onClick={() => setLiveTracking(!liveTracking)}
              className={`border-2 border-black h-6 px-1.5 flex items-center justify-center rounded-lg shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 text-black font-black text-[9px] uppercase cursor-pointer select-none transition-all ${liveTracking ? 'bg-emerald-300 font-extrabold shadow-[1.5px_1.5px_0px_0px_#047857]' : 'bg-gray-100'}`}
              title="Snap Lock camera tracking onto our player baby"
            >
              📡 {liveTracking ? 'LOCKED' : 'TRACK'}
            </button>
            <button 
              onClick={() => setIsLeaderboardOpen(true)}
              className="bg-yellow-300 border-2 border-black px-2.5 py-1 rounded-xl flex items-center gap-1 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 text-black font-black text-[9.5px] uppercase cursor-pointer"
            >
              <span>💝</span> ${totalRaised.toLocaleString()}
            </button>
            {user && (
              <button onClick={handleLogout} className="text-gray-500 hover:text-red-500 border border-black p-1 bg-white rounded-lg cursor-pointer" title="Sign Out">
                <RotateCcw size={12}/>
              </button>
            )}
          </div>
        </div>
      </div>



      {/* Charity Counter (Desktop only) */}
      <div className="hidden md:flex fixed top-8 right-8 z-50 flex-col items-end gap-3">
        <div className="flex items-center gap-4">
          <button 
            type="button"
            onClick={() => {
              setOnboardingStep(0);
              setIsOnboardingOpen(true);
            }}
            className="bg-sky-300 border-3 border-black w-12 h-12 flex items-center justify-center rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 active:translate-x-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all font-black text-xl cursor-pointer select-none"
            title="How to Play / About Baby Push!"
          >
            ❓
          </button>
          {/* Profile / Login */}
          <div className="bg-[#fcfaf4] border-3 border-black rounded-2xl p-2.5 flex items-center gap-3 pr-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] pointer-events-auto">
            {user ? (
              <>
                <img src={user.photoURL || ""} alt={user.displayName || ""} className="w-8 h-8 rounded-lg border-2 border-black" referrerPolicy="no-referrer" />
                <div className="flex flex-col">
                  <span className="text-[10px] text-black font-extrabold tracking-tight leading-none mb-0.5">{user.displayName}</span>
                  
                  {/* Sponsor Your Own Baby Button directly under user's name */}
                  <button
                    type="button"
                    onClick={() => setIsSponsorCreateModalOpen(true)}
                    className="mt-1 mb-1 text-[7.5px] bg-gradient-to-r from-emerald-300 to-emerald-400 hover:opacity-95 text-black border border-black font-black uppercase tracking-tighter px-1.5 py-0.5 rounded cursor-pointer transition-all shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none flex items-center justify-center gap-0.5"
                  >
                    👶 Sponsor Your Baby (500 T)
                  </button>

                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-[8px] bg-green-200 text-black border border-black font-black uppercase tracking-wider px-1 rounded-sm">{profile?.currentTokens || 0} Tokens</span>
                    <button 
                      onClick={() => setIsPurchaseModalOpen(true)}
                      className="text-[7.5px] bg-yellow-300 hover:bg-yellow-400 text-black border border-black font-black uppercase tracking-tighter px-1 py-0.5 rounded cursor-pointer transition-all shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)]"
                    >
                      + BUY
                    </button>
                  </div>
                </div>
                <button onClick={handleLogout} className="ml-2 text-gray-500 hover:text-red-500 border border-transparent hover:border-black p-1 hover:bg-yellow-250 rounded transition-all cursor-pointer" title="Sign Out"><RotateCcw size={13}/></button>
              </>
            ) : (
              <button 
                onClick={handleLogin}
                className="px-4 py-2 bg-yellow-300 text-black text-[10px] font-black uppercase tracking-widest rounded-xl border-2 border-black hover:bg-yellow-400 transition-colors cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:translate-x-0.5 active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)]"
              >
                Sign In
              </button>
            )}
          </div>

          <button 
            onClick={() => setIsLeaderboardOpen(true)}
            className="bg-white border-3 border-black p-4 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-right group hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all pointer-events-auto cursor-pointer"
          >
            <span className="text-[10px] text-black/60 font-black uppercase tracking-wider group-hover:text-black font-sans">💖 Donated to Charity</span>
            <div className="flex items-baseline gap-1 justify-end font-extrabold">
               <span className="text-black/50 font-mono text-sm">$</span>
               <span className="text-3xl font-black text-black italic tracking-tighter tabular-nums font-sans">
                 {totalRaised.toLocaleString()}
               </span>
            </div>
            <div className="text-[8px] text-black/40 uppercase tracking-widest font-black mt-1">
               Click for Hall of Fame &rarr;
            </div>
          </button>
        </div>
      </div>

      {/* Dynamic Auth Troubleshooting Instructions (Responsive overlay) */}
      {loginError && (
        <div className="fixed top-16 md:top-24 right-4 md:right-8 z-[201] pointer-events-auto text-left max-w-[calc(100vw-32px)] sm:max-w-[320px]">
          <div className="bg-[#fffbf2] border-3 border-black p-4 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] space-y-3 text-black">
            <div className="flex justify-between items-center border-b-2 border-black pb-2">
              <span className="font-extrabold text-red-600 uppercase tracking-wider text-[11px] flex items-center gap-1">⚠️ SIGN IN NOTICE</span>
              <button 
                onClick={() => setLoginError(null)} 
                className="text-gray-500 hover:text-black hover:bg-gray-200 border border-transparent hover:border-black rounded px-1.5 py-0.5 text-xs transition-all font-black cursor-pointer"
              >
                ✕
              </button>
            </div>
            
            <p className="font-sans font-extrabold text-[#dc2626] leading-snug">
              {loginError}
            </p>

            <div className="border-t-2 border-black pt-3 mt-1 space-y-2">
              <p className="font-black text-[10px] tracking-wider text-black uppercase">DEVELOPER GUIDE:</p>
              <p className="text-[10px] leading-relaxed text-black/80 font-medium font-sans">
                If you're seeing a blank page that closes, add this domain as an authorized redirect under <strong className="font-extrabold">Authentication &rsaquo; Settings &rsaquo; Authorized Domains</strong> inside your Firebase Console:
              </p>
              
              <div className="bg-white border-2 border-dashed border-black p-2 rounded-lg text-center mt-1">
                <code className="text-xs select-all font-bold font-mono text-black">
                  {window.location.hostname}
                </code>
              </div>

              <a 
                href="https://console.firebase.google.com/project/knotted-inkwell-mcf5x/authentication/settings" 
                target="_blank" 
                rel="noreferrer"
                className="inline-flex items-center justify-center w-full mt-2 px-4 py-2.5 bg-yellow-300 hover:bg-yellow-400 text-black border-2 border-black font-black text-[10px] uppercase rounded-xl shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all cursor-pointer text-center"
              >
                Firebase Console Link &rarr;
              </a>
            </div>
          </div>
        </div>
      )}


      {/* Leaderboard Modal */}
      {isLeaderboardOpen && (
        <div className="fixed inset-0 z-[400] flex items-start md:items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto text-black py-6">
          <motion.div 
            initial={{ scale: 0.9, y: 15 }}
            animate={{ scale: 1, y: 0 }}
            className="max-w-md w-full bg-[#fdfdfc] border-4 border-black rounded-3xl overflow-hidden shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] my-auto"
          >
            <div className="p-6 border-b-4 border-black bg-yellow-300 flex justify-between items-center">
              <div>
                <h2 className="text-3xl font-black text-black uppercase tracking-tight">Leaderboard</h2>
                <p className="text-[9px] text-black font-black uppercase tracking-wider font-mono">Charity Hall of Fame</p>
              </div>
              <button 
                onClick={() => setIsLeaderboardOpen(false)}
                className="w-9 h-9 flex items-center justify-center rounded-lg border-2 border-black bg-rose-500 text-white font-black hover:bg-rose-600 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] cursor-pointer"
              >✕</button>
            </div>
            <div className="p-6 space-y-3 max-h-[50vh] overflow-y-auto bg-white/50">
              {leaderboard.length === 0 && (
                <div className="text-center italic text-black/40 text-xs py-8">Be the first player to donate and top the ranks!</div>
              )}
              {leaderboard.map((donor, i) => (
                <div key={donor.id} className="flex items-center justify-between p-3.5 rounded-xl bg-white border-2 border-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-black bg-yellow-105 text-black w-6 h-6 rounded-md flex items-center justify-center border border-black">{i + 1}</span>
                    <span className="text-xs text-black font-black uppercase">{donor.displayName}</span>
                  </div>
                  <div className="text-black font-black text-sm italic bg-green-200 border border-black px-2.5 py-0.5 rounded-md flex items-center gap-0.5">
                    <span className="text-[10px] mr-1 opacity-60">$</span>
                    {donor.totalDonated.toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      )}

      {/* Buy Tokens Modal with official Ko-fi secure purchase system */}
      {isPurchaseModalOpen && (
        <div className="fixed inset-0 z-[400] flex items-start md:items-center justify-center bg-black/70 backdrop-blur-sm overflow-y-auto p-4 text-black py-8">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="max-w-xl w-full bg-[#fdfaf2] border-4 border-black rounded-3xl p-6 sm:p-8 relative shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] my-auto"
          >
            {/* Header section closely matching theme */}
            <div className="text-center mb-5 relative z-10">
              <div className="inline-block relative">
                <h2 className="text-2xl sm:text-3xl font-black text-black bg-yellow-300 px-6 py-2 rounded-2xl border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] uppercase -skew-x-1">
                  Get Game Tokens
                </h2>
              </div>
              <p className="text-[10px] text-rose-600 font-black uppercase tracking-widest mt-2.5 font-mono">
                ⚡ SECURE REFILL STATION ⚡
              </p>
              
              {paymentError && (
                <div className="max-w-md mx-auto mt-4 bg-red-50 border-2 border-red-500 text-red-900 p-4 rounded-xl text-left relative z-10 text-xs font-bold font-mono">
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-black text-[10px] uppercase text-red-650">⚠️ FAILED REQUEST</span>
                    <button 
                      onClick={() => setPaymentError(null)} 
                      type="button" 
                      className="text-red-500 hover:text-red-700 font-bold bg-white border border-red-400 text-[9px] px-1.5 py-0.5 rounded cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                  <p className="opacity-95">{paymentError}</p>
                </div>
              )}

              {paymentLoading && (
                <div className="max-w-md mx-auto mt-4 bg-blue-50 border-2 border-blue-500 text-blue-900 px-4 py-2.5 rounded-xl text-center relative z-10 text-[10px] font-black uppercase tracking-wider animate-pulse flex items-center justify-center gap-2">
                  <span className="animate-spin text-sm">🌀</span> Updating credits on Firestore...
                </div>
              )}
            </div>

            {/* Back effects inside the modal */}
            <div className="absolute inset-0 pointer-events-none opacity-25">
              <div className="absolute inset-0" style={{
                backgroundImage: 'radial-gradient(#1e1a15 6%, transparent 6%)',
                backgroundSize: '16px 16px'
              }} />
            </div>

            {/* Closing Button */}
            <button 
              onClick={() => setIsPurchaseModalOpen(false)}
              className="absolute top-4 right-4 w-9 h-9 border-3 border-black rounded-lg bg-rose-500 text-white font-black hover:bg-rose-600 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 transition-all text-xs flex items-center justify-center cursor-pointer z-[50]"
            >
              ✕
            </button>

            <div className="relative z-10 space-y-4">
              <p className="text-[11px] text-black/75 font-semibold text-center leading-normal max-w-sm mx-auto">
                Fuel the developers, keep match hosts online, and fund new feature updates! Tokens are instantly credited.
              </p>

              {/* Stripe Payment Content */}
              <div className="bg-white border-3 border-black rounded-2xl p-4 sm:p-5 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-center space-y-4">
                <div className="bg-indigo-600 border-2 border-black rounded-xl p-3.5 text-center space-y-1 text-white">
                  <div className="text-[11px] font-black uppercase tracking-wide text-yellow-300">
                    ⚡ Stripe Secure Payments
                  </div>
                  <div className="text-2xl font-black font-mono leading-none my-1">
                    $1.00 USD = 1 Token
                  </div>
                  <p className="text-[10px] text-indigo-100 font-medium leading-normal max-w-sm mx-auto">
                    Experience lightning-fast instant credit with zero manual code input! Buy safely with major cards or Apple Pay.
                  </p>
                </div>

                {/* Pre-configured Options */}
                <div className="grid grid-cols-2 gap-2 mt-2">
                  {[
                    { tokens: 5, label: "🍼 Starter Pack" },
                    { tokens: 20, label: "🚀 Cadet Cache", popular: true },
                    { tokens: 50, label: "⚔️ Warlord Hoard" },
                    { tokens: 100, label: "👑 Emperor Vault" }
                  ].map((item) => (
                    <button
                      key={item.tokens}
                      type="button"
                      onClick={() => setStripeTokenQuantity(item.tokens)}
                      className={`p-3 border-2 border-black rounded-xl text-left transition-all relative cursor-pointer ${
                        stripeTokenQuantity === item.tokens
                          ? 'bg-indigo-50 border-indigo-600 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]'
                          : 'bg-stone-50 hover:bg-stone-100 shadow-[1px_1px_0px_0px_rgba(0,0,0,1)]'
                      }`}
                    >
                      {item.popular && (
                        <span className="absolute -top-2 right-2 bg-rose-500 text-white text-[7px] font-black uppercase px-1 py-0.5 rounded border border-black shadow-[1px_1px_0px_0px_rgba(0,0,0,1)]">
                          POPULAR
                        </span>
                      )}
                      <div className="text-[10px] font-black uppercase text-black/70 mb-0.5">{item.label}</div>
                      <div className="text-sm font-black text-black">{item.tokens} Tokens</div>
                      <div className="text-[9px] font-mono text-black/60 font-bold">${item.tokens}.00 USD</div>
                    </button>
                  ))}
                </div>

                {/* Custom Quantity */}
                <div className="bg-stone-50 border-2 border-black p-3 rounded-xl text-left shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                  <label className="text-[9px] font-black uppercase tracking-wide text-black/75 block mb-1 font-sans">
                    Or enter custom amount (tokens):
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="1"
                      max="10000"
                      value={stripeTokenQuantity || ""}
                      onChange={(e) => setStripeTokenQuantity(Math.max(1, Math.min(10000, parseInt(e.target.value) || 0)))}
                      className="flex-1 bg-white border-2 border-black py-2 px-3 rounded-lg font-bold text-xs outline-none text-black placeholder:text-black/30"
                      placeholder="e.g. 15"
                    />
                    <div className="bg-stone-100 border-2 border-black px-3.5 py-1.5 rounded-lg flex items-center justify-center font-bold text-xs font-mono text-black">
                      ${stripeTokenQuantity || 0}.00 USD
                    </div>
                  </div>
                </div>

                {/* Checkout CTA */}
                <button
                  type="button"
                  onClick={() => handleStripeCheckout(stripeTokenQuantity)}
                  disabled={paymentLoading || !stripeTokenQuantity || stripeTokenQuantity <= 0}
                  className={`w-full py-3.5 text-center bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs border-3 border-black rounded-xl hover:-translate-y-0.5 active:translate-y-0.5 transition-all block uppercase shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] cursor-pointer ${
                    (paymentLoading || !stripeTokenQuantity) ? 'opacity-55 cursor-not-allowed' : ''
                  }`}
                >
                  {paymentLoading ? (
                    <span className="flex items-center justify-center gap-2">🌀 Directing to Stripe Secure Portal...</span>
                  ) : (
                    <span>💳 Secure Checkout with Stripe &rarr;</span>
                  )}
                </button>
              </div>
            </div>

            <div className="text-center mt-5">
              <button 
                onClick={() => setIsPurchaseModalOpen(false)}
                className="text-black/50 hover:text-black font-black text-[9px] uppercase tracking-wider underline cursor-pointer"
              >
                Close & Return to Battle
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Tactical Abilities Popup Modal (Desktop Compact & Clean Overlays) */}
      {isAbilitiesExpanded && (
        <div className="fixed inset-0 z-[410] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 text-black font-sans">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-2xl bg-[#fefdfa] border-4 border-black rounded-3xl p-6 sm:p-8 relative shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] max-h-[90vh] overflow-y-auto z-[420]"
          >
            {/* Design effects inside the modal (Grid background for beautiful brutalist texture) */}
            <div className="absolute inset-0 pointer-events-none opacity-[0.05]" style={{
              backgroundImage: 'radial-gradient(#000000 8%, transparent 8%)',
              backgroundSize: '16px 16px'
            }} />

            {/* Absolute close button */}
            <button
              onClick={() => setIsAbilitiesExpanded(false)}
              className="absolute top-4 right-4 w-9 h-9 border-3 border-black rounded-xl bg-orange-400 text-black font-black hover:bg-orange-500 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 transition-all text-sm flex items-center justify-center cursor-pointer z-[50]"
            >
              ✕
            </button>

            {/* Header */}
            <div className="relative z-10 text-center mb-6">
              <span className="text-[9px] bg-black text-[#ffde43] font-mono px-2 py-0.5 rounded-sm uppercase font-black tracking-widest border border-black">
                Tactical Division Center
              </span>
              <h2 className="text-2xl sm:text-3xl font-black uppercase text-black mt-2 tracking-tight">
                ⚔️ Tactical Abilities Menu
              </h2>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#eae6dc] border-2 border-black rounded-xl text-[10px] font-black font-mono">
                  <span>Target Unit:</span>
                  <span className="bg-white border border-black px-1.5 py-0.2 rounded text-indigo-700">
                    {sponsoredBabies.find(b => b.id === selectedBabyId) ? `👶 ${sponsoredBabies.find(b => b.id === selectedBabyId)?.name}` : (selectedBabySide === 'blue' ? '🔵 Blue Stroller' : '🔴 Red Stroller')}
                  </span>
                </div>
                
                <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 border-2 border-black rounded-xl text-[10px] font-black font-mono">
                  <span>Balance:</span>
                  <span className="bg-emerald-200 border border-emerald-500 px-1.5 py-0.2 rounded">
                    🪙 {profile?.currentTokens ?? 0} Tokens
                  </span>
                </div>
              </div>
            </div>

            {/* Grid of abilities */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 relative z-10">
              {/* 1. MOVE */}
              <button
                onClick={() => {
                  setIsAbilitiesExpanded(false);
                  setActiveModal({ side: selectedBabySide, type: 'move' });
                }}
                className="flex items-center gap-3 p-3 bg-blue-50 border-2 border-black rounded-2xl text-left hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4.5px_4.5px_0px_0px_rgba(0,0,0,1)] hover:bg-blue-100 transition-all cursor-pointer group"
              >
                <span className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-blue-500 border-2 border-black text-xl text-white shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)]">
                  💥
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase tracking-wide group-hover:text-blue-700">Move Step</span>
                    <span className="text-[9px] bg-black text-white font-mono font-bold px-1 py-0.2 rounded">1 T/Step</span>
                  </div>
                  <p className="text-[10px] text-black/75 font-medium leading-tight mt-1">
                    Increment or decrement direct coordinates. Perfect for quick precise alignments.
                  </p>
                </div>
              </button>

              {/* 2. GRID */}
              <button
                onClick={() => {
                  setIsAbilitiesExpanded(false);
                  setActiveModal({ side: selectedBabySide, type: 'grid' });
                }}
                className="flex items-center gap-3 p-3 bg-stone-50 border-2 border-black rounded-2xl text-left hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4.5px_4.5px_0px_0px_rgba(0,0,0,1)] hover:bg-stone-100 transition-all cursor-pointer group"
              >
                <span className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-blue-100 border-2 border-black text-xl text-black shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)]">
                  ♟️
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase tracking-wide group-hover:text-amber-700">Push Grid</span>
                    <span className="text-[9px] bg-black text-white font-mono font-bold px-1 py-0.2 rounded">2 T/Seg</span>
                  </div>
                  <p className="text-[10px] text-black/75 font-medium leading-tight mt-1">
                    Push standard coordinate segments horizontally/vertically to maneuver obstacles.
                  </p>
                </div>
              </button>

              {/* 3. TELE */}
              <button
                onClick={() => {
                  setIsAbilitiesExpanded(false);
                  handleTeleport(selectedBabyId);
                }}
                className="flex items-center gap-3 p-3 bg-purple-50 border-2 border-black rounded-2xl text-left hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4.5px_4.5px_0px_0px_rgba(0,0,0,1)] hover:bg-purple-100 transition-all cursor-pointer group"
              >
                <span className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-purple-200 border-2 border-black text-xl text-black shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)]">
                  🔮
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase tracking-wide group-hover:text-purple-700">Teleport</span>
                    <span className="text-[9px] bg-purple-600 text-white font-mono font-bold px-1 py-0.2 rounded">5 Tokens</span>
                  </div>
                  <p className="text-[10px] text-black/75 font-medium leading-tight mt-1">
                    Instantly warp targeted baby stroller into a random safe location zone.
                  </p>
                </div>
              </button>

              {/* 4. WALL */}
              <button
                onClick={() => {
                  setIsAbilitiesExpanded(false);
                  setActiveModal({ side: selectedBabySide, type: 'wall' });
                }}
                className="flex items-center gap-3 p-3 bg-[#fdfdfc] border-2 border-black rounded-2xl text-left hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4.5px_4.5px_0px_0px_rgba(0,0,0,1)] hover:bg-slate-100 transition-all cursor-pointer group"
              >
                <span className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-slate-200 border-2 border-black text-xl text-black shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)]">
                  🚧
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase tracking-wide group-hover:text-slate-700">Erect Wall</span>
                    <span className="text-[9px] bg-black text-white font-mono font-bold px-1 py-0.2 rounded">2 T/Pixel</span>
                  </div>
                  <p className="text-[10px] text-black/75 font-medium leading-tight mt-1">
                    Build protective concrete brick blocks on arena lines to block rivals.
                  </p>
                </div>
              </button>

              {/* 5. MINE */}
              <button
                onClick={() => {
                  setIsAbilitiesExpanded(false);
                  setActiveModal({ side: selectedBabySide, type: 'mine' });
                }}
                className="flex items-center gap-3 p-3 bg-orange-50 border-2 border-black rounded-2xl text-left hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4.5px_4.5px_0px_0px_rgba(0,0,0,1)] hover:bg-orange-100 transition-all cursor-pointer group"
              >
                <span className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-orange-200 border-2 border-black text-xl text-black shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)]">
                  💣
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase tracking-wide group-hover:text-amber-700">Deploy Mines</span>
                    <span className="text-[9px] bg-orange-600 text-white font-mono font-bold px-1 py-0.2 rounded">20 Tokens</span>
                  </div>
                  <p className="text-[10px] text-black/75 font-medium leading-tight mt-1">
                    Seed 20 invisible anti-personnel trap detonators on opposing player's lanes.
                  </p>
                </div>
              </button>

              {/* 6. LUCK */}
              <button
                onClick={() => {
                  setIsAbilitiesExpanded(false);
                  handleJackpot(selectedBabyId);
                }}
                className="flex items-center gap-3 p-3 bg-yellow-50 border-2 border-black rounded-2xl text-left hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4.5px_4.5px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-101 transition-all cursor-pointer group"
              >
                <span className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-yellow-250 border-2 border-black text-xl text-black shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)]">
                  🎰
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase tracking-wide group-hover:text-yellow-700">Jackpot Spin</span>
                    <span className="text-[9px] bg-yellow-600 text-black font-mono font-bold px-1 py-0.2 rounded">10 Tokens</span>
                  </div>
                  <p className="text-[10px] text-black/75 font-medium leading-tight mt-1">
                    Spin active mechanical outcome wheel for a random package prize.
                  </p>
                </div>
              </button>

              {/* 7. RUN */}
              <button
                onClick={() => {
                  setIsAbilitiesExpanded(false);
                  handleSprint(selectedBabyId);
                }}
                className="flex items-center gap-3 p-3 bg-cyan-50 border-2 border-black rounded-2xl text-left hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4.5px_4.5px_0px_0px_rgba(0,0,0,1)] hover:bg-cyan-100 transition-all cursor-pointer group"
              >
                <span className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-cyan-200 border-2 border-black text-xl text-black shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)]">
                  🏃
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase tracking-wide group-hover:text-cyan-700">Sprint Mode</span>
                    <span className="text-[9px] bg-cyan-600 text-white font-mono font-bold px-1 py-0.2 rounded">10 Tokens</span>
                  </div>
                  <p className="text-[10px] text-black/75 font-medium leading-tight mt-1">
                    Unleash speedy 2x physical step rate acceleration for 30 seconds instantly.
                  </p>
                </div>
              </button>

              {/* 8. SLINGSHOT */}
              <button
                onClick={() => {
                  setIsAbilitiesExpanded(false);
                  setActiveModal({ side: selectedBabySide, type: 'slingshot' });
                }}
                className="flex items-center gap-3 p-3 bg-rose-50 border-2 border-black rounded-2xl text-left hover:-translate-y-0.5 active:translate-y-0.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4.5px_4.5px_0px_0px_rgba(0,0,0,1)] hover:bg-rose-100 transition-all cursor-pointer group animate-pulse"
              >
                <span className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-rose-200 border-2 border-black text-xl text-black shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)]">
                  🏹
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase tracking-wide group-hover:text-rose-700">Slingshot</span>
                    <span className="text-[9px] bg-rose-600 text-white font-mono font-bold px-1 py-0.2 rounded">100 Tokens</span>
                  </div>
                  <p className="text-[10px] text-black/75 font-medium leading-tight mt-1">
                    Catapult targeted unit stroller clear of high density chokepoints.
                  </p>
                </div>
              </button>
            </div>

            {/* Mine Hazards Action Board, clean integration inside the popup */}
            {selectedSideHasMines && (
              <div className="mt-5 border-t-2 border-neutral-200 pt-5 relative z-10">
                <div className="bg-amber-50 border-2 border-[#eab308] rounded-2xl p-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                  <div className="flex items-center gap-2 mb-2 text-amber-900">
                    <span className="text-lg">📢</span>
                    <h4 className="text-xs font-black uppercase tracking-wider font-sans text-rose-700">
                      Territorial Hazard Sweeper Required
                    </h4>
                  </div>
                  <p className="text-[10px] text-amber-900 font-medium mb-3 leading-normal">
                    Adversary mine detonators are active inside your segment zone coords! Run scans to clear them safely:
                  </p>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {!selectedSideMinesRevealed ? (
                      <button
                        onClick={() => {
                          setIsAbilitiesExpanded(false);
                          handleRevealMines(selectedBabySide);
                        }}
                        className="flex items-center justify-center gap-2 py-2.5 bg-amber-200 hover:bg-amber-300 text-black border-2 border-black rounded-xl text-[11px] font-black uppercase hover:-translate-y-0.5 active:translate-y-0.5 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] cursor-pointer"
                      >
                        <span>👁️ Reveal Mines</span>
                        <span className="text-[9px] bg-black text-amber-200 px-1.5 py-0.5 rounded font-black font-mono">100 T</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setIsAbilitiesExpanded(false);
                          handleClearMines(selectedBabySide);
                        }}
                        className="flex items-center justify-center gap-2 py-2.5 bg-red-200 hover:bg-red-300 text-black border-2 border-black rounded-xl text-[11px] font-black uppercase hover:-translate-y-0.5 active:translate-y-0.5 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] cursor-pointer animate-pulse"
                      >
                        <span>🧹 Sweep & Clean side</span>
                        <span className="text-[9px] bg-black text-red-200 px-1.5 py-0.5 rounded font-black font-mono">150 T</span>
                      </button>
                    )}
                    <div className="flex items-center justify-center text-[9px] font-mono text-black/50 font-bold p-1 text-center sm:text-left leading-tight">
                      ℹ️ Scans make mine pixels visible before executing reclaim procedures.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Bottom Bar Close */}
            <div className="mt-6 flex justify-end gap-3 border-t border-neutral-100 pt-5 relative z-10">
              <button
                onClick={() => setIsAbilitiesExpanded(false)}
                className="px-5 py-2.5 bg-[#eae6dc] hover:bg-[#dedad0] text-black border-2 border-black rounded-xl text-xs font-black uppercase hover:-translate-y-0.5 active:translate-y-0.5 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] cursor-pointer transition-all"
              >
                Cancel &bull; Close
              </button>
            </div>
          </motion.div>
        </div>
      )}

      <div 
        ref={gridRef}
        className="relative flex-none origin-top-left bg-[#fffdfa] border-4 border-black rounded-3xl shadow-[12px_12px_0px_0px_#000]"
        style={{ 
          width: `${widthSize * 4}px`,
          height: `${heightSize * 4}px`,
          backgroundImage: 'linear-gradient(to right, rgba(0,0,0,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.06) 1px, transparent 1px)',
          backgroundSize: '4px 4px',
          transform: `translate(${transformRef.current.x}px, ${transformRef.current.y}px) scale(${transformRef.current.scale})`
        }}
        onClick={handleGridClick}
      >
        {/* Championship Finish Line (Checkered Pattern) */}
        <div 
          className="absolute left-0 w-full h-[16px] border-b-4 border-black z-10 flex items-center justify-between pointer-events-none overflow-hidden"
          style={{
            top: '16px',
            backgroundColor: '#000',
            backgroundImage: 'conic-gradient(#fff 0.25turn, #000 0.25turn 0.5turn, #fff 0.5turn 0.75turn, #000 0.75turn)',
            backgroundSize: '16px 16px'
          }}
        >
          {/* Neon Indicators in the finish strip */}
          <div className="bg-yellow-300 text-black border-r-3 border-black font-black text-[9px] uppercase px-3 py-0.5 tracking-wider select-none font-sans shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] z-20">
            🏁 BLUE GOAL
          </div>
          <div className="bg-yellow-300 text-black border-l-3 border-black font-black text-[9px] uppercase px-3 py-0.5 tracking-wider select-none font-sans shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] z-20">
            🏁 RED GOAL
          </div>
        </div>

        {/* Blue Spawn Zone Base Cover */}
        <div 
          className="absolute border-3 border-[#3b82f6] bg-blue-50/50 rounded-2xl flex flex-col items-center justify-center pointer-events-none"
          style={{
            left: `${(49 - 8) * 4}px`,
            top: `${(245 - 10) * 4}px`,
            width: `${16 * 4}px`,
            height: `${14 * 4}px`
          }}
        >
          <span className="text-[#3b82f6] font-black tracking-tight text-[8px] uppercase">BLUE SPAWN BASE</span>
          <span className="text-[10px]">👶🍼</span>
        </div>

        {/* Red Spawn Zone Base Cover */}
        <div 
          className="absolute border-3 border-[#ef4444] bg-red-50/50 rounded-2xl flex flex-col items-center justify-center pointer-events-none"
          style={{
            left: `${(149 - 8) * 4}px`,
            top: `${(245 - 10) * 4}px`,
            width: `${16 * 4}px`,
            height: `${14 * 4}px`
          }}
        >
          <span className="text-[#ef4444] font-black tracking-tight text-[8px] uppercase">RED SPAWN BASE</span>
          <span className="text-[10px]">👶🍼</span>
        </div>

        {/* Permanent Obstacles (Rendered as 4px slate-colored wall bricks) */}
        {PERMANENT_WALL_PIXELS.map((pt, idx) => (
          <div 
            key={`perm-wall-${idx}`}
            className="absolute bg-slate-700 border border-slate-500 box-border z-[4]"
            style={{
              left: `${pt.x * 4}px`,
              top: `${pt.y * 4}px`,
              width: '4px',
              height: '4px'
            }}
          />
        ))}

        {walls.map((coord, i) => {
          const [wx, wy] = coord.split(',').map(Number);
          return (
            <div 
              key={`wall-${i}`}
              className="absolute bg-slate-700 border border-slate-500 box-border"
              style={{
                left: `${wx * 4}px`,
                top: `${wy * 4}px`,
                width: '4px',
                height: '4px'
              }}
            />
          );
        })}

        {/* Trail rendering (Chalk marks) */}
        {blueTrail.map((coord, idx) => {
          const [tx, ty] = coord.split(',').map(Number);
          return (
             <div 
               key={`blue-${idx}`}
               className="absolute bg-blue-500/30"
               style={{ 
                 left: `${tx * 4}px`, 
                 top: `${ty * 4}px`,
                 width: '4px',
                 height: '4px'
               }}
             />
          );
        })}
        {/* Trail rendering (Red) */}
        {redTrail.map((coord, idx) => {
          const [tx, ty] = coord.split(',').map(Number);
          return (
             <div 
               key={`red-${idx}`}
               className="absolute bg-red-500/30"
               style={{ 
                 left: `${tx * 4}px`, 
                 top: `${ty * 4}px`,
                 width: '4px',
                 height: '4px'
               }}
             />
          );
        })}



        {/* Mines rendering */}
        {mines.map((coord, idx) => {
          const [mx, my] = coord.split(',').map(Number);
          const isRevealedForSide = mx < widthSize / 2 
            ? (blueMinesRevealed || minesRevealed) 
            : (redMinesRevealed || minesRevealed);
          
          if (!isRevealedForSide) return null;
          return (
             <div 
               key={`mine-revealed-${idx}`}
               className="absolute bg-amber-400 rounded-full z-10"
               style={{ 
                 left: `${mx * 4 + 1}px`, 
                 top: `${my * 4 + 1}px`,
                 width: '2px',
                 height: '2px',
                 boxShadow: '0 0 8px 3px #ff4500, 0 0 12px 6px #ff7700',
                 border: '1px solid #ffffff'
               }}
             />
          );
        })}

        {/* Landmarks rendering */}
        {landmarks && landmarks.map((lm, idx) => (
          <div 
            key={`lm-render-${lm.id || idx}`}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedLandmark(lm);
            }}
            className="absolute border-2 border-black rounded flex items-center justify-center cursor-pointer select-none z-[12] hover:scale-110 hover:-translate-y-0.5 active:scale-95 text-[10px] shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] transition-all"
            style={{
              left: `${lm.x * 4}px`,
              top: `${lm.y * 4}px`,
              width: `${4 * 4}px`,
              height: `${4 * 4}px`,
              backgroundColor: lm.color || '#10b981',
            }}
            title={`${lm.name} - by ${lm.creatorName} (Click to inspect)`}
          >
            🏰
          </div>
        ))}

        {/* Left blue shade */}
        <div className="absolute top-0 left-0 w-1/2 h-full bg-blue-500/10 pointer-events-none" />
        
        {/* Right red shade */}
        <div className="absolute top-0 right-0 w-1/2 h-full bg-red-500/10 pointer-events-none" />

        {/* Middle vertical red divider */}
        <div 
          className="absolute top-0 left-1/2 w-[2px] h-full bg-red-600 -translate-x-1/2 pointer-events-none z-10" 
          style={{ left: `${(widthSize * 4) / 2}px` }}
        />

        {/* Blue figure */}
        <div 
          onClick={(e) => {
            e.stopPropagation();
            setSelectedBabyId('blue');
            addLog("Switching control to Blue Baby");
          }}
          className="absolute w-8 h-8 cursor-pointer z-20 flex items-center justify-center hover:scale-110 active:scale-95 transition-all select-none"
          style={{ 
            left: `${bluePos.x * 4 - 14}px`, 
            top: `${bluePos.y * 4 - 14}px`,
            transform: `rotate(${blueRot}deg)`,
            transition: 'left 0.1s linear, top 0.1s linear, transform 0.1s ease-out'
          }}
          title="Blue Baby Stroller (Click to select)"
        >
          <img 
            src="https://lh3.googleusercontent.com/d/1SNCMihirT-5iX9Fp_AZTclJTJ0P5kae4"
            className="w-full h-full object-contain pointer-events-none"
            referrerPolicy="no-referrer"
            alt="Blue figure"
          />
        </div>

        {/* Red figure (Updated URL and slightly smaller) */}
        <div 
          onClick={(e) => {
            e.stopPropagation();
            setSelectedBabyId('red');
            addLog("Switching control to Red Baby");
          }}
          className="absolute w-8 h-8 cursor-pointer z-20 flex items-center justify-center hover:scale-110 active:scale-95 transition-all select-none"
          style={{ 
            left: `${redPos.x * 4 - 14}px`, 
            top: `${redPos.y * 4 - 14}px`,
            transform: `rotate(${redRot}deg)`,
            transition: 'left 0.1s linear, top 0.1s linear, transform 0.1s ease-out'
          }}
          title="Red Baby Stroller (Click to select)"
        >
          <img 
            src="https://lh3.googleusercontent.com/d/1MBQVettULlTDGfz3HDLUojv_4kj7dlkx"
            className="w-full h-full object-contain pointer-events-none"
            referrerPolicy="no-referrer"
            alt="Red figure"
          />
        </div>

        {/* Render separate grid tracks for each sponsored baby */}
        {sponsoredBabies && sponsoredBabies.map((b, bIdx) => {
          const isLeft = b.side === 'left';
          // Find the index among babies on the same side
          const sameSideBabies = sponsoredBabies.filter(x => x.side === b.side);
          const sideIndex = sameSideBabies.findIndex(x => x.id === b.id);
          
          // Calculate track left position: 8 col * 4px = 32px track width
          const trackWidth = 32; 
          const trackGap = 16;
          const leftOffset = isLeft 
            ? -((sideIndex + 1) * trackWidth + (sideIndex + 1) * trackGap)
            : (widthSize * 4) + (sideIndex * trackWidth + (sideIndex + 1) * trackGap);

          const isSelected = selectedBabyId === b.id;

          return (
            <div
              key={`track-container-${b.id}`}
              className="absolute top-0 h-full border-4 rounded-3xl shadow-[4px_4px_0px_0px_#000] cursor-default z-[5] overflow-visible transition-all"
              style={{
                left: `${leftOffset}px`,
                width: `${trackWidth}px`,
                backgroundColor: '#ffffff',
                borderColor: b.color,
                boxShadow: isSelected ? `0 0 16px ${b.color}, 4px 4px 0px 0px #000` : `4px 4px 0px 0px #000`,
                backgroundImage: `linear-gradient(to right, rgba(0,0,0,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.06) 1px, transparent 1px), linear-gradient(to bottom, ${b.color}0a, ${b.color}15)`,
                backgroundSize: '4px 4px, 4px 4px, 100% 100%'
              }}
            >
              {/* Checkered Goal / Finish Line */}
              <div 
                className="absolute left-0 w-full h-[16px] border-b-4 border-black z-10 flex items-center justify-center pointer-events-none overflow-hidden"
                style={{
                  top: '16px',
                  backgroundColor: '#000',
                  backgroundImage: 'conic-gradient(#fff 0.25turn, #000 0.25turn 0.5turn, #fff 0.5turn 0.75turn, #000 0.75turn)',
                  backgroundSize: '8px 8px'
                }}
              >
                <span className="text-[5px] font-black text-yellow-300 bg-black/85 px-0.5 rounded leading-none whitespace-nowrap">GOAL</span>
              </div>

              {/* Start/Spawn Area base visual representation */}
              <div 
                className="absolute border-2 rounded-lg flex flex-col items-center justify-center pointer-events-none"
                style={{
                  left: '2.5px',
                  top: `${(245 - 10) * 4}px`,
                  width: '24px',
                  height: `${14 * 4}px`,
                  borderColor: b.color,
                  backgroundColor: `${b.color}10`
                }}
              >
                <span className="font-sans font-black text-[5px] uppercase tracking-tighter" style={{ color: b.color }}>SPAWN</span>
              </div>

              {/* Trail marks for this specific baby */}
              {b.trail && b.trail.map((coord: string, tIdx: number) => {
                const [tx, ty] = coord.split(',').map(Number);
                return (
                  <div 
                    key={`track-trail-${b.id}-${tIdx}`}
                    className="absolute opacity-50 animate-pulse"
                    style={{ 
                      left: `${tx * 4}px`, 
                      top: `${ty * 4}px`,
                      width: '4px',
                      height: '4px',
                      backgroundColor: b.color,
                      boxShadow: `0 0 6px ${b.color}`
                    }}
                  />
                );
              })}

              {/* Baby Figure Stroller */}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedBabyId(b.id);
                  addLog(`Switching control to Custom Baby: "${b.name}"`);
                }}
                className="absolute w-8 h-8 cursor-pointer z-20 flex items-center justify-center font-sans hover:scale-110 active:scale-95 transition-all select-none"
                style={{
                  left: `${b.x * 4 - 14}px`,
                  top: `${b.y * 4 - 14}px`,
                  transform: `rotate(${b.rot || -90}deg)`,
                  transition: 'left 0.1s linear, top 0.1s linear, transform 0.1s ease-out'
                }}
                title={`${b.name} (Click to select)`}
              >
                <div 
                  className="absolute inset-0 rounded-full border-2 animate-pulse opacity-85 pointer-events-none"
                  style={{ borderColor: b.color, boxShadow: `0 0 10px ${b.color}` }}
                />
                <img
                  src={`https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${encodeURIComponent(b.name)}`}
                  className="w-5 h-5 object-contain relative z-10 pointer-events-none"
                  referrerPolicy="no-referrer"
                  alt={b.name}
                />
                {/* Visual Label name tag */}
                <div 
                  className="absolute -top-4.5 left-1/2 -translate-x-1/2 px-1 py-0.2 text-[6px] font-black uppercase text-white border border-black rounded whitespace-nowrap shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] tracking-tighter"
                  style={{ backgroundColor: b.color }}
                >
                  👶 {b.name}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Championship Winner Celebration Modal */}
      {winner && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
          <motion.div 
            initial={{ scale: 0.9, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            className="max-w-md w-full bg-yellow-300 border-4 border-black p-8 rounded-3xl text-center shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden"
          >
            {/* Visual Confetti / Stars */}
            <div className="absolute top-2 left-4 text-3xl animate-bounce">✨</div>
            <div className="absolute top-6 right-8 text-3xl animate-pulse">👑</div>
            <div className="absolute bottom-4 left-8 text-2xl animate-pulse">🍼</div>
            <div className="absolute bottom-6 right-4 text-3xl animate-bounce">🎈</div>

            <div className="text-7xl mb-4">🏆</div>
            <h2 className="text-4xl font-black text-black uppercase tracking-tight leading-none mb-2">
              {winner === 'blue' ? 'BLUE TEAM WINS!' : 'RED TEAM WINS!'}
            </h2>
            <p className="text-[10px] text-black font-black uppercase tracking-widest font-mono mb-4 bg-black/15 py-1 px-2 rounded-lg inline-block">
              🏁 Championship Finish Crossed 🏁
            </p>
            
            <p className="text-black font-sans text-xs font-bold leading-relaxed mb-6">
              An epic stroller maneuver has successfully bypassed the barriers, mines, and rival wall blocks to reach the goal! <strong>+100 Championship Bonus Tokens</strong> have been credited as a victory gift. Let the next leg begin!
            </p>

            <button 
              onClick={async () => {
                setWinner(null);
                await handleReset();
              }}
              className="w-full py-4 bg-emerald-500 hover:bg-[#10b981] text-white font-black border-3 border-black rounded-xl hover:-translate-y-0.5 active:translate-y-0.5 transition-all uppercase text-xs tracking-wider shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] cursor-pointer"
            >
              Start Next Championship Leg &rarr;
            </button>
          </motion.div>
        </div>
      )}
    </div>
  );
}

