import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, Bet, BoardEvent, errorMessage, Market, PickCode } from '../api';
import { BET_STATUS_LABELS, formatCop, formatOdds } from '../format';

interface Props {
  token: string;
  onCompleted: () => void;
  onUnauthorized: () => void;
}

type Pick = { eventId: number; selectionId: number; market: Market; code: PickCode; label: string; match: string; odds: number };
type Filter = 'LIVE' | 'SCHEDULED' | 'FINISHED';
type Selection = BoardEvent['selections'][number];

const MARKET_LABEL: Record<Market, string> = {
  MATCH: 'Resultado del partido',
  DOUBLE: 'Doble oportunidad',
  GOALS: 'Total de goles 2.5',
  BTTS: 'Ambos equipos marcan',
};
const SHORT_LABEL: Record<PickCode, string> = {
  HOME: '1',
  DRAW: 'X',
  AWAY: '2',
  '1X': '1X',
  '12': '12',
  X2: 'X2',
  OVER: 'Más 2.5',
  UNDER: 'Menos 2.5',
  YES: 'Sí',
  NO: 'No',
};
const pickName = (code: PickCode, event: { home: string; away: string }) =>
  ({
    HOME: event.home,
    DRAW: 'Empate',
    AWAY: event.away,
    '1X': `${event.home} o empate`,
    '12': `${event.home} o ${event.away}`,
    X2: `Empate o ${event.away}`,
    OVER: 'Más de 2.5 goles',
    UNDER: 'Menos de 2.5 goles',
    YES: 'Sí',
    NO: 'No',
  })[code];
