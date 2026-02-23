// app.js – LateNight-style UI. Engine unchanged (roundrobin.js).

const $ = (id) => document.getElementById(id);

let state = null;
let players = [];
let scores = {};
let currentRoundResult = null; // last res from generateRound for round # and bench
let currentRoundDecisions = {}; // { matchIdx: { winnerIds, loserIds } } for undo

const STORAGE_KEYS = {
  players: "rr_players",
  scores: "rr_scores",
  state: "rr_state",
  settings: "rr_settings",
};

function uid(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

function ensureScore(pid) {
  if (!scores[pid]) scores[pid] = { wins: 0, losses: 0, games: 0 };
}

// ——— Persistence ———
function loadState() {
  try {
    const p = localStorage.getItem(STORAGE_KEYS.players);
    if (p) players = JSON.parse(p);
  } catch (_) {}
  try {
    const s = localStorage.getItem(STORAGE_KEYS.scores);
    if (s) scores = JSON.parse(s);
  } catch (_) {}
  try {
    const st = localStorage.getItem(STORAGE_KEYS.state);
    if (st) state = JSON.parse(st);
  } catch (_) {}
  try {
    const set = localStorage.getItem(STORAGE_KEYS.settings);
    if (set) {
      const o = JSON.parse(set);
      const minEl = $("minutes");
      const courtEl = $("courts");
      const countdownEl = $("startCountdown");
      if (minEl && o.minutes != null) minEl.value = o.minutes;
      if (courtEl && o.courts != null) courtEl.value = o.courts;
      if (countdownEl && o.startCountdown != null) countdownEl.value = o.startCountdown;
    }
  } catch (_) {}
}

function savePlayers() {
  try {
    localStorage.setItem(STORAGE_KEYS.players, JSON.stringify(players));
  } catch (_) {}
}

function saveScores() {
  try {
    localStorage.setItem(STORAGE_KEYS.scores, JSON.stringify(scores));
  } catch (_) {}
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEYS.state, state ? JSON.stringify(state) : "");
  } catch (_) {}
}

function saveSettings() {
  try {
    const minEl = $("minutes");
    const courtEl = $("courts");
    const countdownEl = $("startCountdown");
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        minutes: minEl ? Number(minEl.value) || 11 : 11,
        courts: courtEl ? Number(courtEl.value) || 6 : 6,
        startCountdown: countdownEl ? Number(countdownEl.value) || 30 : 30,
      })
    );
  } catch (_) {}
}

// ——— Settings collapsible ———
function initSettingsToggle() {
  const toggle = $("settingsToggle");
  const panel = $("settingsPanel");
  if (!toggle || !panel) return;

  const key = "rr_settings_collapsed";
  const collapsed = localStorage.getItem(key) !== "false";
  panel.classList.toggle("open", !collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));

  toggle.addEventListener("click", () => {
    const open = panel.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
    localStorage.setItem(key, String(!open));
  });
}

// ——— Round header ———
function updateRoundHeader(roundNum) {
  const text = roundNum != null ? `Round ${roundNum}` : "—";
  const h = $("roundHeader");
  const h2 = $("roundHeaderCourts");
  if (h) h.textContent = text;
  if (h2) h2.textContent = text;
}

// ——— Players ———
function renderPlayers() {
  const box = $("playersList");
  if (!box) return;
  if (players.length === 0) {
    box.innerHTML = `<div class="players-empty">No players yet.</div>`;
    return;
  }

  box.innerHTML = players
    .map(
      (p, idx) => `
    <div class="player-row" data-idx="${idx}">
      <div class="player-info">
        <span class="player-name">${escapeHtml(p.name)}</span>
        <span class="player-badges">
          <span class="player-badge ${p.isActive ? "active" : ""}">${p.isActive ? "active" : "inactive"}</span>
        </span>
      </div>
      <div class="player-actions">
        <button class="btn btn-secondary" data-t="toggle" data-i="${idx}">${p.isActive ? "Drop" : "Add back"}</button>
        <button class="btn btn-secondary" data-t="remove" data-i="${idx}">Remove</button>
      </div>
    </div>
  `
    )
    .join("");

  box.querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.i);
      const t = btn.dataset.t;
      if (t === "toggle") players[idx].isActive = !players[idx].isActive;
      if (t === "remove") players.splice(idx, 1);
      savePlayers();
      renderPlayers();
      renderLeaderboard();
    };
  });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ——— Leaderboard with bye counts ———
