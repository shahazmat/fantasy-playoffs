# Playoff Race

A static page that tracks the playoff race for our fantasy league, using live data from the Sleeper API. There's no build step or backend.

- **Playoff picture:** current seeds, records, division record, breakdown (all-play), form, projected wins, and odds to win the division, get the bye, and make the playoffs.
- **If the season ended today:** week-15 bracket.
- **Division standings:** games back, plus odds of winning and of finishing last.
- **What's at stake:** each team's playoff odds with a win vs. a loss this week.
- **Rooting guide:** pick your team to see who to cheer for in every game.
- **Seed odds** heatmap and **remaining schedule** with strength of schedule.

Seeding and tiebreakers follow the league constitution (Art. VI), updated for the 7-team format: 4 division winners plus 3 wild cards, and only the #1 seed gets a bye. League-specific overrides live in [`js/config.js`](js/config.js).

## Run locally

ES modules need a web server (opening `index.html` as a file won't work):

```bash
python -m http.server 8765
```

Then open http://localhost:8765. Add `?league=<sleeper league id>` to view another Sleeper league.

## Host on GitHub Pages

Repo **Settings → Pages → Deploy from a branch → `main` / root**. The page fetches fresh data from Sleeper every time it's opened.

## Files

- `js/sleeper.js`: Sleeper API adapter. It normalises the data, so another platform could be added alongside it.
- `js/race.js`: standings, constitution tiebreakers, clinch/elimination checks, Monte Carlo simulation.
- `js/app.js`: rendering.
- `js/config.js`: per-league overrides (playoff size, byes, first-round pairings).
