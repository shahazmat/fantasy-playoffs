import { loadSleeperLeague } from './sleeper.js';
import { DEFAULT_LEAGUE_ID, LEAGUE_OVERRIDES } from './config.js';
import { buildBase, currentOrder, clinchStatus, scoringModel, simulate, remainingWeeks } from './race.js';

const SIMS = 10000;
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const leagueId = params.get('league') || DEFAULT_LEAGUE_ID;
const storeKey = `fp:myteam:${leagueId}`;

let state = null; // { league, base, cur, clinch, model, sim }
let myTeam = null;

try { myTeam = localStorage.getItem(storeKey) || null; } catch { /* storage unavailable */ }

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = name => esc(name.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?');
const fmt1 = x => x.toFixed(1);
const pctTxt = p => `${Math.round(p * 100)}%`;
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1 && n % 10) || 0] || 'th');

function avatar(team, cls = '') {
  if (team.avatar) return `<img class="av ${cls}" src="${esc(team.avatar)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
  return `<span class="av ${cls}">${initials(team.name)}</span>`;
}

function record(d) {
  return d.t ? `${d.w}-${d.l}-${d.t}` : `${d.w}-${d.l}`;
}

function oddsCell(p, status, kind = '') {
  if (p == null) return '<span class="dash">·</span>';
  if (status === 'clinched') return '<span class="check" title="Clinched">✓</span>';
  if (status === 'eliminated') return '<span class="dash" title="Eliminated">—</span>';
  const txt = p >= 0.995 ? '>99%' : p < 0.005 ? '<1%' : pctTxt(p);
  return `<span class="odds ${kind}"><span class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span>${txt}</span>`;
}

function badge(st) {
  if (st.bye === 'clinched') return '<span class="badge b-bye" title="Clinched first-round bye">z</span>';
  if (st.division === 'clinched') return '<span class="badge b-div" title="Clinched division">y</span>';
  if (st.playoffs === 'clinched') return '<span class="badge b-po" title="Clinched playoff spot">x</span>';
  if (st.playoffs === 'eliminated') return '<span class="badge b-out" title="Eliminated from playoffs">e</span>';
  return '';
}

function swingTxt(d) {
  const v = Math.round(d * 100);
  return `${v >= 0 ? '+' : '−'}${Math.abs(v)}`;
}

// ---------- load ----------

async function load() {
  $('refresh').disabled = true;
  $('error').hidden = true;
  try {
    const raw = await loadSleeperLeague(leagueId);
    const ov = LEAGUE_OVERRIDES[leagueId] || {};
    const league = { ...raw, displayName: ov.displayName || raw.name, playoffs: { ...raw.playoffs, ...(ov.playoffs || {}) } };
    const base = buildBase(league);
    const cur = currentOrder(league, base);
    const clinch = clinchStatus(league, base);
    const model = scoringModel(league, base);
    state = { league, base, cur, clinch, model, sim: null, loadedAt: new Date() };

    if (myTeam && !league.teams.some(t => String(t.id) === myTeam)) myTeam = null;
    renderStatic();
    $('loading').hidden = true;
    $('content').hidden = false;

    // Let the page paint before the simulation runs.
    await new Promise(r => setTimeout(r, 30));
    const t0 = performance.now();
    state.sim = simulate(league, base, model, SIMS);
    state.simMs = performance.now() - t0;
    renderAll();
  } catch (err) {
    console.error(err);
    $('loading').hidden = true;
    $('error').hidden = false;
    $('error').textContent = `Couldn't load the league: ${err.message}`;
  } finally {
    $('refresh').disabled = false;
  }
}

// ---------- render ----------

