// Platform-agnostic playoff race logic: standings, constitution tiebreakers,
// seeding, clinch/elimination checks and a Monte Carlo simulation of the rest
// of the regular season.
//
// Tiebreakers (league constitution, Article VI):
//   Within a division — two clubs: head-to-head, division record, breakdown, SPR
//                       three or more: division record, breakdown, SPR
//   Outside division  — two clubs: head-to-head (if they played), breakdown, SPR
//                       three or more: breakdown, SPR
// "Breakdown" is the all-play record (record if you played every team every week).
// When a multi-team tie mixes divisions, each division's tied teams are first
// reduced to their highest-ranked club (NFL-style), so a team never jumps a
// division mate it lost the division tiebreak to. Whenever a step separates
// some but not all clubs, the procedure restarts for the remaining group.

const PRIOR_GAMES = 3;   // shrink each team's scoring average toward the league mean
const MIN_SD = 12;
const DEFAULT_SD = 25;
const EPS = 1e-9;

const RULE_LABEL = { h2h: 'head-to-head', div: 'division record', bd: 'breakdown', spr: 'Scissors, Paper, Rock' };

// ---------- season state ----------

function newState(T) {
  return {
    T,
    w: new Float64Array(T), g: new Float64Array(T),        // overall (ties = 0.5)
    dw: new Float64Array(T), dg: new Float64Array(T),      // division games
    bw: new Float64Array(T), bg: new Float64Array(T),      // breakdown / all-play
    hw: new Float64Array(T * T), hg: new Float64Array(T * T), // head-to-head
    pf: new Float64Array(T), pa: new Float64Array(T),
  };
}

function copyState(dst, src) {
  for (const k of ['w', 'g', 'dw', 'dg', 'bw', 'bg', 'hw', 'hg', 'pf', 'pa']) dst[k].set(src[k]);
  return dst;
}

function addGame(st, a, b, sa, sb, sameDiv) {
  const T = st.T;
  const ra = sa > sb ? 1 : sa < sb ? 0 : 0.5, rb = 1 - ra;
  st.w[a] += ra; st.w[b] += rb; st.g[a]++; st.g[b]++;
  st.pf[a] += sa; st.pf[b] += sb; st.pa[a] += sb; st.pa[b] += sa;
  if (sameDiv) { st.dw[a] += ra; st.dw[b] += rb; st.dg[a]++; st.dg[b]++; }
  st.hw[a * T + b] += ra; st.hw[b * T + a] += rb; st.hg[a * T + b]++; st.hg[b * T + a]++;
}

// scores: array of length T, NaN for teams that did not play that week
function addBreakdown(st, scores) {
  const T = st.T;
  for (let i = 0; i < T; i++) {
    const si = scores[i];
    if (Number.isNaN(si)) continue;
    for (let j = 0; j < T; j++) {
      if (j === i) continue;
      const sj = scores[j];
      if (Number.isNaN(sj)) continue;
      st.bw[i] += si > sj ? 1 : si < sj ? 0 : 0.5;
      st.bg[i]++;
    }
  }
}

const pct = (w, g) => (g ? w / g : 0.5);

// ---------- base (completed games) ----------

