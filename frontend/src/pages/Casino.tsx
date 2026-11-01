import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, ApiError, CasinoGame, errorMessage, RoundResult } from '../api';
import { formatCop } from '../format';

interface Props {
  token: string;
  onCompleted: () => void;
  onUnauthorized: () => void;
}

type Category = 'ALL' | 'SLOTS' | 'TABLE';

const CATEGORIES: Array<[Category, string]> = [
  ['ALL', 'Todos'],
  ['SLOTS', 'Tragamonedas'],
  ['TABLE', 'Mesa'],
];
const QUICK_STAKES = [1_000, 2_000, 5_000, 10_000];

// Look of each fictitious game: art for the lobby tile and the symbols on its reels (the best symbol last).
const ART: Record<string, { glyph: string; symbols: string[] }> = {
  RULETA_ANDINA: { glyph: '🎡', symbols: [] },
  BLACKJACK_PACIFICO: { glyph: '🂡', symbols: [] },
  TRAGAMONEDAS_CAFE: { glyph: '☕', symbols: ['🍒', '☕', '🔔', '⭐', '💎', '7️⃣'] },
  ESMERALDAS_DEL_RIO: { glyph: '💎', symbols: ['🍀', '🔔', '⭐', '👑', '💚', '7️⃣'] },
  FRUTAS_TROPICALES: { glyph: '🍍', symbols: ['🍋', '🍉', '🍇', '🍒', '🍍', '7️⃣'] },
};

const isSlot = (game: CasinoGame) => game.kind === 'Tragamonedas';

// Small deterministic hash: the same round always draws the same filler symbols.
const seed = (text: string, salt: number) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0) + salt) >>> 0, 7);

/**
 * The provider decides the multiplier; the reels only show it. The middle line is three equal symbols for a
 * win (the best symbol for the top prize), two equal for stake back, and three different for no prize.
 */
function reelsFor(round: RoundResult, game: CasinoGame, topMultiplier: number): string[][] {
  const symbols = ART[game.code]?.symbols ?? ART.TRAGAMONEDAS_CAFE.symbols;
  const pick = (salt: number) => symbols[seed(round.roundId, salt) % symbols.length];
  let line: string[];
  if (round.multiplier >= topMultiplier) line = Array(3).fill(symbols[symbols.length - 1]);
  else if (round.multiplier > 1) line = Array(3).fill(symbols[symbols.length - 2 - (seed(round.roundId, 9) % 2)]);
  else if (round.multiplier === 1) line = [symbols[0], symbols[0], symbols[2]];
  else line = [symbols[1], symbols[3], symbols[0]];
  return [0, 1, 2].map((reel) => [pick(reel * 3 + 1), line[reel], pick(reel * 3 + 2)]);
}

