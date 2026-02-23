// app.js – LateNight-style UI. Engine unchanged (roundrobin.js).

const $ = (id) => document.getElementById(id);

let state = null;
let players = [];
let scores = {};
let currentRoundResult = null; // last res from generateRound for round # and bench
let currentRoundDecisions = {}; // { matchIdx: { winnerIds, loserIds } } for undo
let stateBeforeCurrentRound = null; // state snapshot before last generateRound (for scrub)
let roundTimerWasStarted = false;   // true once countdown or round timer has run (blocks Generate until winners in)
let headToHead = {};                // headToHead[pid][opponentPid] = times pid's team beat opponent's when they faced

const STORAGE_KEYS = {
  players: "rr_players",
  scores: "rr_scores",
  state: "rr_state",
  settings: "rr_settings",
  headToHead: "rr_headToHead",
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
    if (p) {
      players = JSON.parse(p);
      players.forEach((p) => { if (p.onBench === undefined) p.onBench = false; });
    }
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
    const h = localStorage.getItem(STORAGE_KEYS.headToHead);
    if (h) headToHead = JSON.parse(h);
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

function saveHeadToHead() {
  try {
    localStorage.setItem(STORAGE_KEYS.headToHead, JSON.stringify(headToHead));
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
      (p, idx) => {
        const benchBtn = p.isActive && !p.onBench ? "Bench" : p.onBench ? "Back in" : null;
        return `
    <div class="player-row" data-idx="${idx}">
      <div class="player-info">
        <span class="player-name">${escapeHtml(p.name)}</span>
        <span class="player-badges">
          <span class="player-badge ${p.isActive ? "active" : ""}">${p.isActive ? (p.onBench ? "on bench" : "active") : "inactive"}</span>
        </span>
      </div>
      <div class="player-actions">
        ${benchBtn ? `<button class="btn btn-secondary" data-t="bench" data-i="${idx}">${benchBtn}</button>` : ""}
        <button class="btn btn-secondary" data-t="toggle" data-i="${idx}">${p.isActive ? "Drop" : "Add back"}</button>
        <button class="btn btn-secondary" data-t="remove" data-i="${idx}">Remove</button>
      </div>
    </div>
  `;
      }
    )
    .join("");

  box.querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.i);
      const t = btn.dataset.t;
      if (t === "toggle") {
        players[idx].isActive = !players[idx].isActive;
        if (!players[idx].isActive) players[idx].onBench = false;
      }
      if (t === "bench") {
        players[idx].onBench = !players[idx].onBench;
        if (players[idx].onBench && currentRoundResult) {
          const inRound = getPlayerIdsInCurrentRound().has(players[idx].id);
          if (inRound) {
            const hasResults = Object.keys(currentRoundDecisions).length > 0;
            if (hasResults) {
              alert("This player is in the current round and results have already been recorded. Can't scrub this round.");
            } else {
              alert("That player is in the current round. The round will be scrubbed (not counted) so you can generate a new round with them on the bench.");
              scrubCurrentRound();
            }
          }
        }
      }
      if (t === "remove") players.splice(idx, 1);
      savePlayers();
      renderPlayers();
      renderByes();
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

// ——— Current round scrub (bench a player who is in the round) ———
function getPlayerIdsInCurrentRound() {
  if (!currentRoundResult) return new Set();
  const ids = new Set();
  (currentRoundResult.assignments || []).forEach((a) => {
    (a.team1Ids || []).forEach((id) => ids.add(id));
    (a.team2Ids || []).forEach((id) => ids.add(id));
  });
  (currentRoundResult.byePlayers || []).forEach((p) => ids.add(p.id));
  return ids;
}

function scrubCurrentRound() {
  state = stateBeforeCurrentRound;
  currentRoundResult = null;
  currentRoundDecisions = {};
  roundTimerWasStarted = false;
  const matchesEl = $("matches");
  if (matchesEl) matchesEl.innerHTML = "";
  renderByes();
  updateRoundHeader(state && state.round != null ? state.round : null);
  const diag = $("diagnostics");
  if (diag) diag.textContent = "";
  saveState();
  updateGenerateRoundButton();
}

// ——— Bench (pill chips) + Sitting out ———
function renderByes() {
  const el = $("byes");
  if (!el) return;
  const byes = currentRoundResult ? currentRoundResult.byePlayers || [] : [];
  if (byes.length === 0) {
    el.innerHTML = `<span class="bench-empty">No byes this round.</span>`;
  } else {
    el.innerHTML = byes
      .map((p) => `<span class="bench-pill">${escapeHtml(p.name)}</span>`)
      .join("");
  }

  const sittingEl = $("sittingOut");
  if (!sittingEl) return;
  const sitting = players.filter((p) => p.isActive && p.onBench);
  if (sitting.length === 0) {
    sittingEl.innerHTML = "";
    sittingEl.classList.remove("has-content");
  } else {
    sittingEl.classList.add("has-content");
    sittingEl.innerHTML =
      `<span class="bench-sitting-label">Sitting out:</span> ` +
      sitting.map((p) => `<span class="bench-pill bench-pill-sitting">${escapeHtml(p.name)}</span>`).join("");
  }
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
      const winnerText = decided ? (decided.winner === 1 ? m.team1 : m.team2) : "";
      return `
        <div class="court-card ${locked ? "locked" : ""}" data-idx="${idx}">
          <div class="court-label">Court ${m.court}</div>
          <div class="court-teams">
            <div class="court-team">${escapeHtml(m.team1)}</div>
            <div class="court-vs">VS</div>
            <div class="court-team">${escapeHtml(m.team2)}</div>
          </div>
          <div class="court-actions">
            <button type="button" class="court-btn-win ${win1 ? "win" : ""} ${win2 ? "lose" : ""}" data-win="1" ${locked ? "disabled" : ""}>${escapeHtml(m.team1)}</button>
            <button type="button" class="court-btn-win ${win2 ? "win" : ""} ${win1 ? "lose" : ""}" data-win="2" ${locked ? "disabled" : ""}>${escapeHtml(m.team2)}</button>
          </div>
          <div class="court-recorded">${winnerText ? escapeHtml(winnerText) + " won" : ""}</div>
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
  updateGenerateRoundButton();
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

  winnerIds.forEach((w) => {
    loserIds.forEach((l) => {
      if (!headToHead[w]) headToHead[w] = {};
      headToHead[w][l] = (headToHead[w][l] || 0) + 1;
    });
  });
  saveHeadToHead();

  // Update single card to locked state
  const card = $("matches").querySelector(`.court-card[data-idx="${matchIdx}"]`);
  if (card) {
    card.classList.add("locked");
    const recordedEl = card.querySelector(".court-recorded");
    if (recordedEl) recordedEl.textContent = (win === 1 ? match.team1 : match.team2) + " won";
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
  updateGenerateRoundButton();
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

  winnerIds.forEach((w) => {
    loserIds.forEach((l) => {
      if (headToHead[w] && headToHead[w][l]) {
        headToHead[w][l] = Math.max(0, headToHead[w][l] - 1);
      }
    });
  });
  saveHeadToHead();

  const card = $("matches").querySelector(`.court-card[data-idx="${matchIdx}"]`);
  if (card) {
    card.classList.remove("locked");
    const recordedEl = card.querySelector(".court-recorded");
    if (recordedEl) recordedEl.textContent = "";
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
  updateGenerateRoundButton();
}

// ——— End event: winner + tie-breaker (head-to-head) ———
function getHeadToHead(a, b) {
  const ab = (headToHead[a] && headToHead[a][b]) || 0;
  const ba = (headToHead[b] && headToHead[b][a]) || 0;
  return { aVsB: ab, bVsA: ba };
}

function getWinnerWithTieBreaker() {
  const rows = Object.entries(scores).map(([pid, s]) => {
    const name = (players.find((p) => p.id === pid) || {}).name || pid;
    const pct = s.games ? s.wins / s.games : 0;
    return { pid, name, ...s, pct };
  });
  if (rows.length === 0) return { winnerName: null, rationale: null };
  rows.sort(
    (a, b) =>
      b.wins - a.wins ||
      b.pct - a.pct ||
      (b.games - a.games) ||
      a.name.localeCompare(b.name)
  );
  const maxWins = rows[0].wins;
  const tied = rows.filter((r) => r.wins === maxWins);
  if (tied.length === 1) {
    return { winnerName: tied[0].name, rationale: null };
  }
  tied.sort((a, b) => {
    const scoreA = tied
      .filter((t) => t.pid !== a.pid)
      .reduce((sum, t) => sum + ((headToHead[a.pid] && headToHead[a.pid][t.pid]) || 0), 0);
    const scoreB = tied
      .filter((t) => t.pid !== b.pid)
      .reduce((sum, t) => sum + ((headToHead[b.pid] && headToHead[b.pid][t.pid]) || 0), 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.name.localeCompare(b.name);
  });
  const winnerName = tied[0].name;
  const rationaleParts = [];
  for (let i = 0; i < tied.length; i++) {
    for (let j = i + 1; j < tied.length; j++) {
      const hab = getHeadToHead(tied[i].pid, tied[j].pid);
      if (hab.aVsB > 0 || hab.bVsA > 0) {
        rationaleParts.push(
          `${tied[i].name} beat ${tied[j].name} ${hab.aVsB}–${hab.bVsA}`
        );
      }
    }
  }
  const tiedNames = tied.map((t) => t.name).join(", ");
  const headToHeadScores = tied.map((t) => {
    const score = tied
      .filter((o) => o.pid !== t.pid)
      .reduce((sum, o) => sum + ((headToHead[t.pid] && headToHead[t.pid][o.pid]) || 0), 0);
    const opponents = tied.filter((o) => o.pid !== t.pid);
    const vs = opponents
      .map((o) => {
        const h = getHeadToHead(t.pid, o.pid);
        if (h.aVsB === 0 && h.bVsA === 0) return null;
        return `${o.name} ${h.aVsB}–${h.bVsA}`;
      })
      .filter(Boolean);
    return { name: t.name, score, vs };
  });
  let rationale =
    tied.length > 1
      ? `${tiedNames} were tied at ${maxWins} wins. `
      : "";
  if (rationaleParts.length > 0) {
    rationale += "Head-to-head when they played each other: " + rationaleParts.join(". ") + ". ";
  }
  if (tied.length > 1) {
    headToHeadScores.forEach(({ name, score, vs }) => {
      if (vs.length > 0) {
        rationale += `${name}: ${vs.join(", ")} (${score} H2H win${score !== 1 ? "s" : ""}). `;
      } else {
        rationale += `${name}: no head-to-head games with other tied players. `;
      }
    });
    rationale += `${winnerName} wins with the most head-to-head wins among the tied players.`;
  }
  rationale =
    rationale.trim() ||
    (tied.length > 1
      ? `Tie broken by name order among ${tiedNames}.`
      : null);
  return { winnerName, rationale: rationale || null };
}

function openCelebration(winnerName, rationale) {
  const overlay = $("celebrationOverlay");
  const nameEl = $("celebrationWinnerName");
  const rationaleEl = $("celebrationRationale");
  if (!overlay || !nameEl) return;
  nameEl.textContent = winnerName;
  if (rationaleEl) {
    rationaleEl.textContent = rationale || "";
    rationaleEl.style.display = rationale ? "block" : "none";
  }
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
}

function closeCelebration() {
  const overlay = $("celebrationOverlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
}

// ——— Timer state machine ———
// timerMode: "idle" | "countdown" | "running" | "paused" | "stopped"
let timerMode = "idle";
let countdownSecondsRemaining = 0;
let roundSecondsRemaining = 11 * 60;
let countdownInterval = null;
let roundInterval = null;

const DANGER_THRESHOLD_SEC = 90;

function updateGenerateRoundButton() {
  const btn = $("startRound");
  if (!btn) return;
  if (!currentRoundResult) {
    btn.disabled = false;
    return;
  }
  if (!roundTimerWasStarted) {
    btn.disabled = false;
    return;
  }
  if (timerMode !== "stopped") {
    btn.disabled = false;
    return;
  }
  const numMatches = (currentRoundResult.assignments || []).length;
  const numDecided = Object.keys(currentRoundDecisions).length;
  btn.disabled = numDecided < numMatches;
}

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
  if (mode === "stopped") {
    closeTimerOverlay();
  }
  updateGenerateRoundButton();
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
    const timeStr = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    timerEl.textContent = timeStr;
    const overlayDisplay = $("timerOverlayDisplay");
    const overlayCountdown = $("timerOverlayCountdown");
    if (overlayDisplay) overlayDisplay.textContent = timeStr;
    if (overlayCountdown) overlayCountdown.textContent = `Starting in ${countdownSecondsRemaining}…`;
    return;
  }
  if (countdownEl) countdownEl.textContent = "";

  const m = Math.floor(roundSecondsRemaining / 60);
  const s = roundSecondsRemaining % 60;
  const timeStr = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  timerEl.textContent = timeStr;

  if (timerMode === "running") {
    timerEl.classList.add("running");
    if (roundSecondsRemaining <= DANGER_THRESHOLD_SEC) {
      timerEl.classList.add("danger");
    }
  }

  // Sync overlay
  const overlayDisplay = $("timerOverlayDisplay");
  const overlayCountdown = $("timerOverlayCountdown");
  const overlayStatus = $("timerOverlayStatus");
  if (overlayDisplay) {
    overlayDisplay.textContent = timeStr;
    overlayDisplay.classList.toggle("danger", timerMode === "running" && roundSecondsRemaining <= DANGER_THRESHOLD_SEC);
  }
  if (overlayCountdown) {
    overlayCountdown.textContent = timerMode === "countdown" ? `Starting in ${countdownSecondsRemaining}…` : "";
  }
  if (overlayStatus) {
    overlayStatus.textContent = timerMode === "stopped" ? "Round ended early" : "";
  }
}

function updateTimerButtonStates() {
  const startBtn = $("timerStart");
  const pauseBtn = $("timerPause");
  const stopBtn = $("timerStop");
  const resetBtn = $("timerReset");
  const startEnabled = timerMode === "idle" || timerMode === "paused" || timerMode === "stopped" || timerMode === "countdown";
  const pauseEnabled = timerMode === "running";
  const stopEnabled = timerMode === "running" || timerMode === "countdown";
  if (startBtn) startBtn.disabled = !startEnabled;
  if (pauseBtn) pauseBtn.disabled = !pauseEnabled;
  if (stopBtn) stopBtn.disabled = !stopEnabled;
  if (resetBtn) resetBtn.disabled = false;

  // Overlay buttons
  const overlayStart = $("timerOverlayStart");
  const overlayPause = $("timerOverlayPause");
  const overlayStop = $("timerOverlayStop");
  if (overlayStart) overlayStart.disabled = !startEnabled;
  if (overlayPause) overlayPause.disabled = !pauseEnabled;
  if (overlayStop) overlayStop.disabled = !stopEnabled;
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
  roundTimerWasStarted = true;
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
  roundTimerWasStarted = true;
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
  openTimerOverlay();
  if (timerMode === "countdown") {
    clearCountdown();
    startRoundTimer();
    return;
  }
  if (timerMode === "idle") {
    startCountdownPhase();
    return;
  }
  if (timerMode === "paused" || timerMode === "stopped") {
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
  players.push({ id, name, isActive: true, onBench: false });
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
  const active = players.filter((p) => p.isActive && !p.onBench);
  const courtsEl = $("courts");
  const courts = courtsEl ? Number(courtsEl.value) || 6 : 6;

  if (active.length < 4) {
    alert("Need at least 4 active players (not on bench).");
    return;
  }

  if (currentRoundResult && !roundTimerWasStarted) {
    scrubCurrentRound();
  }

  stateBeforeCurrentRound = state ? JSON.parse(JSON.stringify(state)) : null;
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
  roundTimerWasStarted = false;
  setTimerMode("idle");
};

$("reset").onclick = () => {
  if (!confirm("Full reset: clear all players, scores, state, and settings. Continue?")) return;
  const keys = ["rr_players", "rr_scores", "rr_state", "rr_settings", "rr_settings_collapsed", "rr_headToHead"];
  keys.forEach((k) => localStorage.removeItem(k));
  state = null;
  players = [];
  scores = {};
  currentRoundResult = null;
  currentRoundDecisions = {};
  stateBeforeCurrentRound = null;
  roundTimerWasStarted = false;
  headToHead = {};
  const minEl = $("minutes");
  const courtEl = $("courts");
  const countdownEl = $("startCountdown");
  if (minEl) minEl.value = "11";
  if (courtEl) courtEl.value = "6";
  if (countdownEl) countdownEl.value = "30";
  const matchesEl = $("matches");
  if (matchesEl) matchesEl.innerHTML = "";
  renderByes();
  updateRoundHeader(null);
  const diag = $("diagnostics");
  if (diag) diag.textContent = "";
  renderPlayers();
  renderLeaderboard();
  roundSecondsRemaining = 11 * 60;
  timerReset();
  closeTimerOverlay();
  closeCelebration();
  updateGenerateRoundButton();
};

$("timerStart").onclick = timerStart;
$("timerPause").onclick = timerPause;
$("timerStop").onclick = timerStop;
$("timerReset").onclick = () => {
  timerReset();
};

$("endEvent").onclick = () => {
  const { winnerName, rationale } = getWinnerWithTieBreaker();
  if (!winnerName) {
    alert("No results yet. Play some rounds and record winners first.");
    return;
  }
  openCelebration(winnerName, rationale);
};

$("celebrationClose").onclick = closeCelebration;

function openTimerOverlay() {
  const overlay = $("timerOverlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  updateTimerDisplay();
  updateTimerButtonStates();
}

function closeTimerOverlay() {
  const overlay = $("timerOverlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
}

$("timerFocus").onclick = () => {
  const overlay = $("timerOverlay");
  if (!overlay) return;
  if (overlay.classList.contains("hidden")) {
    openTimerOverlay();
  } else {
    closeTimerOverlay();
  }
};

$("timerOverlayExit").onclick = closeTimerOverlay;

const overlayStart = $("timerOverlayStart");
const overlayPause = $("timerOverlayPause");
const overlayStop = $("timerOverlayStop");
if (overlayStart) overlayStart.onclick = timerStart;
if (overlayPause) overlayPause.onclick = timerPause;
if (overlayStop) overlayStop.onclick = timerStop;

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const overlay = $("timerOverlay");
  if (overlay && !overlay.classList.contains("hidden")) {
    closeTimerOverlay();
    return;
  }
  const celeb = $("celebrationOverlay");
  if (celeb && !celeb.classList.contains("hidden")) {
    closeCelebration();
  }
});

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
updateGenerateRoundButton();