export function buildBase(league) {
  const T = league.teams.length;
  const idx = new Map(league.teams.map((t, i) => [t.id, i]));
  const divOf = league.teams.map(t => t.divisionId);
  const sameDiv = (a, b) => divOf[a] != null && divOf[a] === divOf[b];
  const st = newState(T);
  const results = league.teams.map(() => []);
  const scores = league.teams.map(() => []);
  const rec = league.teams.map(() => ({ w: 0, l: 0, t: 0, dw: 0, dl: 0, dt: 0 }));

  const finals = league.games.filter(g => g.status === 'final').sort((x, y) => x.week - y.week);
  for (const g of finals) {
    const a = idx.get(g.a), b = idx.get(g.b);
    addGame(st, a, b, g.aPts, g.bPts, sameDiv(a, b));
    scores[a].push(g.aPts); scores[b].push(g.bPts);
    const ra = g.aPts > g.bPts ? 'W' : g.aPts < g.bPts ? 'L' : 'T';
    const rb = ra === 'W' ? 'L' : ra === 'L' ? 'W' : 'T';
    results[a].push(ra); results[b].push(rb);
    const tally = (r, x, div) => {
      if (x === 'W') r.w++; else if (x === 'L') r.l++; else r.t++;
      if (div) { if (x === 'W') r.dw++; else if (x === 'L') r.dl++; else r.dt++; }
    };
    tally(rec[a], ra, sameDiv(a, b)); tally(rec[b], rb, sameDiv(a, b));
  }
  for (const [, wk] of Object.entries(league.weekScores)) {
    addBreakdown(st, league.teams.map(t => (wk[t.id] != null ? wk[t.id] : NaN)));
  }

  const display = league.teams.map((t, i) => {
    const res = results[i];
    let streak = '';
    if (res.length) {
      const last = res[res.length - 1];
      let n = 0;
      for (let k = res.length - 1; k >= 0 && res[k] === last; k--) n++;
      streak = `${last}${n}`;
    }
    const bl = st.bg[i] - st.bw[i];
    return {
      ...rec[i],
      pf: st.pf[i], pa: st.pa[i],
      winScore: st.w[i], gp: st.g[i],
      bdW: st.bw[i], bdL: bl,
      bdPct: pct(st.bw[i], st.bg[i]),
      streak, last5: res.slice(-5), scores: scores[i],
    };
  });

  return { T, idx, divOf, st, display };
}

// ---------- ranking with constitution tiebreakers ----------

// dir = 1 ranks best-first (playoffs); dir = -1 ranks worst-first using the
// inverse of every tiebreaker (Shit Bowl).
function makeRanker(st, divOf, rand, log, dir = 1) {
  const T = st.T;
  const rec = i => dir * pct(st.w[i], st.g[i]);
  const metric = (step, g) => {
    if (step === 'h2h') {
      if (g.length !== 2) return null;
      const [a, b] = g;
      const n = st.hg[a * T + b];
      if (!n) return null;
      const x = st.hw[a * T + b] / n;
      return [dir * x, dir * (1 - x)];
    }
    if (step === 'div') return g.map(i => dir * pct(st.dw[i], st.dg[i]));
    if (step === 'bd') return g.map(i => dir * pct(st.bw[i], st.bg[i]));
    return null;
  };

  // trail: [[step, teamsSeparatedByThatStep], ...] for explaining the result
  function run(g, kind, trail = []) {
    if (g.length === 1) return g[0];
    const proc = kind === 'div'
      ? (g.length === 2 ? ['h2h', 'div', 'bd'] : ['div', 'bd'])
      : (g.length === 2 ? ['h2h', 'bd'] : ['bd']);
    for (const step of proc) {
      const v = metric(step, g);
      if (!v) continue;
      const max = Math.max(...v);
      const f = g.filter((_, k) => v[k] > max - EPS);
      const beaten = g.filter(i => !f.includes(i));
      if (f.length === 1) { log && log(f[0], [...trail, [step, beaten]]); return f[0]; }
      if (f.length < g.length) return run(f, kind, [...trail, [step, beaten]]);
    }
    const pick = g[Math.floor(rand() * g.length)];
    log && log(pick, [...trail, ['spr', g.filter(i => i !== pick)]]);
    return pick;
  }

  function pickBest(g) {
    if (g.length === 1) return g[0];
    const divs = [...new Set(g.map(i => divOf[i]))];
    if (divs.length === 1) return run(g, 'div');
    const tops = divs.map(d => {
      const m = g.filter(i => divOf[i] === d);
      return m.length === 1 ? m[0] : run(m, 'div');
    });
    return tops.length === 1 ? tops[0] : run(tops, 'out');
  }

  function rankGroup(g) {
    const out = [], rem = [...g];
    while (rem.length) {
      const b = pickBest(rem);
      out.push(b);
      rem.splice(rem.indexOf(b), 1);
    }
    return out;
  }

  function rankByRecord(list) {
    const sorted = [...list].sort((a, b) => rec(b) - rec(a));
    const out = [];
    for (let i = 0; i < sorted.length;) {
      let j = i + 1;
      while (j < sorted.length && Math.abs(rec(sorted[j]) - rec(sorted[i])) < EPS) j++;
      out.push(...(j - i === 1 ? [sorted[i]] : rankGroup(sorted.slice(i, j))));
      i = j;
    }
    return out;
  }

  return { rankByRecord };
}

