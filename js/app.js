// app.js
// Minimal UI wiring. Cursor can replace/expand this fast.

const $ = (id) => document.getElementById(id);

let state = null; // scheduler state from engine
let players = []; // [{id,name,isActive}]
let scores = {};  // { playerId: { wins, losses, games } }

function uid(name) {
  // stable-ish id: lower + trim. You can switch to UUID later.
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

function ensureScore(pid) {
  if (!scores[pid]) scores[pid] = { wins: 0, losses: 0, games: 0 };
}

function renderPlayers() {
  const box = $("playersList");
  if (players.length === 0) {
    box.innerHTML = `<div class="muted">No players yet.</div>`;
    return;
  }

  box.innerHTML = players
    .map((p, idx) => {
      return `
        <div class="row" style="justify-content:space-between; border-bottom:1px solid #eee; padding:8px 0;">
          <div>
            <strong>${p.name}</strong>
            ${p.isActive ? `<span class="pill">active</span>` : `<span class="pill">inactive</span>`}
          </div>
          <div class="row">
            <button data-t="toggle" data-i="${idx}">${p.isActive ? "Drop" : "Add back"}</button>
            <button data-t="remove" data-i="${idx}">Remove</button>
          </div>
        </div>
      `;
    })
    .join("");

  box.querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.i);
      const t = btn.dataset.t;
      if (t === "toggle") players[idx].isActive = !players[idx].isActive;
      if (t === "remove") players.splice(idx, 1);
      renderPlayers();
      renderLeaderboard();
    };
  });
}

function renderLeaderboard() {
  const rows = Object.entries(scores).map(([pid, s]) => {
    const name = (players.find((p) => p.id === pid) || {}).name || pid;
    return { pid, name, ...s, pct: s.games ? (s.wins / s.games) : 0 };
  });

  rows.sort((a, b) => (b.wins - a.wins) || (b.pct - a.pct) || a.name.localeCompare(b.name));

  const html = `
    <div class="box">
      ${rows.length === 0 ? `<div class="muted">No results yet.</div>` : `
        <table style="width:100%; border-collapse:collapse;">
          <thead>
            <tr>
              <th align="left">Player</th>
              <th>W</th><th>L</th><th>Games</th><th>Win%</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr style="border-top:1px solid #eee;">
                <td>${r.name}</td>
                <td align="center">${r.wins}</td>
                <td align="center">${r.losses}</td>
                <td align="center">${r.games}</td>
                <td align="center">${(r.pct * 100).toFixed(0)}%</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;
  $("leaderboard").innerHTML = html;
}

function renderRound(res) {
  // Byes
  const byes = res.byePlayers || [];
  $("byes").innerHTML = byes.length
    ? `<strong>Byes:</strong> ${byes.map((p) => p.name).join(", ")}`
    : `<div class="muted">No byes this round.</div>`;

  // Diagnostics
  $("diagnostics").textContent =
    `Round ${res.round} • Players ${res.playersTotal} • Courts ${res.courtCount} • ` +
    `Repeat partners used: ${res.diagnostics.repeatPartnershipsUsed} • ` +
    `Repeat matchups used: ${res.diagnostics.repeatMatchupsUsed}`;

  // Matches
  $("matches").innerHTML = res.assignments
    .map((m, idx) => {
      return `
        <div class="match" data-idx="${idx}">
          <div><strong>Court ${m.court}</strong></div>
          <div style="margin-top:8px;">
            <div><strong>${m.team1}</strong></div>
            <div class="muted">vs</div>
            <div><strong>${m.team2}</strong></div>
          </div>
          <div class="row" style="margin-top:10px;">
            <button data-win="1">Team 1 won</button>
            <button data-win="2">Team 2 won</button>
          </div>
        </div>
      `;
    })
    .join("");

  $("matches").querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      const card = btn.closest(".match");
      const idx = Number(card.dataset.idx);
      const win = Number(btn.dataset.win);
      const match = res.assignments[idx];

      const winners = win === 1 ? match.team1Ids : match.team2Ids;
      const losers = win === 1 ? match.team2Ids : match.team1Ids;

      winners.forEach((pid) => {
        ensureScore(pid);
        scores[pid].wins += 1;
        scores[pid].games += 1;
      });

      losers.forEach((pid) => {
        ensureScore(pid);
        scores[pid].losses += 1;
        scores[pid].games += 1;
      });

      renderLeaderboard();

      // quick visual lock
      card.style.opacity = "0.6";
      card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    };
  });
}

// Timer (simple)
let timerSeconds = 0;
let timerInterval = null;

function setTimerFromMinutes() {
  timerSeconds = Number($("minutes").value || 11) * 60;
  renderTimer();
}

function renderTimer() {
  const m = Math.floor(timerSeconds / 60);
  const s = timerSeconds % 60;
  $("timer").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function timerStart() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    timerSeconds = Math.max(0, timerSeconds - 1);
    renderTimer();
    if (timerSeconds === 0) timerPause();
  }, 1000);
}

function timerPause() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

function timerReset() {
  timerPause();
  setTimerFromMinutes();
}

// Events
$("addPlayer").onclick = () => {
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
  renderPlayers();
  renderLeaderboard();
};

$("startRound").onclick = () => {
  const active = players.filter((p) => p.isActive);
  const courts = Number($("courts").value || 6);

  if (active.length < 4) {
    alert("Need at least 4 active players.");
    return;
  }

  // Generate
  const res = ROUNDROBIN.generateRound(active, courts, state, { maxRetries: 900 });

  if (res.impossible) {
    alert("Could not generate round: " + (res.reason || "unknown"));
    return;
  }

  state = res.state;
  renderRound(res);
  timerReset();
};

$("reset").onclick = () => {
  if (!confirm("Reset event state (histories + scores)?")) return;
  state = null;
  scores = {};
  players.forEach((p) => ensureScore(p.id));
  $("matches").innerHTML = "";
  $("byes").innerHTML = "";
  $("diagnostics").textContent = "";
  renderLeaderboard();
  timerReset();
};

$("timerStart").onclick = timerStart;
$("timerPause").onclick = timerPause;
$("timerReset").onclick = timerReset;

// init
setTimerFromMinutes();
renderPlayers();
renderLeaderboard();