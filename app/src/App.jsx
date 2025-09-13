import React, { useEffect, useMemo, useRef, useState } from "react";
// Firebase (Modular SDK)
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, updateProfile } from "firebase/auth";
import { getFirestore, collection, addDoc, serverTimestamp, query, where, orderBy, limit, getDocs } from "firebase/firestore";

/* =========================================================
   Button Blitz — Timed Button Games (Firebase-integrated)
   - Modes: Classic 4-option quiz, Grid Hunt times-table grid
   - Firebase Auth (email/password)
   - Firestore per-user high scores (top 10 per mode)

   **IMPORTANT — Fix for “Component auth has not been registered yet”**
   This error happens when Firebase Auth is used without a valid
   initialized Firebase App/config. The code below now:
   - Validates the config before initializing Firebase
   - Skips Auth/DB completely when config is missing
   - Keeps the game fully playable without Firebase

   Setup steps (once):
     1) npm i firebase
     2) Firebase Console → Project → Add Web App → copy config → paste below.
     3) Console → Authentication → enable Email/Password.
     4) Console → Firestore → Create database.
   ========================================================= */

// --- PASTE YOUR FIREBASE CONFIG HERE ---
const firebaseConfig = {
  // apiKey: "YOUR_API_KEY",
  // authDomain: "YOUR_PROJECT.firebaseapp.com",
  // projectId: "YOUR_PROJECT_ID",
  // storageBucket: "YOUR_PROJECT.appspot.com",
  // messagingSenderId: "...",
  // appId: "..."
};

// Helper: verify config looks usable
function hasValidFirebaseConfig(cfg) {
  return cfg && typeof cfg.apiKey === "string" && cfg.apiKey.trim() !== "";
}

// Safe init (avoid errors when config is missing AND avoid double in hot reload)
let app = null;
let auth = null;
let db = null;
try {
  if (hasValidFirebaseConfig(firebaseConfig)) {
    app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } else {
    console.warn("Firebase config missing — Auth/DB disabled. The game will still run.");
  }
} catch (e) {
  console.error("Firebase initialization failed:", e);
  app = null; auth = null; db = null;
}

// --- Tunables ---
const DEFAULT_SESSION_SECONDS = 60; // total play time
const STARTING_Q_TIME = 3500; // ms allowed per question at level 1 (Classic)
const MIN_Q_TIME = 1200; // lower bound per-question timer at high levels (Classic)
const CORRECTS_PER_LEVEL = 5; // level-up cadence (Classic)

// Grid Hunt settings
const GRID_BASE_MIN = 2; // times-table base (e.g., 9-times table)
const GRID_BASE_MAX = 12;
const GRID_SIZE = 12; // 12 buttons (1×..12×)

