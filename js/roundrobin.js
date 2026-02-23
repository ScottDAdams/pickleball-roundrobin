// roundrobin.js
// Dynamic Random Partner Round Robin scheduler with:
// - Fair byes (no 2nd bye until everyone has 1, etc.)
// - No repeat partners until exhausted (then allow with tracking)
// - No repeat team-vs-team matchups until exhausted (then allow with tracking)
// - Randomized court assignment

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ROUNDROBIN = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function normalizeId(p) {
    if (typeof p === "string") return p.trim();
    return String(p.id != null ? p.id : p.name).trim();
  }

  function normalizeName(p) {
    if (typeof p === "string") return p.trim();
    return String(p.name != null ? p.name : p.id).trim();
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pairKey(aId, bId) {
    const x = String(aId);
    const y = String(bId);
    return x < y ? x + "|" + y : y + "|" + x;
  }

  // Team key is just partner pairKey of its two player IDs
  function teamKeyFromPair(pair) {
    return pairKey(pair[0].id, pair[1].id);
  }

  // Match key is unordered pair of team keys
  function matchKey(teamKeyA, teamKeyB) {
    return teamKeyA < teamKeyB ? teamKeyA + "||" + teamKeyB : teamKeyB + "||" + teamKeyA;
  }

  function initState(state) {
    state = state || {};
    const mode = state.mode || "random";
    return {
      round: state.round || 0,
      mode,
      formatState: state.formatState || {},
      partnerHistory: state.partnerHistory || {},
      matchHistory: state.matchHistory || {},
      byeCounts: state.byeCounts || {},
      lastCourt: state.lastCourt || {},
      ratings: state.ratings || {},
      lastRound: state.lastRound || null,
    };
  }

  function ensurePlayersInState(players, state) {
    players.forEach((p) => {
      const id = p.id;
      if (state.byeCounts[id] == null) state.byeCounts[id] = 0;
      if (state.lastCourt[id] == null) state.lastCourt[id] = 0;
      if (state.ratings[id] == null) state.ratings[id] = 1000;
    });
  }

  // Fair bye selection: always choose from the minimum byeCount bucket
  // which enforces "no second bye until all have first", etc.
  function pickByesFair(players, capacity, state) {
    if (players.length <= capacity) return { active: players, byes: [] };

    const byesNeeded = players.length - capacity;

    // sort candidates by byeCounts asc, and random tie-break
    const counts = players.map((p) => ({
      p,
      id: p.id,
      c: state.byeCounts[p.id] || 0,
      r: Math.random(),
    }));

    counts.sort((a, b) => (a.c !== b.c ? a.c - b.c : a.r - b.r));

    const byes = counts.slice(0, byesNeeded).map((x) => x.p);
    const byeSet = new Set(byes.map((p) => p.id));
    const active = players.filter((p) => !byeSet.has(p.id));

    byes.forEach((p) => {
      state.byeCounts[p.id] = (state.byeCounts[p.id] || 0) + 1;
    });

    return { active, byes };
  }

  // Try to make partner pairs with minimal repeats.
  // Returns { pairs, repeatPartnershipsUsed }
  function makePartnerPairs(activePlayers, state, opts) {
    const maxRetries = opts.maxRetries ?? 800;

    // We attempt to build a perfect set of non-repeating partners.
    // If impossible, we allow repeats but count them.
    let best = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const pool = shuffle(activePlayers);
      const used = new Set();
      const pairs = [];
      let repeatCount = 0;
      let stuck = false;

      for (let i = 0; i < pool.length; i++) {
        const p1 = pool[i];
        if (used.has(p1.id)) continue;

        // find best partner: prefer unseen partnership, otherwise least-used partnership
        let candidate = null;
        let candidateScore = Infinity;

        for (let j = i + 1; j < pool.length; j++) {
          const p2 = pool[j];
          if (used.has(p2.id) || p2.id === p1.id) continue;

          const k = pairKey(p1.id, p2.id);
          const usedCount = state.partnerHistory[k] || 0;

          // strong preference to 0
          const score = usedCount * 10 + Math.random();

          if (score < candidateScore) {
            candidateScore = score;
            candidate = p2;
            if (usedCount === 0) break;
          }
        }

        if (!candidate) {
          stuck = true;
          break;
        }

        used.add(p1.id);
        used.add(candidate.id);

        const k = pairKey(p1.id, candidate.id);
        if ((state.partnerHistory[k] || 0) > 0) repeatCount++;

        pairs.push([p1, candidate]);
      }

      if (stuck) continue;
      if (pairs.length !== activePlayers.length / 2) continue;

      // Track best solution (fewest repeats)
      if (!best || repeatCount < best.repeatCount) {
        best = { pairs, repeatCount };
        if (repeatCount === 0) break; // perfect
      }
    }

    if (!best) return { impossible: true };

    return {
      pairs: best.pairs,
      repeatPartnershipsUsed: best.repeatCount,
    };
  }

  // Pair up teams into matches, minimizing repeat matchups.
  // Returns { matches, repeatMatchupsUsed }
  function makeMatchesFromPairs(pairs, courtCount, state, opts) {
    const maxRetries = opts.maxRetries ?? 800;

    let best = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const teams = shuffle(pairs.slice()); // each item is [pA, pB]
      const used = new Set();
      const matches = [];
      let repeatMatchups = 0;
      let stuck = false;

      for (let i = 0; i < teams.length; i++) {
        if (used.has(i)) continue;
        const t1 = teams[i];
        const t1Key = teamKeyFromPair(t1);

        // choose opponent team minimizing matchup repeats
        let oppIdx = -1;
        let bestScore = Infinity;

        for (let j = i + 1; j < teams.length; j++) {
          if (used.has(j)) continue;
          const t2 = teams[j];
          const t2Key = teamKeyFromPair(t2);

          const mk = matchKey(t1Key, t2Key);
          const usedCount = state.matchHistory[mk] || 0;

          // strong preference to 0, otherwise least-used
          const score = usedCount * 10 + Math.random();

          if (score < bestScore) {
            bestScore = score;
            oppIdx = j;
            if (usedCount === 0) break;
          }
        }

        if (oppIdx === -1) {
          stuck = true;
          break;
        }

        used.add(i);
        used.add(oppIdx);

        const t2 = teams[oppIdx];
        const t2Key = teamKeyFromPair(t2);
        const mk = matchKey(t1Key, t2Key);
        if ((state.matchHistory[mk] || 0) > 0) repeatMatchups++;

        matches.push({
          team1: t1,
          team2: t2,
          team1Key: t1Key,
          team2Key: t2Key,
          matchKey: mk,
        });
      }

      if (stuck) continue;

      // we only need as many matches as courts
      const trimmed = matches.slice(0, courtCount);

      if (!best || repeatMatchups < best.repeatMatchups) {
        best = { matches: trimmed, repeatMatchups };
        if (repeatMatchups === 0) break;
      }
    }

    if (!best) return { impossible: true };

    return {
      matches: best.matches,
      repeatMatchupsUsed: best.repeatMatchups,
    };
  }

  // Assign courts randomly, but try to avoid players sticking to same court repeatedly.
  function assignCourts(matches, state) {
    // Randomize match order first
    const shuffledMatches = shuffle(matches);

    // Then do a small improvement pass:
    // If someone’s lastCourt equals proposed court, swap with another match if it helps.
    const courts = shuffledMatches.map((m, idx) => ({ m, court: idx + 1 }));

    function playersInMatch(entry) {
      const t1 = entry.m.team1;
      const t2 = entry.m.team2;
      return [t1[0], t1[1], t2[0], t2[1]];
    }

    for (let i = 0; i < courts.length; i++) {
      const entry = courts[i];
      const courtNum = entry.court;
      const players = playersInMatch(entry);

      const hasSticky = players.some((p) => (state.lastCourt[p.id] || 0) === courtNum);
      if (!hasSticky) continue;

      // Find a swap partner
      for (let j = i + 1; j < courts.length; j++) {
        const entry2 = courts[j];
        const courtNum2 = entry2.court;
        const players2 = playersInMatch(entry2);

        const stickyIfSwap1 = players.some((p) => (state.lastCourt[p.id] || 0) === courtNum2);
        const stickyIfSwap2 = players2.some((p) => (state.lastCourt[p.id] || 0) === courtNum);

        // swap if it reduces stickiness
        if (!stickyIfSwap1 && !stickyIfSwap2) {
          courts[i].m = entry2.m;
          courts[j].m = entry.m;
          break;
        }
      }
    }

    // Update lastCourt
    courts.forEach((entry) => {
      const courtNum = entry.court;
      const t1 = entry.m.team1;
      const t2 = entry.m.team2;
      [t1[0], t1[1], t2[0], t2[1]].forEach((p) => {
        state.lastCourt[p.id] = courtNum;
      });
    });

    return courts.map((entry) => ({
      court: entry.court,
      team1: entry.m.team1,
      team2: entry.m.team2,
      team1Key: entry.m.team1Key,
      team2Key: entry.m.team2Key,
      matchKey: entry.m.matchKey,
    }));
  }

  function commitHistories(roundAssignments, state) {
    // partnerHistory increments
    roundAssignments.forEach((a) => {
      const t1 = a.team1;
      const t2 = a.team2;

      const p1 = pairKey(t1[0].id, t1[1].id);
      const p2 = pairKey(t2[0].id, t2[1].id);

      state.partnerHistory[p1] = (state.partnerHistory[p1] || 0) + 1;
      state.partnerHistory[p2] = (state.partnerHistory[p2] || 0) + 1;

      // matchHistory increments
      state.matchHistory[a.matchKey] = (state.matchHistory[a.matchKey] || 0) + 1;
    });
  }

  function toDisplayAssignments(assigned) {
    return assigned.map((a) => ({
      court: a.court,
      team1: `${a.team1[0].name} & ${a.team1[1].name}`,
      team2: `${a.team2[0].name} & ${a.team2[1].name}`,
      team1Ids: [a.team1[0].id, a.team1[1].id],
      team2Ids: [a.team2[0].id, a.team2[1].id],
    }));
  }

  // ——— MODE: random (popcorn-style) ———
  function generateRandomRound(active, courtCount, state, opts) {
    const partnerRes = makePartnerPairs(active, state, opts);
    if (partnerRes.impossible) return { impossible: true, reason: "Could not build partner pairs" };
    const matchRes = makeMatchesFromPairs(partnerRes.pairs, courtCount, state, opts);
    if (matchRes.impossible) return { impossible: true, reason: "Could not build matches" };
    const assigned = assignCourts(matchRes.matches, state);
    commitHistories(assigned, state);
    return {
      assignments: toDisplayAssignments(assigned),
      assignmentsRaw: assigned,
      diagnostics: {
        repeatPartnershipsUsed: partnerRes.repeatPartnershipsUsed,
        repeatMatchupsUsed: matchRes.repeatMatchupsUsed,
      },
    };
  }

  function generateThroneRound(active, courtCount, state, opts) {
    if (!state.formatState.throne) state.formatState.throne = {};
    const t = state.formatState.throne;
    if (!t.courtRanks) t.courtRanks = {};
    if (!t.lastCourtTeams) t.lastCourtTeams = [];
    const courtRanks = t.courtRanks;
    active.forEach((p) => { if (courtRanks[p.id] == null) courtRanks[p.id] = courtCount + 1; });
    const lastRound = state.lastRound;
    const hasResults = lastRound && lastRound.assignments && lastRound.courtCount === courtCount;

    if (!hasResults && Object.keys(courtRanks).length <= active.length) {
      const shuffled = shuffle(active);
      shuffled.forEach((p, i) => { courtRanks[p.id] = Math.min(courtCount, Math.floor(i / 4) + 1); });
    }

    const withRank = active.map((p) => ({ p, rank: courtRanks[p.id] ?? courtCount + 1, r: Math.random() }));
    withRank.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.r - b.r));
    const byCourt = {};
    for (let c = 1; c <= courtCount; c++) byCourt[c] = [];
    withRank.forEach(({ p }, i) => {
      const c = Math.min(courtCount, Math.floor(i / 4) + 1);
      byCourt[c].push(p);
    });
    for (let c = 1; c <= courtCount; c++) if (byCourt[c]) byCourt[c] = shuffle(byCourt[c]);

    const assignments = [];
    for (let c = 1; c <= courtCount; c++) {
      const four = byCourt[c] || [];
      if (four.length !== 4) continue;
      const pairRes = makePartnerPairs(four, state, opts);
      if (pairRes.impossible) return { impossible: true, reason: "Could not pair court " + c };
      const pairs = pairRes.pairs;
      const team1 = pairs[0], team2 = pairs[1];
      assignments.push({
        court: c,
        team1,
        team2,
        team1Key: pairKey(team1[0].id, team1[1].id),
        team2Key: pairKey(team2[0].id, team2[1].id),
        matchKey: "",
      });
      [team1[0], team1[1], team2[0], team2[1]].forEach((p) => { state.lastCourt[p.id] = c; });
    }
    t.lastCourtTeams = assignments.map((a) => ({ court: a.court, team1Ids: [a.team1[0].id, a.team1[1].id], team2Ids: [a.team2[0].id, a.team2[1].id] }));
    return {
      assignments: toDisplayAssignments(assignments),
      diagnostics: hasResults ? {} : { message: "No results for prior round; ranks unchanged." },
    };
  }

  function applyThroneResults(state, decisions) {
    const t = state.formatState.throne;
    if (!t || !t.courtRanks) return;
    const courtCount = (state.lastRound && state.lastRound.courtCount) || 6;
    decisions.forEach((d) => {
      const winnerIds = d.winnerTeam === 1 ? d.team1Ids : d.team2Ids;
      const loserIds = d.winnerTeam === 1 ? d.team2Ids : d.team1Ids;
      winnerIds.forEach((id) => { t.courtRanks[id] = Math.max(1, (t.courtRanks[id] ?? courtCount + 1) - 1); });
      loserIds.forEach((id) => { t.courtRanks[id] = Math.min(courtCount, (t.courtRanks[id] ?? 1) + 1); });
    });
  }

  function generateUpDownRiverRound(active, courtCount, state, opts) {
    if (!state.formatState.upDownRiver) state.formatState.upDownRiver = {};
    const r = state.formatState.upDownRiver;
    if (!r.courtLineup) r.courtLineup = {};
    const lastRound = state.lastRound;
    const hasResults = lastRound && lastRound.assignments && lastRound.courtCount === courtCount;
    if (!hasResults || Object.keys(r.courtLineup).length === 0) {
      const shuffled = shuffle(active);
      const byCourt = {};
      for (let c = 1; c <= courtCount; c++) byCourt[c] = [];
      shuffled.forEach((p, i) => {
        const c = Math.min(courtCount, Math.floor(i / 4) + 1);
        byCourt[c].push(p);
      });
      for (let c = 1; c <= courtCount; c++) if (byCourt[c].length === 4) r.courtLineup[c] = byCourt[c].map((p) => p.id);
    }
    const assignments = [];
    for (let c = 1; c <= courtCount; c++) {
      const ids = r.courtLineup[c] || [];
      const four = ids.map((id) => active.find((p) => p.id === id)).filter(Boolean);
      if (four.length !== 4) continue;
      const pairRes = makePartnerPairs(four, state, opts);
      if (pairRes.impossible) return { impossible: true, reason: "Could not pair court " + c };
      const [team1, team2] = [pairRes.pairs[0], pairRes.pairs[1]];
      assignments.push({ court: c, team1, team2, team1Key: pairKey(team1[0].id, team1[1].id), team2Key: pairKey(team2[0].id, team2[1].id), matchKey: "" });
      [team1[0], team1[1], team2[0], team2[1]].forEach((p) => { state.lastCourt[p.id] = c; });
    }
    r.lastCourtTeams = assignments.map((a) => ({ court: a.court, team1Ids: [a.team1[0].id, a.team1[1].id], team2Ids: [a.team2[0].id, a.team2[1].id] }));
    return { assignments: toDisplayAssignments(assignments), diagnostics: {} };
  }

  function applyUpDownRiverResults(state, decisions) {
    const r = state.formatState.upDownRiver;
    if (!r || !r.courtLineup) return;
    const courtCount = (state.lastRound && state.lastRound.courtCount) || 6;
    const lineup = r.courtLineup;
    const byCourt = {};
    decisions.forEach((d) => {
      const winnerIds = d.winnerTeam === 1 ? d.team1Ids : d.team2Ids;
      const loserIds = d.winnerTeam === 1 ? d.team2Ids : d.team1Ids;
      byCourt[d.court] = { winnerIds: winnerIds.slice(), loserIds: loserIds.slice() };
    });
    const newLineup = {};
    for (let c = 1; c <= courtCount; c++) newLineup[c] = (lineup[c] || []).slice();
    for (let court = 2; court <= courtCount; court++) {
      const curr = byCourt[court];
      const above = byCourt[court - 1];
      if (!curr || !above) continue;
      newLineup[court - 1] = [...curr.winnerIds, ...above.loserIds];
      newLineup[court] = [...curr.loserIds, ...above.winnerIds];
    }
    r.courtLineup = newLineup;
  }

  const ELO_K = 24;
  function balancedTeamsOfFour(four, state) {
    const getR = (p) => state.ratings[p.id] || 1000;
    let best = null;
    const ind = [0, 1, 2, 3];
    for (const [i, j] of [[0, 1], [0, 2], [0, 3]]) {
      const k = ind.filter((x) => x !== i && x !== j);
      const sum1 = getR(four[i]) + getR(four[j]);
      const sum2 = getR(four[k[0]]) + getR(four[k[1]]);
      const diff = Math.abs(sum1 - sum2);
      if (best === null || diff < best.diff) best = { diff, team1: [four[i], four[j]], team2: [four[k[0]], four[k[1]]] };
    }
    return best ? [best.team1, best.team2] : null;
  }

  function generateGauntletRound(active, courtCount, state, opts) {
    active.forEach((p) => { if (state.ratings[p.id] == null) state.ratings[p.id] = 1000; });
    const withRating = active.map((p) => ({ p, r: state.ratings[p.id] || 1000 })).sort((a, b) => b.r - a.r);
    const byCourt = {};
    for (let c = 1; c <= courtCount; c++) byCourt[c] = [];
    withRating.forEach((x, i) => { const c = Math.floor(i / 4) + 1; if (c <= courtCount) byCourt[c].push(x.p); });
    const assignments = [];
    for (let c = 1; c <= courtCount; c++) {
      const four = byCourt[c];
      if (four.length !== 4) continue;
      const teams = balancedTeamsOfFour(four, state);
      if (!teams) continue;
      const [team1, team2] = teams;
      assignments.push({ court: c, team1, team2, team1Key: pairKey(team1[0].id, team1[1].id), team2Key: pairKey(team2[0].id, team2[1].id), matchKey: "" });
      [team1[0], team1[1], team2[0], team2[1]].forEach((p) => { state.lastCourt[p.id] = c; });
    }
    return { assignments: toDisplayAssignments(assignments), diagnostics: {} };
  }

  function applyGauntletResults(state, decisions) {
    decisions.forEach((d) => {
      const winnerIds = d.winnerTeam === 1 ? d.team1Ids : d.team2Ids;
      const loserIds = d.winnerTeam === 1 ? d.team2Ids : d.team1Ids;
      winnerIds.forEach((id) => { state.ratings[id] = (state.ratings[id] || 1000) + ELO_K; });
      loserIds.forEach((id) => { state.ratings[id] = Math.max(0, (state.ratings[id] || 1000) - ELO_K); });
    });
  }

  function generateCreamRound(active, courtCount, state, opts) {
    return generateGauntletRound(active, courtCount, state, opts);
  }

  function applyCreamResults(state, decisions) {
    const courtCount = (state.lastRound && state.lastRound.courtCount) || 6;
    decisions.forEach((d) => {
      const court = d.court;
      const winnerIds = d.winnerTeam === 1 ? d.team1Ids : d.team2Ids;
      const loserIds = d.winnerTeam === 1 ? d.team2Ids : d.team1Ids;
      const bump = court === 1 ? 8 : court >= courtCount ? 32 : 24;
      const drop = court === 1 ? 24 : court >= courtCount ? 8 : 16;
      winnerIds.forEach((id) => { state.ratings[id] = (state.ratings[id] || 1000) + bump; });
      loserIds.forEach((id) => { state.ratings[id] = Math.max(0, (state.ratings[id] || 1000) - drop); });
    });
  }

  // Public API
  function generateRound(playersInput, courtCountInput, stateInput, opts) {
    let mode = "random";
    let playersArg = playersInput;
    let courtsArg = courtCountInput;
    let stateArg = stateInput;
    let optsArg = opts;
    if (
      arguments.length >= 1 &&
      typeof arguments[0] === "object" &&
      arguments[0] != null &&
      "players" in arguments[0]
    ) {
      const arg = arguments[0];
      mode = arg.mode || "random";
      playersArg = arg.players;
      courtsArg = arg.courts;
      stateArg = arg.state;
      optsArg = arg.opts || {};
    }
    optsArg = optsArg || {};
    const state = initState(stateArg);
    state.mode = mode;

    const courtCount = Math.max(1, Math.min(6, Number(courtsArg || 6)));
    const capacity = courtCount * 4;
    const players = playersArg
      .map((p) => ({ id: normalizeId(p), name: normalizeName(p) }))
      .filter((p) => p.id.length > 0);
    const seen = new Set();
    const deduped = [];
    players.forEach((p) => {
      if (seen.has(p.id)) return;
      seen.add(p.id);
      deduped.push(p);
    });
    ensurePlayersInState(deduped, state);
    const { active, byes } = pickByesFair(deduped, capacity, state);
    if (active.length % 2 !== 0) {
      return { impossible: true, reason: "Odd number of active players" };
    }

    const modeFn = MODES[mode];
    if (!modeFn) return { impossible: true, reason: "Unknown mode: " + mode };
    const result = modeFn(active, courtCount, state, optsArg);
    if (result.impossible) return result;

    state.round = (state.round || 0) + 1;
    state.lastRound = { courtCount, assignments: result.assignments };

    return {
      round: state.round,
      courtCount,
      capacity,
      playersTotal: deduped.length,
      activePlayers: active,
      byePlayers: byes,
      assignments: result.assignments,
      diagnostics: result.diagnostics || {},
      state,
    };
  }

  function applyResults(state, roundResultDecisions) {
    if (!state || !roundResultDecisions || roundResultDecisions.length === 0) return;
    const mode = state.mode || "random";
    const fn = APPLY_RESULTS[mode];
    if (fn) fn(state, roundResultDecisions);
  }

  function noop() {}

  const MODES = {
    random: generateRandomRound,
    throne: generateThroneRound,
    upDownRiver: generateUpDownRiverRound,
    gauntlet: generateGauntletRound,
    cream: generateCreamRound,
  };

  const APPLY_RESULTS = {
    random: noop,
    throne: applyThroneResults,
    upDownRiver: applyUpDownRiverResults,
    gauntlet: applyGauntletResults,
    cream: applyCreamResults,
  };

  return {
    generateRound,
    applyResults,
    pairKey,
    matchKey,
  };
});