function renderStatic() {
  const { league } = state;
  document.title = `${league.displayName} · Playoff Race`;
  $('league-name').textContent = league.displayName;
  const img = $('league-avatar');
  if (league.avatar) { img.src = league.avatar; img.hidden = false; }

  const sel = $('my-team');
  const sorted = [...league.teams].sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">— none —</option>' +
    sorted.map(t => `<option value="${t.id}"${String(t.id) === myTeam ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
  renderAll();
}

function renderAll() {
  renderHeader();
  renderSummary();
  renderPicture();
  renderBracket();
  renderDivisions();
  renderStakes();
  renderRooting();
  renderSeeds();
  renderSchedule();
  renderNotes();
}

function isMe(i) { return myTeam != null && String(state.league.teams[i].id) === myTeam; }

function renderHeader() {
  const { league, loadedAt } = state;
  const weeks = league.regularSeasonWeeks;
  const done = league.lastFinalWeek - weeks[0] + 1;
  const live = league.liveWeek ? ` · Week ${league.liveWeek} in progress` : '';
  $('league-sub').textContent = `${league.season} · ${league.platform} · ${Math.max(0, done)} of ${weeks.length} weeks final${live} · updated ${loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function renderSummary() {
  const { league, base, cur } = state;
  const weeks = league.regularSeasonWeeks;
  const done = Math.max(0, league.lastFinalWeek - weeks[0] + 1);
  const left = remainingWeeks(league).length;
  const P = league.playoffs;
  const nDiv = league.divisions.length;
  const lastIn = cur.order[P.teams - 1], firstOut = cur.order[P.teams];
  const T = league.teams;

  let best = null;
  for (const g of league.games) {
    if (g.status !== 'final') continue;
    for (const [id, pts] of [[g.a, g.aPts], [g.b, g.bPts]]) if (!best || pts > best.pts) best = { id, pts, week: g.week };
  }
  const topPF = base.display.map((d, i) => [i, d.pf]).sort((a, b) => b[1] - a[1])[0];
  const team = id => T.find(t => t.id === id);

  const stats = [
    { k: 'Regular season', v: `Week ${Math.min(done + 1, weeks.length)} of ${weeks.length}`, s: left ? `${left} week${left > 1 ? 's' : ''} left to play` : 'Complete', prog: done / weeks.length },
    { k: 'Playoff format', v: `${P.teams} teams`, s: P.divisionWinnersSeeded && nDiv > 1 ? `${nDiv} division winners + ${P.teams - nDiv} wild cards · ${P.byes} bye${P.byes === 1 ? '' : 's'}` : `${P.byes} byes` },
    firstOut != null && { k: 'The bubble', v: `${record(base.display[lastIn])} vs ${record(base.display[firstOut])}`, s: `${esc(T[lastIn].name)} (#${P.teams}) holds off ${esc(T[firstOut].name)}` },
    best && { k: 'Top weekly score', v: fmt1(best.pts), s: `${esc(team(best.id).name)} · week ${best.week}` },
    topPF && { k: 'Top points for', v: fmt1(topPF[1]), s: esc(T[topPF[0]].name) },
  ].filter(Boolean);

  $('summary').innerHTML = stats.map(s => `
    <div class="stat"><div class="k">${s.k}</div><div class="v">${s.v}</div><div class="s">${s.s}</div>
    ${s.prog != null ? `<div class="progress"><i style="width:${(s.prog * 100).toFixed(0)}%"></i></div>` : ''}</div>`).join('');
}

function renderPicture() {
  const { league, base, cur, clinch, sim } = state;
  const P = league.playoffs;
  const nDiv = league.divisions.length;
  const hasDivs = P.divisionWinnersSeeded && nDiv > 1;
  const divName = id => league.divisions.find(d => d.id === id)?.name || '';
  const simulating = !sim;
  const cols = 12;

  const zone = label => `<tr><td class="zone" colspan="${cols}">${label}</td></tr>`;
  let rows = '';
  cur.order.forEach((i, r) => {
    if (hasDivs && r === 0) rows += zone('Division leaders');
    if (hasDivs && r === nDiv) rows += zone('Wild card');
    if (r === P.teams) rows += zone('Outside looking in');
    const t = league.teams[i], d = base.display[i], st = clinch[i], s = sim?.teams[i];
    const cls = [isMe(i) && 'me', r === P.teams - 1 && 'cut'].filter(Boolean).join(' ');
    const note = cur.notes.get(i);
    rows += `<tr class="${cls}">
      <td class="seed c ${r < P.teams ? 'in' : ''}">${r + 1}</td>
      <td class="l"><div class="team">${avatar(t)}<div><div class="nm">${esc(t.name)}${badge(st)}</div>
        <div class="ow">${esc(t.owner)}${note ? ` · <span class="tb">${esc(note)}</span>` : ''}</div></div></div></td>
      ${hasDivs ? `<td class="l muted">${esc(divName(t.divisionId))}</td>` : ''}
      <td><b>${record(d)}</b></td>
      ${hasDivs ? `<td>${d.dt ? `${d.dw}-${d.dl}-${d.dt}` : `${d.dw}-${d.dl}`}</td>` : ''}
      <td title="All-play record: ${fmt1(d.bdPct * 100)}%">${Math.round(d.bdW)}-${Math.round(d.bdL)}</td>
      <td>${fmt1(d.pf)}</td>
      <td class="c"><span class="form">${d.last5.map(x => `<i class="${x}" title="${x}"></i>`).join('')}</span></td>
      <td>${s ? fmt1(s.expWins) : '…'}</td>
      ${hasDivs ? `<td>${simulating ? '…' : oddsCell(s.division, st.division)}</td>` : ''}
      ${P.byes ? `<td>${simulating ? '…' : oddsCell(s.bye, st.bye, 'bye')}</td>` : ''}
      <td>${simulating ? '…' : oddsCell(s.playoffs, st.playoffs, 'po')}</td>
    </tr>`;
  });

  $('picture').innerHTML = `<thead><tr>
      <th class="c">Seed</th><th class="l">Team</th>${hasDivs ? '<th class="l">Div</th>' : ''}
      <th>W-L</th>${hasDivs ? '<th title="Record in division games">Div</th>' : ''}
      <th title="Breakdown: record if you played every team every week">Breakdown</th>
      <th>PF</th><th class="c">Last 5</th><th title="Projected final wins">Proj W</th>
      ${hasDivs ? '<th>Win div</th>' : ''}${P.byes ? '<th>Bye</th>' : ''}<th>Playoffs</th>
    </tr></thead><tbody>${rows}</tbody>`;

  $('picture-note').textContent = `Seeded per the league constitution: ${hasDivs ? `division winners take seeds 1–${nDiv}, then wild cards by record` : 'by record'}. Ties are broken by head-to-head, division record and breakdown — not points.`;
  $('legend').innerHTML = `<span class="badge b-bye">z</span> clinched bye <span class="badge b-div">y</span> clinched division
    <span class="badge b-po">x</span> clinched playoffs <span class="badge b-out">e</span> eliminated
    · ${sim ? `Odds from ${sim.n.toLocaleString()} simulations of the rest of the regular season.` : 'Running simulations…'}`;
}

function renderBracket() {
  const { league, base, cur } = state;
  const P = league.playoffs;
  const seedTeam = s => cur.order[s - 1];
  const pairs = P.firstRound || (() => {
    const out = [];
    for (let a = P.byes + 1, b = P.teams; a < b; a++, b--) out.push([a, b]);
    return out;
  })();
  const row = s => {
    const i = seedTeam(s), t = league.teams[i];
    return `<div class="row ${isMe(i) ? 'me' : ''}"><span class="sd">${s}</span>${avatar(t, 'sm')}<span class="nm">${esc(t.name)}</span><span class="rc">${record(base.display[i])}</span></div>`;
  };
  let html = '';
  for (let s = 1; s <= P.byes; s++) {
    html += `<div class="match bye"><div class="hd">Week ${P.startWeek} · Bye</div>${row(s)}<div class="row tbd">Plays the lowest remaining seed in week ${P.startWeek + 1}</div></div>`;
  }
  for (const [a, b] of pairs) html += `<div class="match"><div class="hd">Week ${P.startWeek} · Wild card</div>${row(a)}${row(b)}</div>`;
  $('bracket').innerHTML = html;
  $('bracket-sub').textContent = `Current seeds and week-${P.startWeek} matchups.`;
}

function renderDivisions() {
  const { league, base, cur, sim } = state;
  if (!cur.divOrder) { $('divisions').innerHTML = ''; return; }
  $('divisions').innerHTML = league.divisions.map(dv => {
    const order = cur.divOrder.get(dv.id) || [];
    const lead = base.display[order[0]];
    const rows = order.map((i, r) => {
      const t = league.teams[i], d = base.display[i], s = sim?.teams[i];
      const gb = ((lead.w - lead.l) - (d.w - d.l)) / 2;
      return `<tr class="${isMe(i) ? 'me' : ''}">
        <td class="c muted">${r + 1}</td>
        <td class="l"><div class="team">${avatar(t, 'sm')}<span class="nm">${esc(t.name)}</span></div></td>
        <td>${record(d)}</td>
        <td class="muted">${r === 0 ? '—' : gb % 1 ? gb.toFixed(1) : gb}</td>
        <td>${s ? oddsCell(s.division, state.clinch[i].division) : '…'}</td>
        <td title="Chance of finishing last in the division">${s ? (s.divisionLast < 0.005 ? '<span class="dash">—</span>' : pctTxt(s.divisionLast)) : '…'}</td>
      </tr>`;
    }).join('');
    return `<div class="card division"><h3>${esc(dv.name)}</h3><table class="table">
      <thead><tr><th></th><th class="l">Team</th><th>W-L</th><th>GB</th><th>Win</th><th title="Chance of finishing last">Last</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }).join('');
}

function focusGameScores(a, b) {
  const { league, sim } = state;
  const ta = league.teams[a].id, tb = league.teams[b].id;
  const g = league.games.find(x => x.week === sim.focusWeek && ((x.a === ta && x.b === tb) || (x.a === tb && x.b === ta)));
  if (!g) return null;
  return { status: g.status, a: g.a === ta ? g.aPts : g.bPts, b: g.a === ta ? g.bPts : g.aPts };
}

function renderStakes() {
  const { league, sim } = state;
  const card = $('stakes-card');
  if (!sim || sim.focusWeek == null) { card.hidden = !!sim; $('stakes').innerHTML = sim ? '' : '<p class="muted">Simulating…</p>'; return; }
  card.hidden = false;
  const live = league.liveWeek === sim.focusWeek;
  $('stakes-title').textContent = `What's at stake · Week ${sim.focusWeek}${live ? ' (live)' : ''}`;

  const games = sim.focus.map(({ a, b, gi }) => {
    const ca = sim.conditional(a, gi), cb = sim.conditional(b, gi);
    const A = { i: a, win: ca.ifAWins, lose: ca.ifBWins, pWin: ca.pAWins };
    const B = { i: b, win: cb.ifBWins, lose: cb.ifAWins, pWin: 1 - ca.pAWins };
    const swing = (A.win - A.lose) + (B.win - B.lose);
    return { A, B, swing, sc: focusGameScores(a, b) };
  }).sort((x, y) => y.swing - x.swing);

  const side = (S, pts) => {
    const t = league.teams[S.i];
    const d = S.win - S.lose;
    return `<div class="side"><span class="nm">${avatar(t, 'sm')}${esc(t.name)}</span>
      ${pts != null ? `<span class="pts">${fmt1(pts)}</span>` : `<span class="muted">${pctTxt(S.pWin)} to win</span>`}
      <span class="sw">W <b>${pctTxt(S.win)}</b> · L <b>${pctTxt(S.lose)}</b> <span class="swing ${d > 0.005 ? 'up' : ''}">(${swingTxt(d)})</span></span></div>`;
  };

  $('stakes').innerHTML = games.map(g => {
    const mine = isMe(g.A.i) || isMe(g.B.i);
    const showPts = g.sc && g.sc.status === 'live';
    return `<div class="stake ${mine ? 'me' : ''}">
      <div class="meta"><span>${showPts ? 'Live' : 'Win probability'}</span><span>Playoff odds swing: <b>${Math.round(g.swing * 100)} pts</b></span></div>
      ${side(g.A, showPts ? g.sc.a : null)}${side(g.B, showPts ? g.sc.b : null)}</div>`;
  }).join('');
}

function renderRooting() {
  const { league, sim } = state;
  const card = $('rooting-card');
  if (sim && sim.focusWeek == null) { card.hidden = true; return; }
  card.hidden = false;
  if (!sim) { $('rooting').innerHTML = '<p class="muted">Simulating…</p>'; $('rooting-sub').textContent = ''; return; }
  const me = myTeam != null ? league.teams.findIndex(t => String(t.id) === myTeam) : -1;
  $('rooting-title').textContent = `Rooting guide · Week ${sim.focusWeek}`;
  if (me < 0) {
    $('rooting-sub').textContent = 'Pick your team at the top of the page to see who to cheer for in every game this week.';
    $('rooting').innerHTML = '';
    return;
  }
  const meName = league.teams[me].name;
  $('rooting-sub').textContent = `How each result changes ${meName}'s playoff odds (currently ${pctTxt(sim.teams[me].playoffs)}).`;

  const items = sim.focus.map(({ a, b, gi }) => {
    const c = sim.conditional(me, gi);
    const aBetter = c.ifAWins >= c.ifBWins;
    return {
      root: aBetter ? a : b, against: aBetter ? b : a,
      hi: Math.max(c.ifAWins, c.ifBWins), lo: Math.min(c.ifAWins, c.ifBWins),
      mine: a === me || b === me,
    };
  }).sort((x, y) => (y.mine - x.mine) || ((y.hi - y.lo) - (x.hi - x.lo)));

  $('rooting').innerHTML = `<div class="root-list">${items.map(it => {
    const d = it.hi - it.lo;
    const R = league.teams[it.root], A = league.teams[it.against];
    return `<div class="root ${it.mine ? 'mine' : ''} ${d < 0.005 ? 'meh' : ''}">
      <div class="who">${it.mine ? '<b>Your game:</b>' : 'Root for'} ${avatar(R, 'sm')}<b>${esc(R.name)}</b><span class="vs">over ${esc(A.name)}</span></div>
      <div class="delta ${d >= 0.005 ? 'up' : 'muted'}">${d < 0.005 ? 'No effect' : `+${Math.round(d * 100)} pts`}<small>${pctTxt(it.hi)} vs ${pctTxt(it.lo)}</small></div>
    </div>`;
  }).join('')}</div>`;
}

function renderSeeds() {
  const { league, sim } = state;
  if (!sim) { $('seeds').innerHTML = '<tbody><tr><td class="l muted">Simulating…</td></tr></tbody>'; return; }
  const P = league.playoffs;
  const order = league.teams.map((_, i) => i).sort((a, b) =>
    (sim.teams[b].playoffs - sim.teams[a].playoffs) || (sim.teams[b].expWins - sim.teams[a].expWins));
  const cell = p => {
    const alpha = Math.min(1, p * 1.1);
    const dark = p > 0.45;
    return `<td class="h ${p < 0.005 ? 'z' : ''}" style="background:rgba(var(--heat),${alpha.toFixed(3)});${dark ? 'color:#fff' : ''}">${p < 0.005 ? '' : p >= 0.995 ? '>99' : Math.round(p * 100)}</td>`;
  };
  const head = Array.from({ length: P.teams }, (_, k) => `<th class="c">${k + 1}</th>`).join('');
  const rows = order.map(i => {
    const t = league.teams[i], s = sim.teams[i];
    return `<tr class="${isMe(i) ? 'me' : ''}"><td class="l"><div class="team">${avatar(t, 'sm')}<span class="nm">${esc(t.name)}</span></div></td>
      ${s.seeds.slice(0, P.teams).map(cell).join('')}
      <td class="c"><b>${s.playoffs >= 0.995 ? '>99%' : s.playoffs < 0.005 ? '<1%' : pctTxt(s.playoffs)}</b></td></tr>`;
  }).join('');
  $('seeds').innerHTML = `<thead><tr><th class="l">Team</th>${head}<th class="c">Total</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderSchedule() {
  const { league, base, cur, model } = state;
  const weeks = remainingWeeks(league);
  if (!weeks.length) { $('schedule').innerHTML = '<tbody><tr><td class="l muted">Regular season complete.</td></tr></tbody>'; return; }
  const means = model.teams.map(m => m.mean);
  const lo = Math.min(...means), hi = Math.max(...means);
  const strength = i => (hi > lo ? (means[i] - lo) / (hi - lo) : 0.5);
  const idOf = i => league.teams[i].id;

  const opps = league.teams.map((_, i) => weeks.map(w => {
    const g = league.games.find(x => x.week === w && (x.a === idOf(i) || x.b === idOf(i)));
    if (!g) return null;
    return { j: base.idx.get(g.a === idOf(i) ? g.b : g.a), live: g.status === 'live' };
  }));
  const sos = opps.map(list => {
    const xs = list.filter(Boolean).map(o => means[o.j]);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  });
  const sosRank = new Map([...sos.keys()].sort((a, b) => sos[b] - sos[a]).map((i, r) => [i, r + 1]));

  const rows = cur.order.map(i => {
    const t = league.teams[i];
    const cells = opps[i].map(o => {
      if (!o) return '<td class="op muted">bye</td>';
      const op = league.teams[o.j];
      const a = 0.08 + strength(o.j) * 0.5;
      return `<td class="op"><div class="opp ${o.live ? 'live' : ''}" style="background:rgba(var(--heat),${a.toFixed(3)})" title="${esc(op.name)} · avg ${fmt1(model.teams[o.j].raw)}">${avatar(op, 'sm')}<span class="on">${esc(op.name)}</span><span class="r">${record(base.display[o.j])}</span></div></td>`;
    }).join('');
    return `<tr class="${isMe(i) ? 'me' : ''}"><td class="l"><div class="team">${avatar(t, 'sm')}<span class="nm">${esc(t.name)}</span></div></td>${cells}<td class="c">${ord(sosRank.get(i))}</td></tr>`;
  }).join('');
  const head = weeks.map(w => `<th class="l">Wk ${w}${w === league.liveWeek ? ' · live' : ''}</th>`).join('');
  $('schedule').innerHTML = `<thead><tr><th class="l">Team</th>${head}<th class="c">SOS</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderNotes() {
  const { league, model, sim } = state;
  const P = league.playoffs;
  $('notes').innerHTML = `
    <h3>How this works</h3>
    <ul>
      <li>Results and schedule come live from ${esc(league.platform)}. Only weeks the platform has marked final count${league.liveWeek ? `; week ${league.liveWeek} is treated as not yet played until it's final` : ''}.</li>
      <li>Playoffs: ${P.teams} teams. Division winners are seeds 1–${league.divisions.length}, the best remaining records are wild cards, and the top ${P.byes === 1 ? 'seed gets a bye' : `${P.byes} seeds get byes`}.</li>
      <li>Tiebreakers (constitution, Art. VI). Inside a division: head-to-head (two teams only), then division record, then breakdown, then Scissors, Paper, Rock. Across divisions: head-to-head if they've played, then breakdown, then SPR. Breakdown is the all-play record: what your record would be if you'd played every team every week.</li>
      <li>When teams from more than one division are tied, each division's tied teams are first narrowed to their top team. Whenever a tiebreaker separates some teams but not all, the procedure starts again for those still tied. A tie that's still unbroken after breakdown is decided by a coin flip in the simulation.</li>
      <li>Odds: each remaining week is simulated ${sim ? sim.n.toLocaleString() : SIMS.toLocaleString()} times. Each team's score is drawn from a normal distribution around its season average (pulled toward the league average of ${fmt1(model.leagueMean)}) with a spread of ±${fmt1(model.sd)} points. Roster changes, injuries and byes aren't modelled.</li>
      <li>The z/y/x/e marks only appear when they're guaranteed on wins alone. A percentage can round to >99% or <1% before a team has mathematically clinched or been eliminated.</li>
    </ul>
    <p>Add <code>?league=&lt;sleeper league id&gt;</code> to the URL to track a different Sleeper league.${sim ? ` Simulated in ${Math.round(state.simMs)} ms.` : ''}</p>`;
}

// ---------- events ----------

$('my-team').addEventListener('change', e => {
  myTeam = e.target.value || null;
  try { myTeam ? localStorage.setItem(storeKey, myTeam) : localStorage.removeItem(storeKey); } catch { /* ignore */ }
  if (state) renderAll();
});
$('refresh').addEventListener('click', load);

load();
