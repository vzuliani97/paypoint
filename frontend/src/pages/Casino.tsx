import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, ApiError, CasinoGame, errorMessage, RoundResult } from '../api';
import { formatCop } from '../format';

interface Props {
  token: string;
  onCompleted: () => void;
  onUnauthorized: () => void;
}

const ICON: Record<string, string> = { Ruleta: '◎', Tragamonedas: '❖', Blackjack: '♠' };

export function Casino({ token, onCompleted, onUnauthorized }: Props) {
  const [games, setGames] = useState<CasinoGame[]>([]);
  const [game, setGame] = useState<CasinoGame | null>(null);
  const [stake, setStake] = useState('');
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState<RoundResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Same idea as sales and bets: a retried round replays the provider's debit and credit, it is not played twice.
  const pendingKey = useRef<string | null>(null);

  useEffect(() => {
    api<CasinoGame[]>('/casino/games', { token })
      .then((list) => {
        setGames(list);
        setGame(list[0] ?? null);
      })
      .catch((err) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : setError(errorMessage(err))));
  }, [token, onUnauthorized]);

  useEffect(() => {
    pendingKey.current = null;
  }, [game?.code, stake]);

  async function play(event: FormEvent) {
    event.preventDefault();
    if (!game) return;
    pendingKey.current ??= crypto.randomUUID();
    setBusy(true);
    setError(null);
    try {
      setRound(
        await api<RoundResult>('/casino/rounds', {
          method: 'POST',
          token,
          headers: { 'Idempotency-Key': pendingKey.current },
          body: { gameCode: game.code, stake: Number(stake) },
        }),
      );
      pendingKey.current = null;
      onCompleted();
    } catch (err) {
      if (err instanceof ApiError) {
        pendingKey.current = null;
        if (err.status === 401) return onUnauthorized();
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid">
      <section className="card">
        <h2>Juegos</h2>
        <div className="games">
          {games.map((candidate) => (
            <label key={candidate.code} className="game">
              <input type="radio" name="game" checked={game?.code === candidate.code} onChange={() => setGame(candidate)} />
              <span className="game-icon" aria-hidden="true">
                {ICON[candidate.kind] ?? '●'}
              </span>
              <strong>{candidate.name}</strong>
              <small>
                {candidate.kind} · {formatCop(candidate.minStake)} – {formatCop(candidate.maxStake)}
              </small>
            </label>
          ))}
        </div>
        <p className="hint">Integración tipo billetera: el proveedor debita y acredita el saldo con transacciones idempotentes.</p>
      </section>

      <form className="card" onSubmit={play}>
        <h2>Jugar ronda</h2>
        <label>
          Valor (COP)
          <input
            type="number"
            inputMode="numeric"
            min={game?.minStake}
            max={game?.maxStake}
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            required
          />
        </label>
        {round && (
          <div className={round.win > 0 ? 'round win' : 'round'} role="status">
            <span className="muted">{round.game}</span>
            <strong>{round.win > 0 ? `Gana ${formatCop(round.win)} (x${round.multiplier})` : 'Sin premio en esta ronda'}</strong>
            <span className="muted">Saldo: {formatCop(round.balance)}</span>
          </div>
        )}
        {error && <p className="alert error">{error}</p>}
        <button type="submit" disabled={busy || !game || !stake}>
          {busy ? 'Jugando…' : 'Jugar'}
        </button>
      </form>
    </div>
  );
}
