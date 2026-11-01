import { winningSelections } from '../../src/betting/betting.service';
import { marketProbabilities } from '../../src/betting/live-feed.service';

const byKey = (home: number, away: number, minute: number) =>
  Object.fromEntries(marketProbabilities(home, away, minute).map(([market, code, p]) => [`${market}:${code}`, p]));

describe('betting markets', () => {
  it('prices every market from the goal model: outcomes add up and a settled score is certain', () => {
    const kickoff = byKey(0, 0, 0);
    expect(kickoff['MATCH:HOME'] + kickoff['MATCH:DRAW'] + kickoff['MATCH:AWAY']).toBeCloseTo(1, 10);
    expect(kickoff['DOUBLE:1X']).toBeCloseTo(kickoff['MATCH:HOME'] + kickoff['MATCH:DRAW'], 10);
    expect(kickoff['GOALS:OVER'] + kickoff['GOALS:UNDER']).toBeCloseTo(1, 10);
    // About 2.5 goals expected over 90 minutes, so over 2.5 is a little less likely than under.
    expect(kickoff['GOALS:OVER']).toBeGreaterThan(0.4);
    expect(kickoff['GOALS:OVER']).toBeLessThan(0.5);

    expect(byKey(2, 1, 60)['GOALS:OVER']).toBe(1);
    expect(byKey(1, 1, 20)['BTTS:YES']).toBe(1);
    // With little time left and no goals, over 2.5 is almost impossible.
    expect(byKey(0, 0, 88)['GOALS:OVER']).toBeLessThan(0.001);
  });

  it('names every winning selection of a final score', () => {
    expect(winningSelections(2, 1).sort()).toEqual(['BTTS:YES', 'DOUBLE:12', 'DOUBLE:1X', 'GOALS:OVER', 'MATCH:HOME']);
    expect(winningSelections(0, 0).sort()).toEqual(['BTTS:NO', 'DOUBLE:1X', 'DOUBLE:X2', 'GOALS:UNDER', 'MATCH:DRAW']);
    expect(winningSelections(0, 3).sort()).toEqual(['BTTS:NO', 'DOUBLE:12', 'DOUBLE:X2', 'GOALS:OVER', 'MATCH:AWAY']);
  });
});