function renderLeaderboard() {
  const container = $("leaderboard");
  if (!container) return;

  const rows = Object.entries(scores).map(([pid, s]) => {
    const name = (players.find((p) => p.id === pid) || {}).name || pid;
    const pct = s.games ? s.wins / s.games : 0;
    const byes = (state && state.byeCounts && state.byeCounts[pid]) ?? 0;
    return { pid, name, ...s, pct, byes };
  });

  rows.sort(
    (a, b) =>
      b.wins - a.wins ||
      b.pct - a.pct ||
      (b.games - a.games) ||
      a.name.localeCompare(b.name)
  );

  if (rows.length === 0) {
    container.innerHTML = `<div class="leaderboard-empty">No results yet.</div>`;
    return;
  }

  container.innerHTML = rows
    .map(
      (r, i) => {
        const rankClass = i < 3 ? `rank-${i + 1}` : "";
        return `
    <div class="leaderboard-row ${rankClass}" data-pid="${escapeHtml(r.pid)}">
      <span class="leaderboard-rank">${i + 1}</span>
      <span class="leaderboard-name">${escapeHtml(r.name)}</span>
      <span class="leaderboard-stats">${r.wins}-${r.losses}</span>
      <span class="leaderboard-stats">${r.games} G</span>
      <span class="leaderboard-byes">Byes: ${r.byes}</span>
    </div>
  `;
    })
    .join("");
}

// ——— Bench (pill chips) ———
function renderByes() {
  const el = $("byes");
  if (!el) return;
  const byes = currentRoundResult ? currentRoundResult.byePlayers || [] : [];
  if (byes.length === 0) {
    el.innerHTML = `<span class="bench-empty">No byes this round.</span>`;
    return;
  }
  el.innerHTML = byes
    .map((p) => `<span class="bench-pill">${escapeHtml(p.name)}</span>`)
    .join("");
}

// ——— Court cards: win/lose/lock + undo ———
function renderRound(res) {
  currentRoundResult = res;
  currentRoundDecisions = {};

  updateRoundHeader(res.round);
  renderByes();

  const diagnosticsEl = $("diagnostics");
  if (diagnosticsEl) {
    diagnosticsEl.textContent =
      `Repeat partners: ${res.diagnostics.repeatPartnershipsUsed} • ` +
      `Repeat matchups: ${res.diagnostics.repeatMatchupsUsed}`;
  }

  const matchesEl = $("matches");
  if (!matchesEl) return;

  matchesEl.innerHTML = res.assignments
    .map((m, idx) => {
      const decided = currentRoundDecisions[idx];
      const locked = !!decided;
      const win1 = decided && decided.winner === 1;
      const win2 = decided && decided.winner === 2;
      return `
        <div class="court-card ${locked ? "locked" : ""}" data-idx="${idx}">
          <div class="court-label">Court ${m.court}</div>
          <div class="court-teams">
            <div class="court-team">${escapeHtml(m.team1)}</div>
            <div class="court-vs">VS</div>
            <div class="court-team">${escapeHtml(m.team2)}</div>
          </div>
          <div class="court-actions">
            <button type="button" class="court-btn-win ${win1 ? "win" : ""} ${win2 ? "lose" : ""}" data-win="1" ${locked ? "disabled" : ""}>Team 1 Won</button>
            <button type="button" class="court-btn-win ${win2 ? "win" : ""} ${win1 ? "lose" : ""}" data-win="2" ${locked ? "disabled" : ""}>Team 2 Won</button>
          </div>
          <div class="court-recorded">Result recorded</div>
          <button type="button" class="court-undo" data-idx="${idx}">Undo</button>
        </div>
      `;
    })
    .join("");

  matchesEl.querySelectorAll(".court-btn-win").forEach((btn) => {
    if (btn.disabled) return;
    btn.onclick = () => recordWinner(Number(btn.closest(".court-card").dataset.idx), Number(btn.dataset.win));
  });

  matchesEl.querySelectorAll(".court-undo").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      undoCourt(Number(btn.dataset.idx));
    };
  });
}

function recordWinner(matchIdx, win) {
  if (!currentRoundResult || currentRoundDecisions[matchIdx]) return;
  const match = currentRoundResult.assignments[matchIdx];
  const winnerIds = win === 1 ? match.team1Ids : match.team2Ids;
  const loserIds = win === 1 ? match.team2Ids : match.team1Ids;

  winnerIds.forEach((pid) => {
    ensureScore(pid);
    scores[pid].wins += 1;
    scores[pid].games += 1;
  });
  loserIds.forEach((pid) => {
    ensureScore(pid);
    scores[pid].losses += 1;
    scores[pid].games += 1;
  });

  currentRoundDecisions[matchIdx] = { winner: win, winnerIds, loserIds };
  saveScores();

  // Update single card to locked state
  const card = $("matches").querySelector(`.court-card[data-idx="${matchIdx}"]`);
  if (card) {
    card.classList.add("locked");
    const btn1 = card.querySelector('.court-btn-win[data-win="1"]');
    const btn2 = card.querySelector('.court-btn-win[data-win="2"]');
    if (btn1) {
      btn1.disabled = true;
      btn1.classList.toggle("win", win === 1);
      btn1.classList.toggle("lose", win === 2);
    }
    if (btn2) {
      btn2.disabled = true;
      btn2.classList.toggle("win", win === 2);
      btn2.classList.toggle("lose", win === 1);
    }
  }
  renderLeaderboard();
}