// --- Utilities ---
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function useInterval(callback, delay) {
  const savedCallback = useRef(callback);
  useEffect(() => { savedCallback.current = callback; }, [callback]);
  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => savedCallback.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

function randInt(min, max) { // inclusive
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickUnique(arr, count, exclude) {
  const set = new Set([exclude]);
  const out = [];
  let guard = 0;
  while (out.length < count && guard < 500) {
    const v = arr[randInt(0, arr.length - 1)];
    if (!set.has(v)) { set.add(v); out.push(v); }
    guard++;
  }
  return out;
}

function formatMs(ms) {
  const s = Math.ceil(ms / 100) / 10; // 0.1s precision
  return `${s.toFixed(1)}s`;
}

// --- Classic mode question generator ---
function generateQuestion(level) {
  const range = 10 + level * 6; // grows with level
  const a = randInt(0, range);
  const b = randInt(0, range);

  const opRoll = level < 3 ? 0 : level < 6 ? randInt(0, 1) : randInt(0, 2);
  let prompt = ""; let answer = 0;
  if (opRoll === 0) { prompt = `${a} + ${b}`; answer = a + b; }
  else if (opRoll === 1) { const x = Math.max(a, b), y = Math.min(a, b); prompt = `${x} − ${y}`; answer = x - y; }
  else { const x = randInt(0, Math.min(12, Math.floor(range / 2))); const y = randInt(0, Math.min(12, Math.floor(range / 2))); prompt = `${x} × ${y}`; answer = x * y; }

  const pool = []; const spread = Math.max(3, Math.floor(level * 1.5));
  for (let d = -spread; d <= spread; d++) pool.push(answer + d);
  for (let i = 0; i < 6; i++) pool.push(answer + randInt(-range * 2, range * 2));
  const distractors = pickUnique(pool, 3, answer).map(n => clamp(n, -999, 999));
  const options = [answer, ...distractors].sort(() => Math.random() - 0.5);
  return { prompt, answer, options };
}

function getPerQuestionTime(level) {
  const ms = STARTING_Q_TIME - (level - 1) * 200; // tune pace
  return clamp(ms, MIN_Q_TIME, STARTING_Q_TIME);
}

// --- Firestore high scores (per-user, per-mode) ---
async function saveHighScoreToFirestore({ mode, score, accuracy, level, uid }) {
  if (!db || !uid) return; // silently ignore if not configured or not signed in
  try {
    await addDoc(collection(db, `users/${uid}/highscores`), {
      mode, score, accuracy, level, createdAt: serverTimestamp()
    });
  } catch (e) { console.error("saveHighScoreToFirestore", e); }
}

async function loadTopScores({ mode, uid }) {
  if (!db || !uid) return [];
  try {
    const q = query(
      collection(db, `users/${uid}/highscores`),
      where("mode", "==", mode),
      orderBy("score", "desc"),
      limit(10)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data());
  } catch (e) { console.error("loadTopScores", e); return []; }
}

// --- Grid Hunt helpers ---
function generateGridRound() {
  const base = randInt(GRID_BASE_MIN, GRID_BASE_MAX); // e.g., 9-times table
  const factor = randInt(1, GRID_SIZE); // 1..12
  const correct = base * factor;
  const grid = Array.from({ length: GRID_SIZE }, (_, i) => base * (i + 1));
  for (let i = grid.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [grid[i], grid[j]] = [grid[j], grid[i]]; }
  return { base, factor, product: correct, grid };
}

export default function ButtonBlitzSuite() {
  // screens: menu | playing | results
  // modes: classic | grid
  const [screen, setScreen] = useState("menu");
  const [mode, setMode] = useState("classic");

  const [totalSeconds, setTotalSeconds] = useState(DEFAULT_SESSION_SECONDS);
  const [remainingMs, setRemainingMs] = useState(DEFAULT_SESSION_SECONDS * 1000);

  // Shared stats
  const [level, setLevel] = useState(1);
  const [correct, setCorrect] = useState(0);
  const [missed, setMissed] = useState(0);
  const [streak, setStreak] = useState(0);

  // Classic round state
  const [q, setQ] = useState(() => generateQuestion(1));
  const [qDeadline, setQDeadline] = useState(Date.now() + getPerQuestionTime(1));

  // Grid Hunt round state
  const [gridRound, setGridRound] = useState(() => generateGridRound());

  const [paused, setPaused] = useState(false);

  // Auth state
  const [currentUser, setCurrentUser] = useState(null); // {uid, displayName, email}
  useEffect(() => {
    if (!auth) return; // Firebase not configured — skip
    return onAuthStateChanged(auth, (u) => {
      if (u) setCurrentUser({ uid: u.uid, displayName: u.displayName || u.email?.split('@')[0], email: u.email });
      else setCurrentUser(null);
    });
  }, []);

  // High scores (top 10 for current user + mode)
  const [highs, setHighs] = useState([]);
  useEffect(() => { (async () => {
    if (!currentUser) { setHighs([]); return; }
    const rows = await loadTopScores({ mode, uid: currentUser.uid });
    setHighs(rows);
  })(); }, [currentUser, mode, screen]);

  const accuracy = useMemo(() => {
    const attempts = correct + missed;
    return attempts === 0 ? 0 : Math.round((correct / attempts) * 100);
  }, [correct, missed]);

  // Session timer
  useInterval(() => {
    if (screen !== "playing" || paused) return;
    setRemainingMs((ms) => Math.max(0, ms - 100));
  }, 100);

  // Session end → save score
  useEffect(() => {
    if (screen === "playing" && remainingMs <= 0) {
      const entry = { score: correct, accuracy, level };
      if (currentUser) { saveHighScoreToFirestore({ mode, uid: currentUser.uid, ...entry }); }
      setScreen("results");
    }
  }, [remainingMs, screen, correct, accuracy, level, mode, currentUser]);

  // Per-question timeout (Classic only)
  useInterval(() => {
    if (screen !== "playing" || paused || mode !== "classic") return;
    const now = Date.now();
    if (now >= qDeadline) {
      setMissed((m) => m + 1);
      setStreak(0);
      const next = generateQuestion(level);
      setQ(next);
      setQDeadline(now + getPerQuestionTime(level));
    }
  }, 50);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      if (e.code === "Space") {
        e.preventDefault();
        if (screen === "menu") startGame(mode);
        else if (screen === "playing") setPaused((p) => !p);
        else if (screen === "results") restart();
        return;
      }
      if (screen !== "playing" || paused) return;
      if (mode === "classic") {
        const idx = ["Digit1", "Digit2", "Digit3", "Digit4", "Numpad1", "Numpad2", "Numpad3", "Numpad4"].indexOf(e.code);
        if (idx !== -1) { const mapped = idx % 4; handleClassicAnswer(q.options[mapped]); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, paused, q, mode]);

  function startGame(selectedMode) {
    setMode(selectedMode);
    setLevel(1); setCorrect(0); setMissed(0); setStreak(0);
    setRemainingMs(totalSeconds * 1000);
    setPaused(false);
    if (selectedMode === "classic") { const first = generateQuestion(1); setQ(first); setQDeadline(Date.now() + getPerQuestionTime(1)); }
    else { setGridRound(generateGridRound()); }
    setScreen("playing");
  }

  function restart() { setScreen("menu"); }

  // --- Classic handlers ---
  function nextClassicQuestion(newLevel) {
    const now = Date.now();
    const nxt = generateQuestion(newLevel);
    setQ(nxt);
    setQDeadline(now + getPerQuestionTime(newLevel));
  }

  function handleClassicAnswer(choice) {
    if (screen !== "playing" || paused) return;
    if (choice === q.answer) {
      setCorrect((c) => c + 1);
      setStreak((s) => s + 1);
      setLevel((lv) => {
        const totalCorrect = correct + 1; // optimistic
        const newLv = Math.floor(totalCorrect / CORRECTS_PER_LEVEL) + 1;
        const out = Math.max(lv, newLv);
        nextClassicQuestion(out);
        return out;
      });
    } else {
      setMissed((m) => m + 1);
      setStreak(0);
      nextClassicQuestion(level);
    }
  }

  // --- Grid Hunt handlers ---
  function handleGridAnswer(value) {
    if (screen !== "playing" || paused) return;
    if (value === gridRound.product) { setCorrect((c) => c + 1); setStreak((s) => s + 1); }
    else { setMissed((m) => m + 1); setStreak(0); }
    setGridRound(generateGridRound());
  }

  const qTimeLeft = Math.max(0, qDeadline - Date.now());
  const qTimePct = 100 * (qTimeLeft / getPerQuestionTime(level));

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight">Button Blitz</h1>
          <AuthBadge />
        </div>

        {/* Card */}
        <div className="bg-slate-800/60 backdrop-blur rounded-2xl shadow-xl ring-1 ring-white/10 p-4 sm:p-6">
          {screen === "menu" && (
            <MenuScreen
              totalSeconds={totalSeconds}
              setTotalSeconds={setTotalSeconds}
              onStartClassic={() => startGame("classic")}
              onStartGrid={() => startGame("grid")}
              highs={highs}
            />
          )}

          {screen === "playing" && (
            mode === "classic" ? (
              <ClassicPlayScreen
                level={level}
                correct={correct}
                missed={missed}
                streak={streak}
                remainingMs={remainingMs}
                totalMs={totalSeconds * 1000}
                paused={paused}
                setPaused={setPaused}
                q={q}
                qTimeLeft={qTimeLeft}
                qTimePct={qTimePct}
                onAnswer={handleClassicAnswer}
              />
            ) : (
              <GridPlayScreen
                round={gridRound}
                correct={correct}
                missed={missed}
                streak={streak}
                remainingMs={remainingMs}
                totalMs={totalSeconds * 1000}
                paused={paused}
                setPaused={setPaused}
                onAnswer={handleGridAnswer}
              />
            )
          )}

          {screen === "results" && (
            <ResultsScreen
              mode={mode}
              correct={correct}
              missed={missed}
              level={level}
              accuracy={accuracy}
              onRestart={restart}
              onPlayAgain={() => startGame(mode)}
              highs={highs}
            />
          )}
        </div>

        {/* Footer help */}
        <p className="mt-4 text-xs sm:text-sm text-slate-300/80">
          Tip: Press <kbd className="px-1.5 py-0.5 rounded bg-slate-700 border border-slate-600">Space</kbd> to
          {screen === "menu" ? " start" : screen === "playing" ? (paused ? " resume" : " pause") : " play again"}. In Classic mode,
          use keys <kbd className="ml-1 px-1.5 py-0.5 rounded bg-slate-700 border border-slate-600">1</kbd>–<kbd className="px-1.5 py-0.5 rounded bg-slate-700 border border-slate-600">4</kbd> for options.
        </p>
      </div>
    </div>
  );

  // --- nested: shows user or sign in/register ---
  function AuthBadge() {
    if (!auth) return <span className="text-xs sm:text-sm opacity-80">Sign in disabled — add Firebase config to enable</span>;
    if (!currentUser) return <AuthCard onAuthComplete={() => { /* handled by onAuthStateChanged */ }} />;
    return (
      <div className="flex items-center gap-2">
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-slate-400">Signed in</div>
          <div className="text-sm font-semibold">{currentUser.displayName}</div>
        </div>
        <button onClick={() => signOut(auth)} className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm">Sign out</button>
      </div>
    );
  }
}

function Stat({ label, value, sub }) {
  return (
    <div className="flex flex-col">
      <div className="text-2xl font-extrabold leading-none">{value}</div>
      <div className="text-xs uppercase tracking-wide text-slate-300">{label}</div>
      {sub ? <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div> : null}
    </div>
  );
}

function MenuScreen({ totalSeconds, setTotalSeconds, onStartClassic, onStartGrid, highs }) {
  const [t, setT] = useState(totalSeconds);
  useEffect(() => setT(totalSeconds), [totalSeconds]);

  return (
    <div>
      <p className="text-slate-200/90 mb-4">Pick a mode and beat the clock. {auth ? "Sign in (top-right) to save your scores to Firebase and see your top 10 below." : "Add Firebase config to enable sign-in and cloud scores."}</p>

      <div className="grid lg:grid-cols-3 gap-3 mb-4">
        <div className="col-span-2 bg-slate-900/60 rounded-xl p-4 ring-1 ring-white/10">
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">Session Settings</div>
          <label className="block text-sm mb-1">Total time (seconds)</label>
          <input type="range" min={30} max={180} step={10} value={t} onChange={(e) => setT(parseInt(e.target.value))} className="w-full" />
          <div className="flex items-center justify-between mt-2 text-sm">
            <div className="font-semibold">{t}s</div>
            <button onClick={() => setTotalSeconds(t)} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-[.98] transition font-semibold">Apply</button>
          </div>
        </div>

        <div className="bg-slate-900/60 rounded-xl p-4 ring-1 ring-white/10">
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">Your Top Scores</div>
          {(!highs || highs.length === 0) ? (
            <div className="text-sm text-slate-400">{auth ? "Sign in and play to record scores." : "Cloud scores require Firebase."}</div>
          ) : (
            <ol className="text-sm space-y-1">
              {highs.map((h, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span className="opacity-70">#{i + 1}</span>
                  <span className="font-semibold">{h.score} correct</span>
                  <span className="text-slate-400">{h.accuracy}% acc</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="p-4 rounded-xl ring-1 ring-white/10 bg-slate-900/60">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-bold">Classic Quiz</h3>
            <span className="text-[10px] uppercase text-slate-400">4 options • speeds up</span>
          </div>
          <p className="text-sm text-slate-300 mb-3">Quick arithmetic with 4 buttons. Beat shrinking per-question timers as you level up.</p>
          <button onClick={onStartClassic} className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-[.98] transition font-bold">Play Classic</button>
        </div>
        <div className="p-4 rounded-xl ring-1 ring-white/10 bg-slate-900/60">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-bold">Grid Hunt (Times Tables)</h3>
            <span className="text-[10px] uppercase text-slate-400">12-button grid</span>
          </div>
          <p className="text-sm text-slate-300 mb-3">Like your screenshot: shows <em>a × b</em> at the top and a grid of that table’s multiples. Tap the correct product fast.</p>
          <button onClick={onStartGrid} className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 active:scale-[.98] transition font-bold">Play Grid Hunt</button>
        </div>
      </div>
    </div>
  );
}

function ClassicPlayScreen({ level, correct, missed, streak, remainingMs, totalMs, paused, setPaused, q, qTimeLeft, qTimePct, onAnswer }) {
  const totalPct = Math.round((remainingMs / totalMs) * 100);
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-4">
          <Stat label="Mode" value="Classic" />
          <Stat label="Level" value={level} />
          <Stat label="Correct" value={correct} />
          <Stat label="Missed" value={missed} />
          <Stat label="Streak" value={streak} />
        </div>
        <div className="text-right">
          <div className="text-2xl font-extrabold leading-none tabular-nums">{Math.ceil(remainingMs / 1000)}s</div>
          <div className="text-xs uppercase tracking-wide text-slate-300">Time Left</div>
        </div>
      </div>

      <div className="h-2 w-full bg-slate-700 rounded-full overflow-hidden mb-4">
        <div className="h-full bg-indigo-500 transition-[width] duration-100" style={{ width: `${totalPct}%` }} />
      </div>

      <div className="bg-slate-900/60 rounded-xl ring-1 ring-white/10 p-6 mb-4">
        <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">Question</div>
        <div className="flex items-end justify-between gap-3">
          <div className="text-5xl sm:text-6xl font-black tabular-nums select-none">{q.prompt}</div>
          <div className="w-32">
            <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 transition-[width] duration-50" style={{ width: `${qTimePct}%` }} />
            </div>
            <div className="text-right text-[10px] text-slate-400 mt-1">{formatMs(qTimeLeft)} left</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {q.options.map((opt, i) => (
          <button key={i} onClick={() => onAnswer(opt)} className="relative group px-4 py-6 bg-slate-900/60 hover:bg-slate-800 active:scale-[.98] transition rounded-xl ring-1 ring-white/10 text-3xl font-extrabold tabular-nums" aria-label={`Option ${i + 1}: ${opt}`}>
            <div className="absolute top-1 left-1 text-[10px] text-slate-400">[{i + 1}]</div>
            {opt}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={() => setPaused(!paused)} className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 active:scale-[.98] transition font-semibold">{paused ? "Resume" : "Pause"}</button>
      </div>

      {paused && (
        <div className="mt-4 p-4 rounded-xl bg-slate-900/70 ring-1 ring-white/10">
          <div className="font-semibold mb-1">Paused</div>
          <div className="text-sm text-slate-300">Press Space or click Resume to continue.</div>
        </div>
      )}
    </div>
  );
}

function GridPlayScreen({ round, correct, missed, streak, remainingMs, totalMs, paused, setPaused, onAnswer }) {
  const totalPct = Math.round((remainingMs / totalMs) * 100);
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-4">
          <Stat label="Mode" value="Grid Hunt" />
          <Stat label="Correct" value={correct} />
          <Stat label="Missed" value={missed} />
          <Stat label="Streak" value={streak} />
        </div>
        <div className="text-right">
          <div className="text-2xl font-extrabold leading-none tabular-nums">{Math.ceil(remainingMs / 1000)}s</div>
          <div className="text-xs uppercase tracking-wide text-slate-300">Time Left</div>
        </div>
      </div>

      <div className="h-2 w-full bg-slate-700 rounded-full overflow-hidden mb-4">
        <div className="h-full bg-indigo-500 transition-[width] duration-100" style={{ width: `${totalPct}%` }} />
      </div>

      <div className="bg-slate-900/60 rounded-xl ring-1 ring-white/10 p-6 mb-4">
        <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">Find the product</div>
        <div className="text-5xl sm:text-6xl font-black tabular-nums select-none text-center">{round.base} × {round.factor}</div>
      </div>

      <div className="grid grid-cols-4 sm:grid-cols-6 gap-3">
        {round.grid.map((v, i) => (
          <button key={i} onClick={() => onAnswer(v)} className="px-4 py-5 bg-slate-900/60 hover:bg-slate-800 active:scale-[.98] transition rounded-xl ring-1 ring-white/10 text-2xl font-extrabold tabular-nums">
            {v}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={() => setPaused(!paused)} className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 active:scale-[.98] transition font-semibold">{paused ? "Resume" : "Pause"}</button>
      </div>

      {paused && (
        <div className="mt-4 p-4 rounded-xl bg-slate-900/70 ring-1 ring-white/10">
          <div className="font-semibold mb-1">Paused</div>
          <div className="text-sm text-slate-300">Press Space or click Resume to continue.</div>
        </div>
      )}
    </div>
  );
}

function ResultsScreen({ mode, correct, missed, level, accuracy, highs, onRestart, onPlayAgain }) {
  const attempts = correct + missed;
  return (
    <div>
      <div className="grid sm:grid-cols-4 gap-3 mb-4">
        <div className="col-span-2 sm:col-span-1 bg-slate-900/60 rounded-xl p-4 ring-1 ring-white/10">
          <Stat label="Mode" value={mode === "classic" ? "Classic" : "Grid Hunt"} />
        </div>
        <div className="col-span-2 sm:col-span-1 bg-slate-900/60 rounded-xl p-4 ring-1 ring-white/10">
          <Stat label="Correct" value={correct} />
        </div>
        <div className="col-span-2 sm:col-span-1 bg-slate-900/60 rounded-xl p-4 ring-1 ring-white/10">
          <Stat label="Missed" value={missed} />
        </div>
        <div className="col-span-2 sm:col-span-1 bg-slate-900/60 rounded-xl p-4 ring-1 ring-white/10">
          <Stat label="Accuracy" value={`${accuracy}%`} sub={`${correct}/${attempts}`} />
        </div>
      </div>

      <div className="bg-slate-900/60 rounded-xl p-4 ring-1 ring-white/10 mb-4">
        <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">Top Scores (your account)</div>
        {!highs || highs.length === 0 ? (
          <div className="text-sm text-slate-400">Sign in and play to record scores.</div>
        ) : (
          <ol className="text-sm space-y-1">
            {highs.map((h, i) => (
              <li key={i} className="flex items-center justify-between">
                <span className="opacity-70">#{i + 1}</span>
                <span className="font-semibold">{h.score} correct</span>
                <span className="text-slate-400">{h.accuracy}% acc</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="flex gap-3">
        <button onClick={onPlayAgain} className="px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-[.98] transition font-bold">Play Again</button>
        <button onClick={onRestart} className="px-4 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 active:scale-[.98] transition font-semibold">Back to Menu</button>
      </div>
    </div>
  );
}

function AuthCard({ onAuthComplete }) {
  const [tab, setTab] = useState('signin'); // signin | register
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const enabled = !!auth;

  async function handleRegister(e) {
    e.preventDefault(); if (!enabled) return;
    setMsg(''); setBusy(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (name) { await updateProfile(cred.user, { displayName: name }); }
      setMsg('Account created! You are signed in.');
      onAuthComplete?.();
      setTab('signin');
    } catch (e) {
      setMsg(e.message || 'Could not register.');
    } finally { setBusy(false); }
  }

  async function handleSignin(e) {
    e.preventDefault(); if (!enabled) return;
    setMsg(''); setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      setMsg('Signed in!');
      onAuthComplete?.();
    } catch (e) {
      setMsg(e.message || 'Could not sign in.');
    } finally { setBusy(false); }
  }

  if (!enabled) {
    return <div className="text-xs text-amber-300">Add your Firebase config (at the top of the file) and run <code>npm i firebase</code> to enable sign-in.</div>;
  }

  return (
    <div className="mb-4 p-4 rounded-xl ring-1 ring-white/10 bg-slate-900/60">
      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => setTab('signin')} className={`px-3 py-1.5 rounded-lg text-sm ${tab==='signin'?'bg-slate-700':'bg-slate-800 hover:bg-slate-700'}`}>Sign in</button>
        <button onClick={() => setTab('register')} className={`px-3 py-1.5 rounded-lg text-sm ${tab==='register'?'bg-slate-700':'bg-slate-800 hover:bg-slate-700'}`}>Register</button>
      </div>
      {tab === 'signin' ? (
        <form onSubmit={handleSignin} className="grid sm:grid-cols-3 gap-2">
          <input required type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} className="sm:col-span-1 px-3 py-2 rounded-lg bg-slate-800 ring-1 ring-white/10" />
          <input required type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} className="sm:col-span-1 px-3 py-2 rounded-lg bg-slate-800 ring-1 ring-white/10" />
          <button disabled={busy} className="sm:col-span-1 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 font-semibold">{busy? 'Working…' : 'Sign in'}</button>
        </form>
      ) : (
        <form onSubmit={handleRegister} className="grid sm:grid-cols-4 gap-2">
          <input type="text" placeholder="Name (optional)" value={name} onChange={e=>setName(e.target.value)} className="sm:col-span-1 px-3 py-2 rounded-lg bg-slate-800 ring-1 ring-white/10" />
          <input required type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} className="sm:col-span-1 px-3 py-2 rounded-lg bg-slate-800 ring-1 ring-white/10" />
          <input required type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} className="sm:col-span-1 px-3 py-2 rounded-lg bg-slate-800 ring-1 ring-white/10" />
          <button disabled={busy} className="sm:col-span-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-semibold">{busy? 'Working…' : 'Create account'}</button>
        </form>
      )}
      {msg && <div className="mt-2 text-xs text-slate-300">{msg}</div>}
      <div className="mt-2 text-[10px] text-slate-400">We use Firebase Authentication and Firestore. Scores are saved to your account (per device when offline, synced when online).</div>
    </div>
  );
}