const DETAIL_TABS: Array<[string, string, Market[]]> = [
  ['ALL', 'Todos', ['MATCH', 'DOUBLE', 'GOALS', 'BTTS']],
  ['MAIN', 'Principales', ['MATCH', 'DOUBLE']],
  ['GOALS', 'Goles', ['GOALS', 'BTTS']],
];
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
  const [openId, setOpenId] = useState<number | null>(null);
  const open = board.find((event) => event.id === openId) ?? null;
  const choose = (event: BoardEvent, selection: Selection) =>
    setPick({
      eventId: event.id,
      selectionId: selection.id,
      market: selection.market,
      code: selection.code,
      label: pickName(selection.code, event),
      match: `${event.home} vs ${event.away}`,
      odds: selection.odds,
    });

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
        {open ? (
          <EventDetail event={open} moves={moves} pickedId={pick?.selectionId} onPick={(selection) => choose(open, selection)} onBack={() => setOpenId(null)} />
        ) : (
          <>
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
                <button type="button" className="sb-teams" onClick={() => setOpenId(event.id)} aria-label={`Ver todos los mercados de ${event.home} vs ${event.away}`}>
                  <span>{event.home}</span>
                  <span>{event.away}</span>
                </button>
                <div className="sb-score" aria-label={event.status === 'SCHEDULED' ? 'Sin iniciar' : `Marcador ${event.score[0]} a ${event.score[1]}`}>
                  {event.status !== 'SCHEDULED' && (
                    <>
                      <span>{event.score[0]}</span>
                      <span>{event.score[1]}</span>
                    </>
                  )}
                </div>
                <div className="sb-odds">
                  {event.selections.filter((selection) => selection.market === 'MATCH').map((selection) => (
                    <button
                      key={selection.id}
                      type="button"
                      className={`sb-odd ${moves[selection.id] ?? ''} ${pick?.selectionId === selection.id ? 'picked' : ''}`}
                      disabled={selection.suspended}
                      aria-label={`${SHORT_LABEL[selection.code]} ${selection.suspended ? 'suspendida' : formatOdds(selection.odds)}`}
                      onClick={() => choose(event, selection)}
                    >
                      {selection.suspended ? '🔒' : formatOdds(selection.odds)}
                      {moves[selection.id] && <span className="sb-arrow" aria-hidden="true">{moves[selection.id] === 'up' ? '▲' : '▼'}</span>}
                    </button>
                  ))}
                  <button type="button" className="sb-more" onClick={() => setOpenId(event.id)} aria-label="Ver todos los mercados">
                    +{event.selections.length - 3}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ))}
        {visible.length === 0 && <p className="sb-empty">{board.length === 0 ? 'Cargando partidos…' : 'No hay partidos en esta vista.'}</p>}
          </>
        )}
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
          <ul className="sb-bets" tabIndex={0} aria-label="Mis apuestas">
            {bets.slice(0, 8).map((bet) => (
              <li key={bet.id}>
                <div className="sb-bet-top">
                  <strong>
                    {SHORT_LABEL[bet.pick]} · {formatOdds(bet.odds)}
                  </strong>
                  <span className={`sb-status ${bet.status.toLowerCase()}`}>{BET_STATUS_LABELS[bet.status]}</span>
                </div>
                <span className="sb-muted">
                  {MARKET_LABEL[bet.market]} · {bet.match}
                </span>
                <span className="sb-bet-amounts">
                  {formatCop(bet.stake)} → {formatCop(bet.potentialPayout)}
                </span>
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
          <span className="sb-muted">
            {MARKET_LABEL[pick.market]} · {SHORT_LABEL[pick.code]}
          </span>
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

// Two letters on a colored badge, so each fictitious club is recognizable without a logo.
const crest = (name: string) => ({
  initials: name
    .split(' ')
    .filter((word) => word.length > 2)
    .slice(0, 2)
    .map((word) => word[0])
    .join(''),
  hue: [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360,
});

interface DetailProps {
  event: BoardEvent;
  moves: Record<number, 'up' | 'down'>;
  pickedId?: number;
  onPick: (selection: Selection) => void;
  onBack: () => void;
}

/** One match with every market, like the event page of a sportsbook. */
function EventDetail({ event, moves, pickedId, onPick, onBack }: DetailProps) {
  const [tab, setTab] = useState('ALL');
  const markets = DETAIL_TABS.find(([id]) => id === tab)![2];
  const progress = event.status === 'FINISHED' ? 100 : Math.round((event.minute / 90) * 100);
  const state = event.status === 'LIVE' ? `${event.minute}′ · En vivo` : event.status === 'FINISHED' ? 'Final' : `Inicia ${kickoff.format(new Date(event.startsAt))}`;

  return (
    <div className="sb-detail">
      <button type="button" className="sb-back" onClick={onBack}>
        ← Todos los partidos
      </button>
      <div className="sb-scoreboard">
        <span className="sb-detail-league">{event.league}</span>
        <div className="sb-score-row">
          {[event.home, event.away].map((team, index) => {
            const { initials, hue } = crest(team);
            return (
              <div key={team} className={`sb-team ${index === 1 ? 'away' : ''}`}>
                <span className="sb-crest" style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 40) % 360} 70% 30%))` }} aria-hidden="true">
                  {initials}
                </span>
                <strong>{team}</strong>
              </div>
            );
          })}
          <div className="sb-big-score" aria-label={event.status === 'SCHEDULED' ? 'Sin iniciar' : `Marcador ${event.score[0]} a ${event.score[1]}`}>
            {event.status === 'SCHEDULED' ? 'vs' : `${event.score[0]} - ${event.score[1]}`}
            <span className={event.status === 'LIVE' ? 'sb-state live' : 'sb-state'}>{state}</span>
          </div>
        </div>
        <div className="sb-progress" role="progressbar" aria-label="Tiempo jugado" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <p className="sb-muted">Datos ficticios de demostración: los goles y las cuotas salen de una simulación.</p>
      </div>

      <div className="sb-filters" role="tablist" aria-label="Mercados">
        {DETAIL_TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {markets.map((market) => {
        const selections = event.selections.filter((selection) => selection.market === market);
        if (selections.length === 0) return null;
        return (
          <section key={market} className="sb-market">
            <h4>{MARKET_LABEL[market]}</h4>
            <div className={`sb-market-odds n${selections.length}`}>
              {selections.map((selection) => (
                <button
                  key={selection.id}
                  type="button"
                  className={`sb-odd wide ${moves[selection.id] ?? ''} ${pickedId === selection.id ? 'picked' : ''}`}
                  disabled={selection.suspended || event.status === 'FINISHED'}
                  onClick={() => onPick(selection)}
                >
                  <span>{pickName(selection.code, event)}</span>
                  <strong>
                    {selection.suspended ? '🔒' : formatOdds(selection.odds)}
                    {moves[selection.id] && <span className="sb-arrow" aria-hidden="true">{moves[selection.id] === 'up' ? '▲' : '▼'}</span>}
                  </strong>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