function undoCourt(matchIdx) {
  const decision = currentRoundDecisions[matchIdx];
  if (!decision) return;
  const { winnerIds, loserIds } = decision;

  winnerIds.forEach((pid) => {
    if (scores[pid]) {
      scores[pid].wins = Math.max(0, scores[pid].wins - 1);
      scores[pid].games = Math.max(0, scores[pid].games - 1);
    }
  });
  loserIds.forEach((pid) => {
    if (scores[pid]) {
      scores[pid].losses = Math.max(0, scores[pid].losses - 1);
      scores[pid].games = Math.max(0, scores[pid].games - 1);
    }
  });

  delete currentRoundDecisions[matchIdx];
  saveScores();

  const card = $("matches").querySelector(`.court-card[data-idx="${matchIdx}"]`);
  if (card) {
    card.classList.remove("locked");
    const btn1 = card.querySelector('.court-btn-win[data-win="1"]');
    const btn2 = card.querySelector('.court-btn-win[data-win="2"]');
    if (btn1) {
      btn1.disabled = false;
      btn1.classList.remove("win", "lose");
    }
    if (btn2) {
      btn2.disabled = false;
      btn2.classList.remove("win", "lose");
    }
  }
  renderLeaderboard();
}

// ——— Timer state machine ———
// timerMode: "idle" | "countdown" | "running" | "paused" | "stopped"
let timerMode = "idle";
let countdownSecondsRemaining = 0;
let roundSecondsRemaining = 11 * 60;
let countdownInterval = null;
let roundInterval = null;

const DANGER_THRESHOLD_SEC = 90;

function getRoundMinutes() {
  const minEl = $("minutes");
  return minEl ? Number(minEl.value) || 11 : 11;
}

function getStartCountdown() {
  const el = $("startCountdown");
  return el ? Math.max(0, Number(el.value) || 30) : 30;
}

function clearCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  countdownSecondsRemaining = 0;
  const countdownEl = $("countdownDisplay");
  if (countdownEl) countdownEl.textContent = "";
}

function clearRoundTimer() {
  if (roundInterval) {
    clearInterval(roundInterval);
    roundInterval = null;
  }
}

function setTimerMode(mode) {
  timerMode = mode;
  updateTimerDisplay();
  updateTimerButtonStates();
  updateTimerStatus();
}

function updateTimerStatus() {
  const el = $("timerStatus");
  if (!el) return;
  if (timerMode === "stopped") {
    el.textContent = "Round ended early";
  } else {
    el.textContent = "";
  }
}

function updateTimerDisplay() {
  const timerEl = $("timer");
  const countdownEl = $("countdownDisplay");
  if (!timerEl) return;

  timerEl.classList.remove("running", "danger");
  if (timerMode === "countdown") {
    if (countdownEl) countdownEl.textContent = `Starting in ${countdownSecondsRemaining}…`;
    const m = Math.floor(roundSecondsRemaining / 60);
    const s = roundSecondsRemaining % 60;
    timerEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return;
  }
  if (countdownEl) countdownEl.textContent = "";

  const m = Math.floor(roundSecondsRemaining / 60);
  const s = roundSecondsRemaining % 60;
  timerEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

  if (timerMode === "running") {
    timerEl.classList.add("running");
    if (roundSecondsRemaining <= DANGER_THRESHOLD_SEC) {
      timerEl.classList.add("danger");
    }
  }
}

function updateTimerButtonStates() {
  const startBtn = $("timerStart");
  const pauseBtn = $("timerPause");
  const stopBtn = $("timerStop");
  const resetBtn = $("timerReset");
  if (startBtn) startBtn.disabled = !(timerMode === "idle" || timerMode === "paused" || timerMode === "stopped" || timerMode === "countdown");
  if (pauseBtn) pauseBtn.disabled = timerMode !== "running";
  if (stopBtn) stopBtn.disabled = !(timerMode === "running" || timerMode === "countdown");
  if (resetBtn) resetBtn.disabled = false;
}