// Full 1..T order: division winners first (seeded by record), then everyone else.
// With dir = -1 this is the Shit Bowl order: division losers first (worst
// record first), then everyone else worst-first.
export function seedOrder(st, divOf, divisionWinnersSeeded, rand = Math.random, log = null, dir = 1) {
  const { rankByRecord } = makeRanker(st, divOf, rand, log, dir);
  const all = Array.from({ length: st.T }, (_, i) => i);
  const divIds = [...new Set(divOf.filter(d => d != null))];
  if (!divisionWinnersSeeded || divIds.length < 2) return { order: rankByRecord(all), divOrder: null };
  const divOrder = new Map(divIds.map(d => [d, rankByRecord(all.filter(i => divOf[i] === d))]));
  const winners = [...divOrder.values()].map(o => o[0]);
  const set = new Set(winners);
  return { order: rankByRecord(winners).concat(rankByRecord(all.filter(i => !set.has(i)))), divOrder };
}

// Current standings with notes on how ties were broken.
export function currentOrder(league, base, dir = 1) {
  const cfg = dir > 0 ? league.playoffs : league.shitBowl;
  const notes = new Map();
  const log = (winner, trail) => {
    if (notes.has(winner)) return;
    const parts = trail.filter(([, beaten]) => beaten.length).map(([step, beaten]) => {
      const names = beaten.map(i => league.teams[i].name).join(', ');
      return step === 'spr' ? `tied with ${names} (unresolved: Scissors, Paper, Rock)` : `${names} on ${RULE_LABEL[step]}`;
    });
    if (parts.length) notes.set(winner, `${dir > 0 ? 'Ahead of' : 'Below'} ${parts.join('; ')}`);
  };
  // Deterministic stand-in for SPR so the table doesn't shuffle on refresh.
  let k = 0;
  const pseudo = () => ((k++ * 0.6180339887) % 1);
  const { order, divOrder } = seedOrder(base.st, base.divOf, cfg.divisionWinnersSeeded, pseudo, log, dir);
  return { order, divOrder, notes };
}

// ---------- remaining schedule ----------

export const remainingGames = league => league.games.filter(g => g.status !== 'final');
export const remainingWeeks = league => league.regularSeasonWeeks.filter(w => w > league.lastFinalWeek);

// ---------- sound clinch / elimination checks ----------
// Only claims "clinched"/"eliminated" when guaranteed on wins alone; any tie
// is treated as possibly going either way.