export function Casino({ token, onCompleted, onUnauthorized }: Props) {
  const [games, setGames] = useState<CasinoGame[]>([]);
  const [category, setCategory] = useState<Category>('ALL');
  const [game, setGame] = useState<CasinoGame | null>(null);
  const [stake, setStake] = useState('2000');
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState<RoundResult | null>(null);
  const [stopped, setStopped] = useState(3);
  const [history, setHistory] = useState<RoundResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Same idea as sales and bets: a retried round replays the provider's debit and credit, it is not played twice.
  const pendingKey = useRef<string | null>(null);

  useEffect(() => {
    api<CasinoGame[]>('/casino/games', { token })
      .then((list) => {
        setGames(list);
        setGame(list.find(isSlot) ?? list[0] ?? null);
      })
      .catch((err) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : setError(errorMessage(err))));
  }, [token, onUnauthorized]);

  useEffect(() => {
    pendingKey.current = null;
    setRound(null);
  }, [game?.code]);

  const visible = games.filter((candidate) => category === 'ALL' || (category === 'SLOTS') === isSlot(candidate));

  async function play(event: FormEvent) {
    event.preventDefault();
    if (!game) return;
    pendingKey.current ??= crypto.randomUUID();
    setBusy(true);
    setError(null);
    setStopped(0);
    const started = Date.now();
    try {
      const result = await api<RoundResult>('/casino/rounds', {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': pendingKey.current },
        body: { gameCode: game.code, stake: Number(stake) },
      });
      pendingKey.current = null;
      // Let the reels spin a moment, then stop them one by one.
      const wait = Math.max(0, 700 - (Date.now() - started));
      setTimeout(() => {
        setRound(result);
        [1, 2, 3].forEach((reel) => setTimeout(() => setStopped(reel), (reel - 1) * 280));
        setTimeout(() => {
          setHistory((previous) => [result, ...previous].slice(0, 6));
          setBusy(false);
          onCompleted();
        }, 600);
      }, wait);
    } catch (err) {
      setStopped(3);
      setBusy(false);
      if (err instanceof ApiError) {
        pendingKey.current = null;
        if (err.status === 401) return onUnauthorized();
      }
      setError(errorMessage(err));
    }
  }

  const reels = round && game && isSlot(game) ? reelsFor(round, game, game.topMultiplier) : null;
  const finished = stopped === 3 && round !== null;

  return (
    <div className="casino">
      <div className="cs-hero">
        <div>
          <span className="cs-tag">Casino en línea</span>
          <h2>Juegos con billetera integrada</h2>
          <p>Juegos ficticios. El proveedor simulado debita la apuesta y acredita el premio en el saldo con transacciones idempotentes.</p>
        </div>
        <span className="cs-hero-glyph" aria-hidden="true">
          🎰
        </span>
      </div>

      <div className="cs-chips" role="tablist" aria-label="Categorías">
        {CATEGORIES.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={category === id} onClick={() => setCategory(id)}>
            {label}
          </button>
        ))}
      </div>

      <div className="cs-lobby">
        {visible.map((candidate) => (
          <button
            key={candidate.code}
            type="button"
            className={`cs-tile ${candidate.code.toLowerCase()} ${game?.code === candidate.code ? 'active' : ''}`}
            onClick={() => setGame(candidate)}
          >
            <span className="cs-tile-glyph" aria-hidden="true">
              {ART[candidate.code]?.glyph ?? '🎲'}
            </span>
            <strong>{candidate.name}</strong>
            <small>
              {candidate.kind} · {formatCop(candidate.minStake)} – {formatCop(candidate.maxStake)}
            </small>
          </button>
        ))}
      </div>

      {game && (
        <form className="cs-stage" onSubmit={play}>
          <div className="cs-machine">
            <div className="cs-machine-head">
              <strong>{game.name}</strong>
              <span>{game.kind}</span>
            </div>
            {isSlot(game) ? (
              <div className={`cs-reels ${finished && round!.multiplier > 1 ? 'win' : ''}`} aria-label="Rodillos">
                {[0, 1, 2].map((reel) => (
                  <div key={reel} className={stopped > reel ? 'cs-reel' : 'cs-reel spinning'}>
                    {stopped > reel && reels
                      ? reels[reel].map((symbol, row) => (
                          <span key={row} className={row === 1 ? 'cs-symbol line' : 'cs-symbol'}>
                            {symbol}
                          </span>
                        ))
                      : (ART[game.code]?.symbols ?? []).concat(ART[game.code]?.symbols ?? []).map((symbol, row) => (
                          <span key={row} className="cs-symbol">
                            {symbol}
                          </span>
                        ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className={`cs-table ${busy ? 'spinning' : ''}`} aria-hidden="true">
                <span>{ART[game.code]?.glyph ?? '🎲'}</span>
              </div>
            )}
            <div className="cs-result" role="status">
              {finished && round
                ? round.win > 0
                  ? round.multiplier > 1
                    ? `¡Gana ${formatCop(round.win)}! ×${round.multiplier}`
                    : `Recupera ${formatCop(round.win)}`
                  : 'Sin premio en esta ronda'
                : busy
                  ? 'Girando…'
                  : 'Elige el valor y juega'}
            </div>
          </div>

          <div className="cs-controls">
            <label>
              Valor de la apuesta (COP)
              <input
                type="number"
                inputMode="numeric"
                min={game.minStake}
                max={game.maxStake}
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                required
              />
            </label>
            <div className="cs-quick">
              {QUICK_STAKES.filter((amount) => amount >= game.minStake && amount <= game.maxStake).map((amount) => (
                <button key={amount} type="button" className={Number(stake) === amount ? 'active' : ''} onClick={() => setStake(String(amount))}>
                  {formatCop(amount)}
                </button>
              ))}
            </div>
            {error && <p className="alert error">{error}</p>}
            <button type="submit" className="cs-spin" disabled={busy || !stake}>
              {busy ? 'Girando…' : isSlot(game) ? 'Girar' : 'Jugar'}
            </button>
            <h3>Últimas rondas</h3>
            {history.length === 0 && <p className="cs-muted">Aún no hay rondas.</p>}
            <ul className="cs-history">
              {history.map((entry) => (
                <li key={entry.roundId}>
                  <span>{entry.game}</span>
                  <span className={entry.win > entry.stake ? 'won' : entry.win > 0 ? 'back' : 'lost'}>
                    {entry.win > 0 ? `+${formatCop(entry.win)}` : `−${formatCop(entry.stake)}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </form>
      )}
    </div>
  );
}