function renderTimer() {
  updateTimerDisplay();
}

function startCountdownPhase() {
  clearRoundTimer();
  countdownSecondsRemaining = getStartCountdown();
  if (countdownSecondsRemaining <= 0) {
    startRoundTimer();
    return;
  }
  setTimerMode("countdown");
  countdownInterval = setInterval(() => {
    countdownSecondsRemaining--;
    updateTimerDisplay();
    if (countdownSecondsRemaining <= 0) {
      clearCountdown();
      startRoundTimer();
    }
  }, 1000);
}

function startRoundTimer() {
  clearCountdown();
  clearRoundTimer();
  setTimerMode("running");
  roundInterval = setInterval(() => {
    roundSecondsRemaining = Math.max(0, roundSecondsRemaining - 1);
    updateTimerDisplay();
    if (roundSecondsRemaining <= 0) {
      clearRoundTimer();
      setTimerMode("stopped");
      updateTimerStatus();
    }
  }, 1000);
}

function timerStart() {
  if (timerMode === "countdown") {
    clearCountdown();
    startRoundTimer();
    return;
  }
  if (timerMode === "idle" || timerMode === "paused" || timerMode === "stopped") {
    startRoundTimer();
  }
}

function timerPause() {
  if (timerMode !== "running") return;
  clearRoundTimer();
  setTimerMode("paused");
}

function timerStop() {
  if (timerMode !== "running" && timerMode !== "countdown") return;
  clearCountdown();
  clearRoundTimer();
  setTimerMode("stopped");
  updateTimerStatus();
}

function timerReset() {
  clearCountdown();
  clearRoundTimer();
  roundSecondsRemaining = getRoundMinutes() * 60;
  setTimerMode("idle");
  updateTimerStatus();
  saveSettings();
}

// ——— Events ———
function doAddPlayer() {
  const name = $("playerName").value.trim();
  if (!name) return;
  const id = uid(name);
  if (players.some((p) => p.id === id)) {
    $("playerName").value = "";
    return;
  }
  players.push({ id, name, isActive: true });
  ensureScore(id);
  $("playerName").value = "";
  savePlayers();
  saveScores();
  renderPlayers();
  renderLeaderboard();
  const input = $("playerName");
  if (input) input.focus();
}

$("addPlayer").onclick = doAddPlayer;

const playerNameInput = $("playerName");
if (playerNameInput) {
  playerNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doAddPlayer();
    }
  });
}

$("startRound").onclick = () => {
  const active = players.filter((p) => p.isActive);
  const courtsEl = $("courts");
  const courts = courtsEl ? Number(courtsEl.value) || 6 : 6;

  if (active.length < 4) {
    alert("Need at least 4 active players.");
    return;
  }

  const res = ROUNDROBIN.generateRound(active, courts, state, { maxRetries: 900 });

  if (res.impossible) {
    alert("Could not generate round: " + (res.reason || "unknown"));
    return;
  }

  state = res.state;
  saveState();
  saveSettings();
  renderRound(res);

  roundSecondsRemaining = getRoundMinutes() * 60;
  startCountdownPhase();
};

$("reset").onclick = () => {
  if (!confirm("Reset event state (histories + scores)?")) return;
  state = null;
  scores = {};
  currentRoundResult = null;
  currentRoundDecisions = {};
  players.forEach((p) => ensureScore(p.id));
  try {
    localStorage.removeItem(STORAGE_KEYS.state);
    localStorage.setItem(STORAGE_KEYS.scores, JSON.stringify(scores));
  } catch (_) {}
  const matchesEl = $("matches");
  if (matchesEl) matchesEl.innerHTML = "";
  renderByes();
  updateRoundHeader(null);
  const diag = $("diagnostics");
  if (diag) diag.textContent = "";
  renderLeaderboard();
  timerReset();
};

$("timerStart").onclick = timerStart;
$("timerPause").onclick = timerPause;
$("timerStop").onclick = timerStop;
$("timerReset").onclick = () => {
  timerReset();
};

// Persist settings when inputs change
const minEl = $("minutes");
const courtEl = $("courts");
const startCountdownEl = $("startCountdown");
if (minEl) minEl.addEventListener("change", saveSettings);
if (courtEl) courtEl.addEventListener("change", saveSettings);
if (startCountdownEl) startCountdownEl.addEventListener("change", saveSettings);

// ——— Init ———
loadState();
initSettingsToggle();
roundSecondsRemaining = getRoundMinutes() * 60;
setTimerMode("idle");
renderPlayers();
renderLeaderboard();
renderByes();
updateRoundHeader(currentRoundResult ? currentRoundResult.round : null);