// With dir = -1 the same logic runs on losses: "division clinched" means
// clinched last place, "playoffs clinched" means locked into the Shit Bowl and
// "eliminated" means safe from it.
export function clinchStatus(league, base, dir = 1) {
  const T = base.T;
  const rem = new Array(T).fill(0);
  for (const g of remainingGames(league)) { rem[base.idx.get(g.a)]++; rem[base.idx.get(g.b)]++; }
  const cur = i => (dir > 0 ? base.st.w[i] : base.st.g[i] - base.st.w[i]);
  const max = i => cur(i) + rem[i];
  const { teams: spots, byes, divisionWinnersSeeded } = dir > 0 ? league.playoffs : league.shitBowl;
  const hasDivs = divisionWinnersSeeded && league.divisions.length > 1;
  const nDivs = league.divisions.length;
  const wildcards = hasDivs ? spots - nDivs : spots;
  const divOf = base.divOf;

  const nonWinnerSlots = list => {
    const byDiv = new Map();
    for (const o of list) byDiv.set(divOf[o], (byDiv.get(divOf[o]) || 0) + 1);
    let n = 0;
    for (const c of byDiv.values()) n += Math.max(0, c - 1);
    return n;
  };

  const out = [];
  for (let t = 0; t < T; t++) {
    const others = [];
    for (let o = 0; o < T; o++) if (o !== t) others.push(o);
    const mates = others.filter(o => divOf[o] === divOf[t]);
    const st = { division: null, playoffs: null, bye: null };
    const threats = others.filter(o => max(o) >= cur(t));   // could finish level or ahead
    const blockers = others.filter(o => cur(o) > max(t));  // guaranteed to finish ahead

    if (hasDivs) {
      if (mates.every(o => max(o) < cur(t))) st.division = 'clinched';
      else if (mates.some(o => cur(o) > max(t))) st.division = 'eliminated';
      if (st.division === 'clinched' || nonWinnerSlots(threats) < wildcards) st.playoffs = 'clinched';
      else if (st.division === 'eliminated' && nonWinnerSlots(blockers) >= wildcards) st.playoffs = 'eliminated';
    } else {
      if (threats.length < spots) st.playoffs = 'clinched';
      else if (blockers.length >= spots) st.playoffs = 'eliminated';
    }

    if (byes > 0) {
      if (hasDivs) {
        if (st.division === 'eliminated') st.bye = 'eliminated';
        else {
          const divsAhead = new Set(blockers.map(o => divOf[o]));
          divsAhead.delete(divOf[t]);
          if (divsAhead.size >= byes) st.bye = 'eliminated';
          const divsThreat = new Set(threats.filter(o => divOf[o] !== divOf[t]).map(o => divOf[o]));
          if (st.division === 'clinched' && divsThreat.size < byes) st.bye = 'clinched';
        }
      } else if (threats.length < byes) st.bye = 'clinched';
      else if (blockers.length >= byes) st.bye = 'eliminated';
    }
    out.push(st);
  }
  return out;
}

// ---------- scoring model ----------

export function scoringModel(league, base) {
  const all = base.display.flatMap(d => d.scores);
  const leagueMean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 100;
  let ss = 0, df = 0;
  const teams = base.display.map(d => {
    const n = d.scores.length;
    const raw = n ? d.scores.reduce((a, b) => a + b, 0) / n : leagueMean;
    for (const x of d.scores) ss += (x - raw) ** 2;
    df += Math.max(0, n - 1);
    return { mean: (raw * n + leagueMean * PRIOR_GAMES) / (n + PRIOR_GAMES), raw, games: n };
  });
  const sd = df >= 10 ? Math.max(MIN_SD, Math.sqrt(ss / df)) : DEFAULT_SD;
  return { teams, leagueMean, sd };
}

// ---------- Monte Carlo ----------

function makeNormal() {
  let spare = null;
  return () => {
    if (spare != null) { const s = spare; spare = null; return s; }
    let u, v, s;
    do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m;
    return u * m;
  };
}

