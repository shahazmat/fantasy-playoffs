import { loadSleeperLeague } from './sleeper.js';
import { DEFAULT_LEAGUE_ID, LEAGUE_OVERRIDES } from './config.js';
import { buildBase, currentOrder, clinchStatus, scoringModel, simulate, remainingWeeks } from './race.js';

const SIMS = 10000;
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const leagueId = params.get('league') || DEFAULT_LEAGUE_ID;
const storeKey = `fp:myteam:${leagueId}`;

// How each race is described. dir = 1 means "best teams get in"; -1 means worst.
const RACES = {
  playoffs: {
    key: 'playoffs', other: 'shitbowl', dir: 1, name: 'Playoffs', emoji: '🏆',
    title: 'Playoff picture', made: 'Playoffs', divCol: 'Win div', divTitle: 'Chance of winning the division',
    zones: ['Division leaders', 'Wild card', 'Outside looking in'],
    oddsKind: 'po',
    badges: {
      bye: ['b-bye', 'z', 'Clinched first-round bye'],
      division: ['b-div', 'y', 'Clinched division'],
      made: ['b-po', 'x', 'Clinched playoff spot'],
      out: ['b-out', 'e', 'Eliminated from playoffs'],
    },
    legend: 'clinched bye · clinched division · clinched playoffs · eliminated',
  },
  shitbowl: {
    key: 'shitbowl', other: 'playoffs', dir: -1, name: 'Shit Bowl', emoji: '💩',
    title: 'Shit Bowl picture', made: 'Shit Bowl', divCol: 'Last in div', divTitle: 'Chance of finishing last in the division',
    zones: ['Division cellar-dwellers', 'Wild card (worst records)', 'Safe… for now'],
    oddsKind: 'sb',
    badges: {
      bye: ['b-sb', 'z', 'Locked into the Shit Bowl #1 seed'],
      division: ['b-sb', 'y', 'Clinched last in division'],
      made: ['b-sb', 'x', 'Clinched a Shit Bowl spot'],
      out: ['b-safe', 's', 'Safe from the Shit Bowl'],
    },
    legend: 'locked #1 seed · clinched last in division · clinched Shit Bowl · safe',
  },
};

let state = null;
let myTeam = null;
let raceKey = location.hash === '#shitbowl' ? 'shitbowl' : 'playoffs';

try { myTeam = localStorage.getItem(storeKey) || null; } catch { /* storage unavailable */ }

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = name => esc(name.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?');
const fmt1 = x => x.toFixed(1);
const pctTxt = p => `${Math.round(p * 100)}%`;
const pctBound = p => (p >= 0.995 ? '>99%' : p < 0.005 ? '<1%' : pctTxt(p));
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1 && n % 10) || 0] || 'th');

