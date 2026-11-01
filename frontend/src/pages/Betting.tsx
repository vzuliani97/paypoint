import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, Bet, BoardEvent, errorMessage } from '../api';
import { BET_STATUS_LABELS, formatCop, formatOdds } from '../format';

interface Props {
  token: string;
  onCompleted: () => void;
  onUnauthorized: () => void;
}

type Pick = { eventId: number; selectionId: number; code: 'HOME' | 'DRAW' | 'AWAY'; label: string; match: string; odds: number };
type Filter = 'LIVE' | 'SCHEDULED' | 'FINISHED';

const PICK_LABEL = { HOME: '1', DRAW: 'X', AWAY: '2' } as const;
const QUICK_STAKES = [2_000, 5_000, 10_000, 20_000, 50_000];
const FILTERS: Array<[Filter, string]> = [
  ['LIVE', 'En vivo'],
  ['SCHEDULED', 'Próximos'],
  ['FINISHED', 'Finalizados'],
];
const kickoff = new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit' });

export function LiveBetting({ token, onCompleted, onUnauthorized }: Props) {
  const [board, setBoard] = useState<BoardEvent[]>([]);
  const [connected, setConnected] = useState(false);
  // Last price and score seen, to show what moved since the previous update.
  const [moves, setMoves] = useState<Record<number, 'up' | 'down'>>({});
  const [goals, setGoals] = useState<Record<number, boolean>>({});
  const previousOdds = useRef<Record<number, number>>({});
  const previousScore = useRef<Record<number, string>>({});
  const [bets, setBets] = useState<Bet[]>([]);
  const [pick, setPick] = useState<Pick | null>(null);
  const [filter, setFilter] = useState<Filter>('LIVE');
  const [league, setLeague] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource('/api/betting/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      const next = JSON.parse(message.data as string) as BoardEvent[];
      const changed: Record<number, 'up' | 'down'> = {};
      const scored: Record<number, boolean> = {};
      for (const event of next) {
        const score = event.score.join('-');
        if (previousScore.current[event.id] !== undefined && previousScore.current[event.id] !== score) scored[event.id] = true;
        previousScore.current[event.id] = score;
        for (const selection of event.selections) {
          const before = previousOdds.current[selection.id];
          if (before !== undefined && before !== selection.odds) changed[selection.id] = selection.odds > before ? 'up' : 'down';
          previousOdds.current[selection.id] = selection.odds;
        }
      }
      setMoves(changed);
      setGoals(scored);
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

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map(([status]) => [status, board.filter((event) => event.status === status).length])) as Record<Filter, number>,
    [board],
  );
  const leagues = useMemo(() => {
    const totals = new Map<string, number>();
    for (const event of board) if (event.status === filter) totals.set(event.league, (totals.get(event.league) ?? 0) + 1);
    return [...totals.entries()];
  }, [board, filter]);
  const visible = board.filter((event) => event.status === filter && (!league || event.league === league));
  const grouped = useMemo(() => {
    const groups = new Map<string, BoardEvent[]>();
    for (const event of visible) groups.set(event.league, [...(groups.get(event.league) ?? []), event]);
    return [...groups.entries()];
  }, [visible]);
  const live = (selectionId: number) => board.flatMap((event) => event.selections).find((s) => s.id === selectionId);

  return (
    <div className="sportsbook">
      <aside className="sb-menu" aria-label="Deportes y ligas">
        <p className="sb-label">Deportes</p>
        <button type="button" className="sb-sport active">
          <span aria-hidden="true">⚽</span> Fútbol <span className="sb-count">{board.length}</span>
        </button>
        <p className="sb-label">Ligas</p>
        <button type="button" className={league === null ? 'sb-league active' : 'sb-league'} onClick={() => setLeague(null)}>
          Todas <span className="sb-count">{leagues.reduce((sum, [, n]) => sum + n, 0)}</span>
        </button>
        {leagues.map(([name, total]) => (
          <button key={name} type="button" className={league === name ? 'sb-league active' : 'sb-league'} onClick={() => setLeague(name)}>
            {name} <span className="sb-count">{total}</span>
          </button>
        ))}
      </aside>

      <section className="sb-board" aria-label="Partidos">
        <div className="sb-hero">
          <div>
            <span className={connected ? 'sb-live on' : 'sb-live'}>{connected ? 'EN VIVO' : 'Conectando…'}</span>
            <h2>Apuestas deportivas</h2>
            <p>Cuotas que se actualizan en tiempo real. Datos ficticios de demostración.</p>
          </div>
          <strong className="sb-hero-count">{counts.LIVE}</strong>
        </div>

        <div className="sb-filters" role="tablist" aria-label="Estado del partido">
          {FILTERS.map(([status, label]) => (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={filter === status}
              onClick={() => {
                setFilter(status);
                setLeague(null);
              }}
            >
              {label} <span className="sb-count">{counts[status]}</span>
            </button>
          ))}
        </div>

        {grouped.map(([name, events]) => (
          <div key={name} className="sb-group">
            <div className="sb-group-head">
              <span>{name}</span>
              <span className="sb-cols" aria-hidden="true">
                <span>1</span>
                <span>X</span>
                <span>2</span>
              </span>
            </div>
            {events.map((event) => (
              <article key={event.id} className={goals[event.id] ? 'sb-event goal' : 'sb-event'}>
                <div className="sb-time">
                  {event.status === 'LIVE' && <span className="sb-minute">{event.minute}′</span>}
                  {event.status === 'SCHEDULED' && <span>{kickoff.format(new Date(event.startsAt))}</span>}
                  {event.status === 'FINISHED' && <span>Final</span>}
                </div>
                <div className="sb-teams">
                  <span>{event.home}</span>
                  <span>{event.away}</span>
                </div>
                <div className="sb-score" aria-label={event.status === 'SCHEDULED' ? 'Sin iniciar' : `Marcador ${event.score[0]} a ${event.score[1]}`}>
                  {event.status !== 'SCHEDULED' && (
                    <>
                      <span>{event.score[0]}</span>
                      <span>{event.score[1]}</span>
                    </>
                  )}
                </div>
                <div className="sb-odds">
                  {event.selections.map((selection) => (
                    <button
                      key={selection.id}
                      type="button"
                      className={`sb-odd ${moves[selection.id] ?? ''} ${pick?.selectionId === selection.id ? 'picked' : ''}`}
                      disabled={selection.suspended}
                      aria-label={`${PICK_LABEL[selection.code]} ${selection.suspended ? 'suspendida' : formatOdds(selection.odds)}`}
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
                      {selection.suspended ? '🔒' : formatOdds(selection.odds)}
                      {moves[selection.id] && <span className="sb-arrow" aria-hidden="true">{moves[selection.id] === 'up' ? '▲' : '▼'}</span>}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ))}
        {visible.length === 0 && <p className="sb-empty">{board.length === 0 ? 'Cargando partidos…' : 'No hay partidos en esta vista.'}</p>}
      </section>

      <div className="sb-side">
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
        <section className="sb-card">
          <h3>Mis apuestas</h3>
          {bets.length === 0 && <p className="sb-muted">Aún no hay apuestas.</p>}
          <ul className="sb-bets">
            {bets.slice(0, 8).map((bet) => (
              <li key={bet.id}>
                <div>
                  <strong>
                    {PICK_LABEL[bet.pick]} · {formatOdds(bet.odds)}
                  </strong>
                  <span className="sb-muted">{bet.match}</span>
                </div>
                <div className="sb-bet-right">
                  <span className={`sb-status ${bet.status.toLowerCase()}`}>{BET_STATUS_LABELS[bet.status]}</span>
                  <span>
                    {formatCop(bet.stake)} → {formatCop(bet.potentialPayout)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
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
      <section className="sb-card sb-slip">
        <h3>Cupón de apuesta</h3>
        <p className="sb-muted">Toca una cuota para agregarla al cupón.</p>
      </section>
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
    <form className="sb-card sb-slip" onSubmit={submit}>
      <h3>
        Cupón de apuesta
        <button type="button" className="sb-link" onClick={onClear}>
          Limpiar
        </button>
      </h3>
      <div className="sb-pick">
        <div>
          <span className="sb-muted">{pick.match}</span>
          <strong>{pick.label}</strong>
          <span className="sb-muted">Resultado del partido · {PICK_LABEL[pick.code]}</span>
        </div>
        <span className="sb-pick-odds">{formatOdds(pick.odds)}</span>
      </div>
      {moved && (
        <p className="sb-alert">
          La cuota ahora es {formatOdds(liveOdds!)}.{' '}
          <button type="button" className="sb-link" onClick={() => onAcceptOdds(liveOdds!)}>
            Aceptar cambio
          </button>
        </p>
      )}
      <label className="sb-stake">
        Valor de la apuesta
        <input type="number" inputMode="numeric" min={1000} step={1} value={stake} onChange={(e) => setStake(e.target.value)} required />
      </label>
      <div className="sb-chips">
        {QUICK_STAKES.map((value) => (
          <button key={value} type="button" className={amount === value ? 'active' : ''} onClick={() => setStake(String(value))}>
            {formatCop(value)}
          </button>
        ))}
      </div>
      <div className="sb-payout">
        <span>Ganancia posible</span>
        <strong>{formatCop(Math.floor((amount * Math.round(pick.odds * 100)) / 100))}</strong>
      </div>
      {result && <p className={`sb-result ${result.kind}`}>{result.text}</p>}
      <button type="submit" className="sb-submit" disabled={busy || amount <= 0}>
        {busy ? 'Registrando…' : `Apostar ${amount ? formatCop(amount) : ''}`}
      </button>
    </form>
  );
}
