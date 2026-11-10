// Per-league settings that override what the platform API reports.
// Sleeper still reports 6 playoff teams for our league, but the league moved
// to a 7-team format: 4 division winners (seeds 1-4) + 3 wild cards (seeds 5-7),
// with only the #1 seed getting a first-round bye.

export const DEFAULT_LEAGUE_ID = '1380142135487004672';

export const LEAGUE_OVERRIDES = {
  '1380142135487004672': {
    displayName: 'The Ladies and Gentleman Fantasy Football League',
    playoffs: {
      teams: 7,
      byes: 1,
      divisionWinnersSeeded: true,
      // Week-15 pairings by seed (the bye seed waits for week 16).
      firstRound: [[2, 7], [3, 6], [4, 5]],
    },
    // The Shit Bowl mirrors the playoffs in reverse: the 4 division losers
    // (seeds 1-4, worst record first) + the 3 worst remaining records
    // (seeds 5-7), decided with the inverse of the tiebreakers. The constitution
    // describes a 6-team version; set teams: 6, byes: 2 and
    // firstRound: [[3, 6], [4, 5]] to go back to that.
    shitBowl: {
      teams: 7,
      byes: 1,
      divisionWinnersSeeded: true,
      firstRound: [[2, 7], [3, 6], [4, 5]],
    },
    // Tiebreak procedure from Article VI of the league constitution.
    tiebreakers: 'constitution',
  },
};