function avatar(team, cls = '') {
  if (team.avatar) return `<img class="av ${cls}" src="${esc(team.avatar)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
  return `<span class="av ${cls}">${initials(team.name)}</span>`;
}

const record = d => (d.t ? `${d.w}-${d.l}-${d.t}` : `${d.w}-${d.l}`);

function oddsCell(p, status, kind, race) {
  if (p == null) return '<span class="dash">·</span>';
  if (status === 'clinched') return `<span class="check" title="Clinched">✓</span>`;
  if (status === 'eliminated') return `<span class="dash" title="${race?.dir < 0 ? 'Safe' : 'Eliminated'}">—</span>`;
  return `<span class="odds ${kind}"><span class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span>${pctBound(p)}</span>`;
}

function badge(st, race) {
  const b = race.badges;
  const mk = ([cls, letter, title]) => `<span class="badge ${cls}" title="${title}">${letter}</span>`;
  if (st.bye === 'clinched') return mk(b.bye);
  if (st.division === 'clinched') return mk(b.division);
  if (st.playoffs === 'clinched') return mk(b.made);
  if (st.playoffs === 'eliminated') return mk(b.out);
  return '';
}

const R = () => RACES[raceKey];
const RS = key => state.races[key || raceKey]; // { cfg, cur, clinch }
const simOf = (i, key) => state.sim?.teams[i][key || raceKey];
const isMe = i => myTeam != null && String(state.league.teams[i].id) === myTeam;
const seedIn = (key, i) => {
  const rs = RS(key);
  const r = rs.cur.order.indexOf(i);
  return r < rs.cfg.teams ? r + 1 : null;
};

// ---------- load ----------

async function load() {
  $('refresh').disabled = true;
  $('error').hidden = true;
  try {
    const raw = await loadSleeperLeague(leagueId);
    const ov = LEAGUE_OVERRIDES[leagueId] || {};
    const playoffs = { ...raw.playoffs, ...(ov.playoffs || {}) };
    const shitBowl = { ...playoffs, firstRound: null, ...(ov.shitBowl || {}) };
    const league = { ...raw, displayName: ov.displayName || raw.name, playoffs, shitBowl };
    const base = buildBase(league);
    const races = {
      playoffs: { cfg: playoffs, cur: currentOrder(league, base, 1), clinch: clinchStatus(league, base, 1) },
      shitbowl: { cfg: shitBowl, cur: currentOrder(league, base, -1), clinch: clinchStatus(league, base, -1) },
    };
    const model = scoringModel(league, base);
    state = { league, base, races, model, sim: null, loadedAt: new Date() };

    if (myTeam && !league.teams.some(t => String(t.id) === myTeam)) myTeam = null;
    renderStatic();
    $('loading').hidden = true;
    $('content').hidden = false;

    await new Promise(r => setTimeout(r, 30)); // let the page paint first
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
  document.documentElement.dataset.race = raceKey;
  for (const a of document.querySelectorAll('#race-toggle a')) a.setAttribute('aria-selected', String(a.dataset.race === raceKey));
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

function renderHeader() {
  const { league, loadedAt } = state;
  const weeks = league.regularSeasonWeeks;
  const done = league.lastFinalWeek - weeks[0] + 1;
  const live = league.liveWeek ? ` · Week ${league.liveWeek} in progress` : '';
  $('league-sub').textContent = `${league.season} · ${league.platform} · ${Math.max(0, done)} of ${weeks.length} weeks final${live} · updated ${loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function renderSummary() {
  const { league, base } = state;
  const weeks = league.regularSeasonWeeks;
  const done = Math.max(0, league.lastFinalWeek - weeks[0] + 1);
  const left = remainingWeeks(league).length;
  const T = league.teams;
  const nDiv = league.divisions.length;

  const bubble = key => {
    const { cfg, cur } = RS(key);
    const lastIn = cur.order[cfg.teams - 1], firstOut = cur.order[cfg.teams];
    if (firstOut == null) return null;
    const r = RACES[key];
    return {
      k: `${r.emoji} ${r.name} bubble`,
      v: `${record(base.display[lastIn])} vs ${record(base.display[firstOut])}`,
      s: key === 'playoffs'
        ? `${esc(T[lastIn].name)} (#${cfg.teams}) holds off ${esc(T[firstOut].name)}`
        : `${esc(T[lastIn].name)} (#${cfg.teams}) is just in, ${esc(T[firstOut].name)} just escapes`,
    };
  };

  let best = null;
  for (const g of league.games) {
    if (g.status !== 'final') continue;
    for (const [id, pts] of [[g.a, g.aPts], [g.b, g.bPts]]) if (!best || pts > best.pts) best = { id, pts, week: g.week };
  }
  const topPF = base.display.map((d, i) => [i, d.pf]).sort((a, b) => b[1] - a[1])[0];
  const P = league.playoffs;

  const stats = [
    { k: 'Regular season', v: `Week ${Math.min(done + 1, weeks.length)} of ${weeks.length}`, s: left ? `${left} week${left > 1 ? 's' : ''} left to play` : 'Complete', prog: done / weeks.length },
    { k: 'Format', v: `${P.teams} + ${league.shitBowl.teams} teams`, s: `🏆 Playoffs + 💩 Shit Bowl: ${nDiv} division winners/losers + ${P.teams - nDiv} wild cards each, ${P.byes} bye` },
    bubble('playoffs'),
    bubble('shitbowl'),
    best && { k: 'Top weekly score', v: fmt1(best.pts), s: `${esc(T.find(t => t.id === best.id).name)} · week ${best.week}` },
    topPF && { k: 'Top points for', v: fmt1(topPF[1]), s: esc(T[topPF[0]].name) },
  ].filter(Boolean);

  $('summary').innerHTML = stats.map(s => `
    <div class="stat"><div class="k">${s.k}</div><div class="v">${s.v}</div><div class="s">${s.s}</div>
    ${s.prog != null ? `<div class="progress"><i style="width:${(s.prog * 100).toFixed(0)}%"></i></div>` : ''}</div>`).join('');
}

function renderPicture() {
  const { league, base, sim } = state;
  const race = R(), { cfg, cur, clinch } = RS();
  const nDiv = league.divisions.length;
  const hasDivs = cfg.divisionWinnersSeeded && nDiv > 1;
  const divName = id => league.divisions.find(d => d.id === id)?.name || '';
  const wait = !sim;
  const cols = 12;
  const other = RACES[race.other];

  const zone = label => `<tr><td class="zone" colspan="${cols}">${label}</td></tr>`;
  let rows = '';
  cur.order.forEach((i, r) => {
    if (hasDivs && r === 0) rows += zone(race.zones[0]);
    if (hasDivs && r === nDiv) rows += zone(race.zones[1]);
    if (r === cfg.teams) rows += zone(race.zones[2]);
    const t = league.teams[i], d = base.display[i], st = clinch[i], s = simOf(i);
    const cls = [isMe(i) && 'me', r === cfg.teams - 1 && 'cut'].filter(Boolean).join(' ');
    const note = cur.notes.get(i);
    const otherSeed = seedIn(race.other, i);
    const also = otherSeed ? `<span class="also" title="Also currently #${otherSeed} in the ${other.name} picture">${other.emoji} #${otherSeed}</span>` : '';
    rows += `<tr class="${cls}">
      <td class="seed c ${r < cfg.teams ? 'in' : ''}">${r + 1}</td>
      <td class="l"><div class="team">${avatar(t)}<div><div class="nm">${esc(t.name)}${badge(st, race)}${also}</div>
        <div class="ow">${esc(t.owner)}${note ? ` · <span class="tb">${esc(note)}</span>` : ''}</div></div></div></td>
      ${hasDivs ? `<td class="l muted">${esc(divName(t.divisionId))}</td>` : ''}
      <td><b>${record(d)}</b></td>
      ${hasDivs ? `<td>${d.dt ? `${d.dw}-${d.dl}-${d.dt}` : `${d.dw}-${d.dl}`}</td>` : ''}
      <td title="All-play record: ${fmt1(d.bdPct * 100)}%">${Math.round(d.bdW)}-${Math.round(d.bdL)}</td>
      <td>${fmt1(d.pf)}</td>
      <td class="c"><span class="form">${d.last5.map(x => `<i class="${x}" title="${x}"></i>`).join('')}</span></td>
      <td>${sim ? fmt1(sim.teams[i].expWins) : '…'}</td>
      ${hasDivs ? `<td>${wait ? '…' : oddsCell(s.division, st.division, race.dir > 0 ? '' : 'sb', race)}</td>` : ''}
      ${cfg.byes ? `<td>${wait ? '…' : oddsCell(s.bye, st.bye, race.dir > 0 ? 'bye' : 'sb', race)}</td>` : ''}
      <td>${wait ? '…' : oddsCell(s.made, st.playoffs, race.oddsKind, race)}</td>
    </tr>`;
  });

  $('picture').innerHTML = `<thead><tr>
      <th class="c">Seed</th><th class="l">Team</th>${hasDivs ? '<th class="l">Div</th>' : ''}
      <th>W-L</th>${hasDivs ? '<th title="Record in division games">Div</th>' : ''}
      <th title="Breakdown: record if you played every team every week">Breakdown</th>
      <th>PF</th><th class="c">Last 5</th><th title="Projected final wins">Proj W</th>
      ${hasDivs ? `<th title="${race.divTitle}">${race.divCol}</th>` : ''}${cfg.byes ? `<th title="${race.dir > 0 ? 'First-round bye' : 'Shit Bowl #1 seed (bye)'}">Bye</th>` : ''}<th>${race.made}</th>
    </tr></thead><tbody>${rows}</tbody>`;

  $('picture-title').textContent = race.title;
  $('picture-note').textContent = race.dir > 0
    ? `Division winners take seeds 1–${nDiv}, then wild cards by record. Ties are broken by head-to-head, division record and breakdown (not points).`
    : `The inverse of the playoffs: the ${nDiv} division losers take seeds 1–${nDiv} (worst record first), then the ${cfg.teams - nDiv} worst remaining records. Ties use the inverse tiebreakers: losing head-to-head, a worse division record or a worse breakdown puts you further in.`;
  const b = race.badges;
  const chip = ([cls, letter]) => `<span class="badge ${cls}">${letter}</span>`;
  const words = race.legend.split(' · ');
  $('legend').innerHTML = [b.bye, b.division, b.made, b.out].map((x, k) => `${chip(x)} ${words[k]}`).join(' ') +
    ` · <span class="also">${other.emoji} #n</span> also in the ${other.name} picture` +
    ` · ${sim ? `Odds from ${sim.n.toLocaleString()} simulations of the rest of the regular season.` : 'Running simulations…'}`;
}

function renderBracket() {
  const { league, base } = state;
  const race = R(), { cfg, cur } = RS();
  const pairs = cfg.firstRound || (() => {
    const out = [];
    for (let a = cfg.byes + 1, b = cfg.teams; a < b; a++, b--) out.push([a, b]);
    return out;
  })();
  const row = s => {
    const i = cur.order[s - 1], t = league.teams[i];
    return `<div class="row ${isMe(i) ? 'me' : ''}"><span class="sd">${s}</span>${avatar(t, 'sm')}<span class="nm">${esc(t.name)}</span><span class="rc">${record(base.display[i])}</span></div>`;
  };
  const wk = league.playoffs.startWeek;
  const label = race.dir > 0 ? 'Wild card' : 'Shit Bowl round 1';
  let html = '';
  for (let s = 1; s <= cfg.byes; s++) {
    html += `<div class="match bye"><div class="hd">Week ${wk} · Bye</div>${row(s)}<div class="row tbd">Plays the lowest remaining seed in week ${wk + 1}</div></div>`;
  }
  for (const [a, b] of pairs) html += `<div class="match"><div class="hd">Week ${wk} · ${label}</div>${row(a)}${row(b)}</div>`;
  $('bracket').innerHTML = html;
  $('bracket-sub').textContent = `${race.emoji} Current ${race.name} seeds and week-${wk} matchups.`;
}

function renderDivisions() {
  const { league, base, sim } = state;
  const cur = RS('playoffs').cur;
  if (!cur.divOrder) { $('divisions').innerHTML = ''; return; }
  const clinchPO = RS('playoffs').clinch, clinchSB = RS('shitbowl').clinch;
  $('divisions').innerHTML = league.divisions.map(dv => {
    const order = cur.divOrder.get(dv.id) || [];
    const lead = base.display[order[0]];
    const rows = order.map((i, r) => {
      const t = league.teams[i], d = base.display[i];
      const gb = ((lead.w - lead.l) - (d.w - d.l)) / 2;
      const po = simOf(i, 'playoffs'), sb = simOf(i, 'shitbowl');
      return `<tr class="${isMe(i) ? 'me' : ''}">
        <td class="c muted">${r + 1}</td>
        <td class="l"><div class="team">${avatar(t, 'sm')}<span class="nm">${esc(t.name)}</span></div></td>
        <td>${record(d)}</td>
        <td class="muted">${r === 0 ? '—' : gb % 1 ? gb.toFixed(1) : gb}</td>
        <td>${po ? oddsCell(po.division, clinchPO[i].division, '') : '…'}</td>
        <td>${sb ? oddsCell(sb.division, clinchSB[i].division, 'sb', RACES.shitbowl) : '…'}</td>
      </tr>`;
    }).join('');
    return `<div class="card division"><h3>${esc(dv.name)}</h3><table class="table">
      <thead><tr><th></th><th class="l">Team</th><th>W-L</th><th>GB</th><th title="Chance of winning the division (playoffs)">🏆 1st</th><th title="Chance of finishing last (Shit Bowl)">💩 Last</th></tr></thead>
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
  const race = R();
  const card = $('stakes-card');
  if (!sim) { card.hidden = false; $('stakes').innerHTML = '<p class="muted">Simulating…</p>'; return; }
  if (sim.focusWeek == null) { card.hidden = true; return; }
  card.hidden = false;
  const live = league.liveWeek === sim.focusWeek;
  $('stakes-title').textContent = `What's at stake · Week ${sim.focusWeek}${live ? ' (live)' : ''}`;
  $('stakes-sub').textContent = race.dir > 0
    ? "Each team's playoff odds with a win vs. a loss this week, biggest swings first."
    : "Each team's Shit Bowl odds with a win vs. a loss this week, biggest swings first. Lower is better.";

  const games = sim.focus.map(({ a, b, gi }) => {
    const ca = sim.conditional(a, gi, raceKey), cb = sim.conditional(b, gi, raceKey);
    const A = { i: a, win: ca.ifAWins, lose: ca.ifBWins, pWin: ca.pAWins };
    const B = { i: b, win: cb.ifBWins, lose: cb.ifAWins, pWin: 1 - ca.pAWins };
    const swing = Math.abs(A.win - A.lose) + Math.abs(B.win - B.lose);
    return { A, B, swing, sc: focusGameScores(a, b) };
  }).sort((x, y) => y.swing - x.swing);

  const side = (S, pts) => {
    const t = league.teams[S.i];
    const d = Math.abs(S.win - S.lose);
    return `<div class="side"><span class="nm">${avatar(t, 'sm')}${esc(t.name)}</span>
      ${pts != null ? `<span class="pts">${fmt1(pts)}</span>` : `<span class="muted">${pctTxt(S.pWin)} to win</span>`}
      <span class="sw">W <b>${pctTxt(S.win)}</b> · L <b>${pctTxt(S.lose)}</b> <span class="swing ${d > 0.005 ? (race.dir > 0 ? 'up' : 'down') : ''}">(${Math.round(d * 100)})</span></span></div>`;
  };

  $('stakes').innerHTML = games.map(g => {
    const mine = isMe(g.A.i) || isMe(g.B.i);
    const showPts = g.sc && g.sc.status === 'live';
    return `<div class="stake ${mine ? 'me' : ''}">
      <div class="meta"><span>${showPts ? 'Live' : 'Win probability'}</span><span>${race.name} odds swing: <b>${Math.round(g.swing * 100)} pts</b></span></div>
      ${side(g.A, showPts ? g.sc.a : null)}${side(g.B, showPts ? g.sc.b : null)}</div>`;
  }).join('');
}

function renderRooting() {
  const { league, sim } = state;
  const race = R();
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
  $('rooting-sub').textContent = race.dir > 0
    ? `How each result changes ${meName}'s playoff odds (currently ${pctTxt(simOf(me).made)}).`
    : `How each result changes ${meName}'s Shit Bowl odds (currently ${pctTxt(simOf(me).made)}). Root to push them down.`;

  const items = sim.focus.map(({ a, b, gi }) => {
    const c = sim.conditional(me, gi, raceKey);
    const aBetter = race.dir > 0 ? c.ifAWins >= c.ifBWins : c.ifAWins <= c.ifBWins;
    const good = aBetter ? c.ifAWins : c.ifBWins, bad = aBetter ? c.ifBWins : c.ifAWins;
    return { root: aBetter ? a : b, against: aBetter ? b : a, good, bad, mine: a === me || b === me };
  }).sort((x, y) => (y.mine - x.mine) || (Math.abs(y.good - y.bad) - Math.abs(x.good - x.bad)));

  $('rooting').innerHTML = `<div class="root-list">${items.map(it => {
    const d = Math.abs(it.good - it.bad);
    const Rt = league.teams[it.root], At = league.teams[it.against];
    const deltaTxt = race.dir > 0 ? `+${Math.round(d * 100)} pts` : `−${Math.round(d * 100)} pts`;
    return `<div class="root ${it.mine ? 'mine' : ''} ${d < 0.005 ? 'meh' : ''}">
      <div class="who">${it.mine ? '<b>Your game:</b>' : 'Root for'} ${avatar(Rt, 'sm')}<b>${esc(Rt.name)}</b><span class="vs">over ${esc(At.name)}</span></div>
      <div class="delta ${d >= 0.005 ? 'up' : 'muted'}">${d < 0.005 ? 'No effect' : deltaTxt}<small>${pctTxt(it.good)} vs ${pctTxt(it.bad)}</small></div>
    </div>`;
  }).join('')}</div>`;
}

function renderSeeds() {
  const { league, sim } = state;
  const race = R(), { cfg } = RS();
  $('seeds-title').textContent = `${race.emoji} ${race.name} seed odds`;
  $('seeds-sub').textContent = race.dir > 0
    ? 'Chance of finishing in each playoff seed.'
    : 'Chance of finishing in each Shit Bowl seed (1 = worst team in the league).';
  if (!sim) { $('seeds').innerHTML = '<tbody><tr><td class="l muted">Simulating…</td></tr></tbody>'; return; }
  const order = league.teams.map((_, i) => i).sort((a, b) =>
    (simOf(b).made - simOf(a).made) || race.dir * (sim.teams[b].expWins - sim.teams[a].expWins));
  const cell = p => {
    const alpha = Math.min(1, p * 1.1);
    return `<td class="h ${p < 0.005 ? 'z' : ''}" style="background:rgba(var(--heat),${alpha.toFixed(3)});${p > 0.45 ? 'color:#fff' : ''}">${p < 0.005 ? '' : p >= 0.995 ? '>99' : Math.round(p * 100)}</td>`;
  };
  const head = Array.from({ length: cfg.teams }, (_, k) => `<th class="c">${k + 1}</th>`).join('');
  const rows = order.map(i => {
    const t = league.teams[i], s = simOf(i);
    return `<tr class="${isMe(i) ? 'me' : ''}"><td class="l"><div class="team">${avatar(t, 'sm')}<span class="nm">${esc(t.name)}</span></div></td>
      ${s.seeds.slice(0, cfg.teams).map(cell).join('')}
      <td class="c"><b>${pctBound(s.made)}</b></td></tr>`;
  }).join('');
  $('seeds').innerHTML = `<thead><tr><th class="l">Team</th>${head}<th class="c">Total</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderSchedule() {
  const { league, base, model } = state;
  const cur = RS().cur;
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
      return `<td class="op"><div class="opp ${o.live ? 'live' : ''}" style="background:rgba(43,108,176,${a.toFixed(3)})" title="${esc(op.name)} · avg ${fmt1(model.teams[o.j].raw)}">${avatar(op, 'sm')}<span class="on">${esc(op.name)}</span><span class="r">${record(base.display[o.j])}</span></div></td>`;
    }).join('');
    return `<tr class="${isMe(i) ? 'me' : ''}"><td class="l"><div class="team">${avatar(t, 'sm')}<span class="nm">${esc(t.name)}</span></div></td>${cells}<td class="c">${ord(sosRank.get(i))}</td></tr>`;
  }).join('');
  const head = weeks.map(w => `<th class="l">Wk ${w}${w === league.liveWeek ? ' · live' : ''}</th>`).join('');
  $('schedule').innerHTML = `<thead><tr><th class="l">Team</th>${head}<th class="c">SOS</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderNotes() {
  const { league, model, sim } = state;
  const P = league.playoffs, S = league.shitBowl;
  const nDiv = league.divisions.length;
  $('notes').innerHTML = `
    <h3>How this works</h3>
    <ul>
      <li>Results and schedule come live from ${esc(league.platform)}. Only weeks the platform has marked final count${league.liveWeek ? `; week ${league.liveWeek} is treated as not yet played until it's final` : ''}.</li>
      <li>Playoffs: ${P.teams} teams. Division winners are seeds 1–${nDiv}, the best remaining records are wild cards, and the top ${P.byes === 1 ? 'seed gets a bye' : `${P.byes} seeds get byes`}.</li>
      <li>Shit Bowl: ${S.teams} teams, the inverse of the playoffs. Division losers are seeds 1–${nDiv} (worst first), the worst remaining records are wild cards, and the worst ${S.byes === 1 ? 'seed gets a bye' : `${S.byes} seeds get byes`}. The two races are worked out separately, so a team can show odds in both (e.g. a weak division winner who could also be one of the worst wild cards).</li>
      <li>Tiebreakers (constitution, Art. VI). Inside a division: head-to-head (two teams only), then division record, then breakdown, then Scissors, Paper, Rock. Across divisions: head-to-head if they've played, then breakdown, then SPR. Breakdown is the all-play record: what your record would be if you'd played every team every week. The Shit Bowl uses the inverse of each step.</li>
      <li>When teams from more than one division are tied, each division's tied teams are first narrowed to their top team. Whenever a tiebreaker separates some teams but not all, the procedure starts again for those still tied. A tie that's still unbroken after breakdown is decided by a coin flip in the simulation.</li>
      <li>Odds: each remaining week is simulated ${sim ? sim.n.toLocaleString() : SIMS.toLocaleString()} times. Each team's score is drawn from a normal distribution around its season average (pulled toward the league average of ${fmt1(model.leagueMean)}) with a spread of ±${fmt1(model.sd)} points. Roster changes, injuries and byes aren't modelled.</li>
      <li>Clinched/eliminated marks only appear when they're guaranteed on wins alone. A percentage can round to >99% or <1% before a team has mathematically clinched or been eliminated.</li>
    </ul>
    <p>Add <code>?league=&lt;sleeper league id&gt;</code> to the URL to track a different Sleeper league. Link straight to the Shit Bowl view with <code>#shitbowl</code>.${sim ? ` Simulated in ${Math.round(state.simMs)} ms.` : ''}</p>`;
}

// ---------- events ----------

$('my-team').addEventListener('change', e => {
  myTeam = e.target.value || null;
  try { myTeam ? localStorage.setItem(storeKey, myTeam) : localStorage.removeItem(storeKey); } catch { /* ignore */ }
  if (state) renderAll();
});
$('refresh').addEventListener('click', load);
window.addEventListener('hashchange', () => {
  raceKey = location.hash === '#shitbowl' ? 'shitbowl' : 'playoffs';
  if (state) renderAll();
});

load();
