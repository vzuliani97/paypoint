import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, Bet, BoardEvent, errorMessage } from '../api';
import { BET_STATUS_LABELS, formatCop, formatOdds } from '../format';

interface Props {
  token: string;
  onCompleted: () => void;
  onUnauthorized: () => void;
}

type Pick = { eventId: number; selectionId: number; code: 'HOME' | 'DRAW' | 'AWAY'; label: string; match: string; odds: number };

const PICK_LABEL = { HOME: '1', DRAW: 'X', AWAY: '2' } as const;
const QUICK_STAKES = [2_000, 5_000, 10_000, 20_000];

export function LiveBetting({ token, onCompleted, onUnauthorized }: Props) {
  const [board, setBoard] = useState<BoardEvent[]>([]);
  const [connected, setConnected] = useState(false);
  // Last price seen per selection, to flash a price that moved up or down.
  const [moves, setMoves] = useState<Record<number, 'up' | 'down'>>({});
  const previous = useRef<Record<number, number>>({});
  const [bets, setBets] = useState<Bet[]>([]);
  const [pick, setPick] = useState<Pick | null>(null);

  useEffect(() => {
    const source = new EventSource('/api/betting/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      const next = JSON.parse(message.data as string) as BoardEvent[];
      const changed: Record<number, 'up' | 'down'> = {};
      for (const event of next) {
        for (const selection of event.selections) {
          const before = previous.current[selection.id];
          if (before !== undefined && before !== selection.odds) changed[selection.id] = selection.odds > before ? 'up' : 'down';
          previous.current[selection.id] = selection.odds;
        }
      }
      setMoves(changed);
      setBoard(next);
    };
    return () => source.close();
  }, []);

  const loadBets = useCallback(async () => {
    try {
      setBets(await api<Bet[]>('/betting/bets', { token }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
    }
  }, [token, onUnauthorized]);

  // Settlement happens on the server when a match ends; refresh the bets and the balance regularly.
  useEffect(() => {
    void loadBets();
    const timer = setInterval(() => {
      void loadBets();
      onCompleted();
    }, 6000);
    return () => clearInterval(timer);
  }, [loadBets, onCompleted]);

  const live = (selectionId: number) => board.flatMap((event) => event.selections).find((s) => s.id === selectionId);

  return (
    <div className="betting">
      <section className="card board">
        <h2>
          Partidos <span className={connected ? 'live-dot on' : 'live-dot'}>{connected ? 'En vivo' : 'Conectando…'}</span>
        </h2>
        {board.map((event) => (
          <article key={event.id} className={`match ${event.status.toLowerCase()}`}>
            <header>
              <span className="muted">{event.league}</span>
              {event.status === 'LIVE' && <span className="badge live">{event.minute}′</span>}
              {event.status === 'SCHEDULED' && <span className="badge pending">Próximo</span>}
              {event.status === 'FINISHED' && <span className="badge neutral">Final</span>}
            </header>
            <div className="teams">
              <span>{event.home}</span>
              <strong className="score">{event.status === 'SCHEDULED' ? 'vs' : `${event.score[0]} – ${event.score[1]}`}</strong>
              <span>{event.away}</span>
            </div>
            <div className="odds">
              {event.selections.map((selection) => (
                <button
                  key={selection.id}
                  type="button"
                  className={`odd ${moves[selection.id] ?? ''} ${pick?.selectionId === selection.id ? 'picked' : ''}`}
                  disabled={selection.suspended}
                  onClick={() =>
                    setPick({
                      eventId: event.id,
                      selectionId: selection.id,
                      code: selection.code,
                      label: selection.code === 'DRAW' ? 'Empate' : selection.code === 'HOME' ? event.home : event.away,
                      match: `${event.home} vs ${event.away}`,
                      odds: selection.odds,
                    })
                  }
                >
                  <small>{PICK_LABEL[selection.code]}</small>
                  {selection.suspended ? '—' : formatOdds(selection.odds)}
                </button>
              ))}
            </div>
          </article>
        ))}
        {board.length === 0 && <p className="muted">Cargando partidos…</p>}
      </section>

      <BetSlip
        pick={pick}
        liveOdds={pick ? live(pick.selectionId)?.odds : undefined}
        token={token}
        onPlaced={() => {
          void loadBets();
          onCompleted();
        }}
        onClear={() => setPick(null)}
        onAcceptOdds={(odds) => pick && setPick({ ...pick, odds })}
        onUnauthorized={onUnauthorized}
      />

      <section className="card wide">
        <h2>Mis apuestas</h2>
        <table>
          <thead>
            <tr>
              <th>Partido</th>
              <th>Pronóstico</th>
              <th className="num">Cuota</th>
              <th className="num">Apostado</th>
              <th className="num">Pago posible</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {bets.map((bet) => (
              <tr key={bet.id}>
                <td>{bet.match}</td>
                <td>{PICK_LABEL[bet.pick]}</td>
                <td className="num">{formatOdds(bet.odds)}</td>
                <td className="num">{formatCop(bet.stake)}</td>
                <td className="num">{formatCop(bet.potentialPayout)}</td>
                <td>
                  <span className={`badge ${bet.status === 'WON' ? 'confirmed' : bet.status === 'LOST' ? 'failed' : 'pending'}`}>
                    {BET_STATUS_LABELS[bet.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {bets.length === 0 && <p className="muted">Aún no hay apuestas.</p>}
      </section>
    </div>
  );
}

interface SlipProps {
  pick: Pick | null;
  liveOdds?: number;
  token: string;
  onPlaced: () => void;
  onClear: () => void;
  onAcceptOdds: (odds: number) => void;
  onUnauthorized: () => void;
}

function BetSlip({ pick, liveOdds, token, onPlaced, onClear, onAcceptOdds, onUnauthorized }: SlipProps) {
  const [stake, setStake] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  // One key per bet attempt, reset on any change: a retry after a network error never bets twice.
  const pendingKey = useRef<string | null>(null);

  useEffect(() => {
    pendingKey.current = null;
    setResult(null);
  }, [pick?.selectionId, pick?.odds, stake]);

  if (!pick) {
    return (
      <aside className="card slip empty">
        <h2>Boleta</h2>
        <p className="muted">Elige una cuota del tablero para armar la apuesta.</p>
      </aside>
    );
  }

  const moved = liveOdds !== undefined && liveOdds !== pick.odds;
  const amount = Number(stake) || 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    pendingKey.current ??= crypto.randomUUID();
    setBusy(true);
    try {
      const response = await api<{ data: Bet }>('/betting/bets', {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': pendingKey.current },
        body: { selectionId: pick!.selectionId, stake: amount, acceptedOdds: pick!.odds },
      });
      pendingKey.current = null;
      setResult({ kind: 'ok', text: `Apuesta registrada: paga ${formatCop(response.data.potentialPayout)} si acierta.` });
      setStake('');
      onPlaced();
    } catch (err) {
      if (err instanceof ApiError) {
        pendingKey.current = null;
        if (err.status === 401) return onUnauthorized();
        if (err.code === 'ODDS_CHANGED' && typeof err.details?.currentOdds === 'number') {
          onAcceptOdds(err.details.currentOdds / 100);
          setResult({ kind: 'info', text: `La cuota cambió a ${formatOdds(err.details.currentOdds / 100)}. Confirma para apostar.` });
          return;
        }
      }
      setResult({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card slip" onSubmit={submit}>
      <h2>
        Boleta
        <button type="button" className="link" onClick={onClear}>
          Quitar
        </button>
      </h2>
      <div className="pick">
        <span className="muted">{pick.match}</span>
        <strong>{pick.label}</strong>
        <span className="pick-odds">{formatOdds(pick.odds)}</span>
      </div>
      {moved && (
        <p className="alert info">
          La cuota ahora es {formatOdds(liveOdds!)}.{' '}
          <button type="button" className="link" onClick={() => onAcceptOdds(liveOdds!)}>
            Aceptar
          </button>
        </p>
      )}
      <label>
        Valor de la apuesta (COP)
        <input type="number" inputMode="numeric" min={1000} step={1} value={stake} onChange={(e) => setStake(e.target.value)} required />
      </label>
      <div className="chips">
        {QUICK_STAKES.map((value) => (
          <button key={value} type="button" className={amount === value ? 'chip active' : 'chip'} onClick={() => setStake(String(value))}>
            {formatCop(value)}
          </button>
        ))}
      </div>
      <div className="payout">
        <span>Pago posible</span>
        <strong>{formatCop(Math.floor((amount * Math.round(pick.odds * 100)) / 100))}</strong>
      </div>
      {result && <p className={`alert ${result.kind}`}>{result.text}</p>}
      <button type="submit" disabled={busy || amount <= 0}>
        {busy ? 'Registrando…' : `Apostar ${amount ? formatCop(amount) : ''}`}
      </button>
    </form>
  );
}
