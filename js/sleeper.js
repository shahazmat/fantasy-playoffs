// Sleeper adapter: loads a league from the public Sleeper API and normalises it
// into the platform-agnostic shape the rest of the app uses.
//
// League shape:
// {
//   platform, id, name, season, status,
//   regularSeasonWeeks: [startWeek..endWeek],
//   lastFinalWeek,          // last week whose results count
//   liveWeek,               // week currently being played (or null)
//   medianGame,             // true if teams also play the weekly median
//   divisions: [{ id, name }],
//   teams: [{ id, name, owner, avatar, divisionId }],
//   games: [{ week, a, b, aPts, bPts, status: 'final'|'live'|'upcoming' }],
//   weekScores: { [week]: { [teamId]: pts } },   // final weeks only
//   playoffs: { teams, byes, startWeek, divisionWinnersSeeded }
// }

const API = 'https://api.sleeper.app/v1';

async function get(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`Sleeper request failed (${res.status}) for ${path}`);
  return res.json();
}

function avatarUrl(user) {
  const meta = user?.metadata || {};
  if (meta.avatar && /^https?:/.test(meta.avatar)) return meta.avatar;
  if (user?.avatar) return `https://sleepercdn.com/avatars/thumbs/${user.avatar}`;
  return null;
}

export async function loadSleeperLeague(leagueId) {
  const [league, rosters, users] = await Promise.all([
    get(`/league/${leagueId}`),
    get(`/league/${leagueId}/rosters`),
    get(`/league/${leagueId}/users`),
  ]);
  if (!league) throw new Error(`No Sleeper league found with id ${leagueId}`);

  const s = league.settings || {};
  const startWeek = s.start_week || 1;
  const endWeek = (s.playoff_week_start || 15) - 1;
  const regularSeasonWeeks = [];
  for (let w = startWeek; w <= endWeek; w++) regularSeasonWeeks.push(w);

  let lastFinalWeek;
  if (league.status === 'complete' || league.status === 'post_season') lastFinalWeek = endWeek;
  else if (league.status === 'in_season') lastFinalWeek = Math.min(s.last_scored_leg || 0, endWeek);
  else lastFinalWeek = startWeek - 1;

  const usersById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const divisionIds = [...new Set(rosters.map(r => r.settings?.division).filter(d => d != null))].sort((a, b) => a - b);
  const divisions = divisionIds.map(d => ({
    id: d,
    name: league.metadata?.[`division_${d}`] || `Division ${d}`,
  }));

  const teams = rosters
    .map(r => {
      const u = usersById[r.owner_id];
      return {
        id: r.roster_id,
        name: (u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`).trim(),
        owner: u?.display_name || '',
        avatar: avatarUrl(u),
        divisionId: divisions.length > 1 ? r.settings?.division ?? null : null,
      };
    })
    .sort((a, b) => a.id - b.id);

  const weekly = await Promise.all(regularSeasonWeeks.map(w => get(`/league/${leagueId}/matchups/${w}`)));

  const games = [];
  const weekScores = {};
  let liveWeek = null;
  regularSeasonWeeks.forEach((week, i) => {
    const entries = weekly[i] || [];
    const isFinal = week <= lastFinalWeek;
    const anyPoints = entries.some(e => (e.points || 0) > 0);
    const status = isFinal ? 'final' : anyPoints && league.status === 'in_season' ? 'live' : 'upcoming';
    if (status === 'live' && liveWeek == null) liveWeek = week;
    if (isFinal) weekScores[week] = Object.fromEntries(entries.map(e => [e.roster_id, e.points || 0]));

    const byMatchup = {};
    for (const e of entries) {
      if (e.matchup_id == null) continue;
      (byMatchup[e.matchup_id] ||= []).push(e);
    }
    for (const pair of Object.values(byMatchup)) {
      if (pair.length !== 2) continue;
      const [x, y] = pair;
      games.push({
        week,
        a: x.roster_id,
        b: y.roster_id,
        aPts: x.points || 0,
        bPts: y.points || 0,
        status,
      });
    }
  });

  const playoffTeams = s.playoff_teams || 6;
  let bracket = 1;
  while (bracket < playoffTeams) bracket *= 2;

  return {
    platform: 'Sleeper',
    id: leagueId,
    name: league.name,
    season: league.season,
    status: league.status,
    avatar: league.avatar ? `https://sleepercdn.com/avatars/thumbs/${league.avatar}` : null,
    regularSeasonWeeks,
    lastFinalWeek,
    liveWeek,
    medianGame: !!s.league_average_match,
    divisions,
    teams,
    games,
    weekScores,
    playoffs: {
      teams: playoffTeams,
      byes: bracket - playoffTeams,
      startWeek: s.playoff_week_start || endWeek + 1,
      divisionWinnersSeeded: divisions.length > 1,
    },
  };
}