export function simulate(league, base, model, n = 10000) {
  const { T, idx, divOf } = base;
  const PO = league.playoffs, SB = league.shitBowl;
  const nDivs = league.divisions.length;
  const poDivs = PO.divisionWinnersSeeded && nDivs > 1;
  const sbDivs = SB && SB.divisionWinnersSeeded && nDivs > 1;
  const sameDiv = (a, b) => divOf[a] != null && divOf[a] === divOf[b];

  const weeks = remainingWeeks(league);
  const rem = remainingGames(league);
  const gamesByWeek = weeks.map(w => rem.filter(g => g.week === w).map(g => [idx.get(g.a), idx.get(g.b)]));
  const focusWeek = weeks[0] ?? null;
  const focusGames = focusWeek != null ? gamesByWeek[0] : [];
  const G = focusGames.length;

  const races = { playoffs: PO, ...(SB ? { shitbowl: SB } : {}) };
  const tallies = {};
  for (const key of Object.keys(races)) {
    tallies[key] = {
      seedCounts: Array.from({ length: T }, () => new Float64Array(T)),
      divCount: new Float64Array(T),         // division winner (playoffs) / division loser (Shit Bowl)
      made: new Uint8Array(n * T),           // per-sim, for conditional odds
    };
  }
  const winsTotal = new Float64Array(T);
  const focusOutcome = new Uint8Array(n * G); // 1 if team a won focus game g

  const normal = makeNormal();
  const st = newState(T);
  const score = new Array(T);
  const mean = model.teams.map(m => m.mean);
  const sd = model.sd;

  const tally = (key, s, order, hasDivs) => {
    const t = tallies[key], spots = races[key].teams;
    for (let r = 0; r < T; r++) {
      const i = order[r];
      t.seedCounts[i][r]++;
      if (r < spots) t.made[s * T + i] = 1;
    }
    if (hasDivs) for (let r = 0; r < nDivs; r++) t.divCount[order[r]]++;
  };

  for (let s = 0; s < n; s++) {
    copyState(st, base.st);
    for (let wi = 0; wi < weeks.length; wi++) {
      for (let i = 0; i < T; i++) score[i] = mean[i] + sd * normal();
      const gs = gamesByWeek[wi];
      for (let gi = 0; gi < gs.length; gi++) {
        const [a, b] = gs[gi];
        addGame(st, a, b, score[a], score[b], sameDiv(a, b));
        if (wi === 0) focusOutcome[s * G + gi] = score[a] > score[b] ? 1 : 0;
      }
      addBreakdown(st, score);
    }
    tally('playoffs', s, seedOrder(st, divOf, poDivs).order, poDivs);
    if (SB) tally('shitbowl', s, seedOrder(st, divOf, sbDivs, Math.random, null, -1).order, sbDivs);
    for (let i = 0; i < T; i++) winsTotal[i] += st.w[i];
  }

  const summarise = (key, i) => {
    const t = tallies[key], cfg = races[key];
    const seeds = Array.from(t.seedCounts[i], c => c / n);
    return {
      seeds,
      made: seeds.slice(0, cfg.teams).reduce((a, b) => a + b, 0),
      bye: seeds.slice(0, cfg.byes).reduce((a, b) => a + b, 0),
      division: (key === 'playoffs' ? poDivs : sbDivs) ? t.divCount[i] / n : null,
    };
  };
  const teams = Array.from({ length: T }, (_, i) => ({
    expWins: winsTotal[i] / n,
    playoffs: summarise('playoffs', i),
    shitbowl: SB ? summarise('shitbowl', i) : null,
  }));

  // P(team x makes the given race | outcome of focus game gi)
  function conditional(x, gi, key = 'playoffs') {
    const made = tallies[key].made;
    let aWins = 0, aWinsIn = 0, bWinsIn = 0;
    for (let s = 0; s < n; s++) {
      const m = made[s * T + x];
      if (focusOutcome[s * G + gi]) { aWins++; aWinsIn += m; } else bWinsIn += m;
    }
    return {
      ifAWins: aWins ? aWinsIn / aWins : null,
      ifBWins: n - aWins ? bWinsIn / (n - aWins) : null,
      pAWins: aWins / n,
    };
  }

  const focus = focusGames.map(([a, b], gi) => ({ a, b, gi }));
  return { n, teams, focusWeek, focus, conditional };
}
