import { winningSelections } from '../../src/betting/betting.service';
import { isFinished, marketProbabilities, Sport } from '../../src/betting/live-feed.service';

const byKey = (sport: Sport, home: number, away: number, minute: number) =>
  Object.fromEntries(marketProbabilities(sport, home, away, minute).map(([market, code, p]) => [`${market}:${code}`, p]));

describe('betting markets', () => {
  it('prices every football market from the goal model: outcomes add up and a settled score is certain', () => {
    const kickoff = byKey('FUTBOL', 0, 0, 0);
    expect(kickoff['MATCH:HOME'] + kickoff['MATCH:DRAW'] + kickoff['MATCH:AWAY']).toBeCloseTo(1, 10);
    expect(kickoff['DOUBLE:1X']).toBeCloseTo(kickoff['MATCH:HOME'] + kickoff['MATCH:DRAW'], 10);
    expect(kickoff['GOALS:OVER'] + kickoff['GOALS:UNDER']).toBeCloseTo(1, 10);
    // About 2.5 goals expected over 90 minutes, so over 2.5 is a little less likely than under.
    expect(kickoff['GOALS:OVER']).toBeGreaterThan(0.4);
    expect(kickoff['GOALS:OVER']).toBeLessThan(0.5);

    expect(byKey('FUTBOL', 2, 1, 60)['GOALS:OVER']).toBe(1);
    expect(byKey('FUTBOL', 1, 1, 20)['BTTS:YES']).toBe(1);
    // With little time left and no goals, over 2.5 is almost impossible.
    expect(byKey('FUTBOL', 0, 0, 88)['GOALS:OVER']).toBeLessThan(0.001);
  });

  it('prices basketball, baseball and hockey: two-way sports have no draw, and totals follow each line', () => {
    for (const sport of ['BALONCESTO', 'BEISBOL'] as const) {
      const prices = byKey(sport, 0, 0, 0);
      expect(prices['MATCH:DRAW']).toBeUndefined();
      expect(prices['MATCH:HOME'] + prices['MATCH:AWAY']).toBeCloseTo(1, 10);
      expect(prices['GOALS:OVER']).toBeGreaterThan(0.3);
      expect(prices['GOALS:OVER']).toBeLessThan(0.7);
    }
    const hockey = byKey('HOCKEY', 0, 0, 0);
    expect(hockey['MATCH:HOME'] + hockey['MATCH:DRAW'] + hockey['MATCH:AWAY']).toBeCloseTo(1, 10);
    // A 20-point lead with two minutes left is nearly decided; the total already above the line is certain.
    expect(byKey('BALONCESTO', 120, 100, 46)['MATCH:HOME']).toBeGreaterThan(0.99);
    expect(byKey('BALONCESTO', 120, 100, 46)['GOALS:OVER']).toBe(1);
  });

  it('ends a game only when the rules allow: draws stand in football, two-way sports play on while level', () => {
    expect(isFinished('FUTBOL', 90, 1, 1)).toBe(true);
    expect(isFinished('BALONCESTO', 48, 100, 100)).toBe(false); // overtime
    expect(isFinished('BALONCESTO', 50, 104, 102)).toBe(false); // mid-overtime
    expect(isFinished('BALONCESTO', 53, 104, 102)).toBe(true);
    expect(isFinished('BEISBOL', 54, 3, 3)).toBe(false); // extra innings
    expect(isFinished('BEISBOL', 60, 4, 3)).toBe(true);
  });

  it('names every winning selection of a final score against the event line', () => {
    expect(winningSelections(2, 1).sort()).toEqual(['BTTS:YES', 'DOUBLE:12', 'DOUBLE:1X', 'GOALS:OVER', 'MATCH:HOME']);
    expect(winningSelections(0, 0).sort()).toEqual(['BTTS:NO', 'DOUBLE:1X', 'DOUBLE:X2', 'GOALS:UNDER', 'MATCH:DRAW']);
    expect(winningSelections(0, 3).sort()).toEqual(['BTTS:NO', 'DOUBLE:12', 'DOUBLE:X2', 'GOALS:OVER', 'MATCH:AWAY']);
    expect(winningSelections(110, 104, 217.5)).toContain('GOALS:UNDER');
    expect(winningSelections(5, 4, 8.5)).toContain('GOALS:OVER');
  });
});
