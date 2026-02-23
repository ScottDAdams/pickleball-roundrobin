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
    return {
      round: state.round || 0,
      // partnerHistory: { "a|b": count }
      partnerHistory: state.partnerHistory || {},
      // matchHistory: { "teamA||teamB": count }
      matchHistory: state.matchHistory || {},
      // byeCounts: { playerId: number }
      byeCounts: state.byeCounts || {},
      // lastCourt: { playerId: lastCourtNumber }
      lastCourt: state.lastCourt || {},
    };
  }

  function ensurePlayersInState(players, state) {
    players.forEach((p) => {
      const id = p.id;
      if (state.byeCounts[id] == null) state.byeCounts[id] = 0;
      if (state.lastCourt[id] == null) state.lastCourt[id] = 0;
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

  // Public API
  function generateRound(playersInput, courtCountInput, stateInput, opts) {
    opts = opts || {};
    const state = initState(stateInput);

    const courtCount = Math.max(1, Math.min(6, Number(courtCountInput || 6)));
    const capacity = courtCount * 4;

    // normalize players
    const players = playersInput
      .map((p) => ({ id: normalizeId(p), name: normalizeName(p) }))
      .filter((p) => p.id.length > 0);

    // de-dupe by id
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
      // This should only happen if something is weird like capacity forcing odd active
      return { impossible: true, reason: "Odd number of active players" };
    }

    const partnerRes = makePartnerPairs(active, state, opts);
    if (partnerRes.impossible) return { impossible: true, reason: "Could not build partner pairs" };

    const matchRes = makeMatchesFromPairs(partnerRes.pairs, courtCount, state, opts);
    if (matchRes.impossible) return { impossible: true, reason: "Could not build matches" };

    const assigned = assignCourts(matchRes.matches, state);

    // commit histories
    commitHistories(assigned, state);

    state.round = (state.round || 0) + 1;

    return {
      round: state.round,
      courtCount,
      capacity,
      playersTotal: deduped.length,
      activePlayers: active,
      byePlayers: byes,
      assignments: assigned.map((a) => ({
        court: a.court,
        team1: `${a.team1[0].name} & ${a.team1[1].name}`,
        team2: `${a.team2[0].name} & ${a.team2[1].name}`,
        // keep ids around for scoring
        team1Ids: [a.team1[0].id, a.team1[1].id],
        team2Ids: [a.team2[0].id, a.team2[1].id],
      })),
      diagnostics: {
        repeatPartnershipsUsed: partnerRes.repeatPartnershipsUsed,
        repeatMatchupsUsed: matchRes.repeatMatchupsUsed,
      },
      state,
    };
  }

  return {
    generateRound,
    pairKey,
    matchKey,
  };
});