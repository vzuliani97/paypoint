import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, Bet, BoardEvent, errorMessage, Market, PickCode, Sport } from '../api';
import { BET_STATUS_LABELS, formatCop, formatOdds } from '../format';

interface Props {
  token: string;
  onCompleted: () => void;
  onUnauthorized: () => void;
}

type Pick = { eventId: number; selectionId: number; market: Market; code: PickCode; label: string; marketLabel: string; match: string; odds: number };
type Filter = 'LIVE' | 'SCHEDULED' | 'FINISHED';
type Selection = BoardEvent['selections'][number];

const SPORTS: Record<Sport, { label: string; icon: string; unit: string; length: number }> = {
  FUTBOL: { label: 'Fútbol', icon: '⚽', unit: 'goles', length: 90 },
  BALONCESTO: { label: 'Baloncesto', icon: '🏀', unit: 'puntos', length: 48 },
  BEISBOL: { label: 'Béisbol', icon: '⚾', unit: 'carreras', length: 54 },
  HOCKEY: { label: 'Hockey', icon: '🏒', unit: 'goles', length: 60 },
};
const twoWay = (event: BoardEvent) => !event.selections.some((selection) => selection.code === 'DRAW');

/** The 1, X and 2 columns of the board; a two-way sport leaves the middle one empty. */
function matchSlots(event: BoardEvent): Array<BoardEvent['selections'][number] | null> {
  const match = event.selections.filter((selection) => selection.market === 'MATCH');
  const find = (code: PickCode) => match.find((selection) => selection.code === code) ?? null;
  return [find('HOME'), find('DRAW'), find('AWAY')];
}

/** The clock as each sport reads it: minutes, quarters with overtime, or innings (top ▲ and bottom ▼). */
function clock(event: BoardEvent): string {
  const { sport, minute } = event;
  if (sport === 'BALONCESTO') return minute > 48 ? 'Prórroga' : `C${Math.min(4, Math.floor((Math.max(1, minute) - 1) / 12) + 1)} · ${minute}′`;
  if (sport === 'BEISBOL') {
    const out = Math.max(1, minute) - 1;
    return `${out % 6 < 3 ? '▲' : '▼'}${Math.floor(out / 6) + 1}`;
  }
  return `${minute}′`;
}

const marketLabel = (market: Market, event: { sport: Sport; totalLine: number; twoWay?: boolean }) =>
  ({
    MATCH: event.twoWay ? 'Ganador' : 'Resultado del partido',
    DOUBLE: 'Doble oportunidad',
    GOALS: `Total de ${SPORTS[event.sport].unit} ${event.totalLine}`,
    BTTS: 'Ambos equipos marcan',
  })[market];
const SHORT_LABEL: Record<PickCode, string> = {
  HOME: '1',
  DRAW: 'X',
  AWAY: '2',
  '1X': '1X',
  '12': '12',
  X2: 'X2',
  OVER: 'Más',
  UNDER: 'Menos',
  YES: 'Sí',
  NO: 'No',
};
const pickName = (code: PickCode, event: { home: string; away: string; sport: Sport; totalLine: number }) =>
  ({
    HOME: event.home,
    DRAW: 'Empate',
    AWAY: event.away,
    '1X': `${event.home} o empate`,
    '12': `${event.home} o ${event.away}`,
    X2: `Empate o ${event.away}`,
    OVER: `Más de ${event.totalLine} ${SPORTS[event.sport].unit}`,
    UNDER: `Menos de ${event.totalLine} ${SPORTS[event.sport].unit}`,
    YES: 'Sí',
    NO: 'No',
  })[code];
const DETAIL_TABS: Array<[string, string, Market[]]> = [
  ['ALL', 'Todos', ['MATCH', 'DOUBLE', 'GOALS', 'BTTS']],
  ['MAIN', 'Principales', ['MATCH', 'DOUBLE']],
  ['GOALS', 'Totales', ['GOALS', 'BTTS']],
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
  const [sport, setSport] = useState<Sport | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const open = board.find((event) => event.id === openId) ?? null;
  const choose = (event: BoardEvent, selection: Selection) =>
    setPick({
      eventId: event.id,
      selectionId: selection.id,
      market: selection.market,
      code: selection.code,
      label: pickName(selection.code, event),
      marketLabel: marketLabel(selection.market, { ...event, twoWay: twoWay(event) }),
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
  const sports = useMemo(() => {
    const totals = new Map<Sport, number>();
    for (const event of board) if (event.status === filter) totals.set(event.sport, (totals.get(event.sport) ?? 0) + 1);
    return (Object.keys(SPORTS) as Sport[]).map((code) => [code, totals.get(code) ?? 0] as const);
  }, [board, filter]);
  const leagues = useMemo(() => {
    const totals = new Map<string, number>();
    for (const event of board) {
      if (event.status === filter && (!sport || event.sport === sport)) totals.set(event.league, (totals.get(event.league) ?? 0) + 1);
    }
    return [...totals.entries()];
  }, [board, filter, sport]);
  const visible = board.filter((event) => event.status === filter && (!sport || event.sport === sport) && (!league || event.league === league));
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
        <button
          type="button"
          className={sport === null ? 'sb-sport active' : 'sb-sport'}
          onClick={() => {
            setSport(null);
            setLeague(null);
          }}
        >
          <span aria-hidden="true">🏆</span> Todos <span className="sb-count">{sports.reduce((sum, [, n]) => sum + n, 0)}</span>
        </button>
        {sports.map(([code, total]) => (
          <button
            key={code}
            type="button"
            className={sport === code ? 'sb-sport active' : 'sb-sport'}
            onClick={() => {
              setSport(code);
              setLeague(null);
            }}
          >
            <span aria-hidden="true">{SPORTS[code].icon}</span> {SPORTS[code].label} <span className="sb-count">{total}</span>
          </button>
        ))}
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
          <EventDetail event={open} moves={moves} scored={Boolean(goals[open.id])} pickedId={pick?.selectionId} onPick={(selection) => choose(open, selection)} onBack={() => setOpenId(null)} />
        ) : (
          <>
        <div className="sb-hero">
          <div>
            <span className={connected ? 'sb-live on' : 'sb-live'}>{connected ? 'EN VIVO' : 'Conectando…'}</span>
            <h2>Apuestas deportivas</h2>
            <p>Cuotas en tiempo real. Feed simulado: los datos de producción son confidenciales.</p>
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
              <span>
                <span aria-hidden="true">{SPORTS[events[0].sport].icon}</span> {name}
              </span>
              <span className="sb-cols" aria-hidden="true">
                <span>1</span>
                <span>{twoWay(events[0]) ? '' : 'X'}</span>
                <span>2</span>
                <span />
              </span>
            </div>
            {events.map((event) => (
              <article key={event.id} className={goals[event.id] ? 'sb-event goal' : 'sb-event'}>
                <div className="sb-time">
                  {event.status === 'LIVE' && <span className="sb-minute">{clock(event)}</span>}
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
                  {matchSlots(event).map((selection, slot) =>
                    selection === null ? (
                      <span key={`gap-${slot}`} className="sb-odd-gap" aria-hidden="true" />
                    ) : (
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
                    ),
                  )}
                  <button type="button" className="sb-more" onClick={() => setOpenId(event.id)} aria-label="Ver todos los mercados">
                    +{event.selections.length - (twoWay(event) ? 2 : 3)}
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
                    {SHORT_LABEL[bet.pick]}
                    {(bet.pick === 'OVER' || bet.pick === 'UNDER') && ` ${bet.totalLine}`} · {formatOdds(bet.odds)}
                  </strong>
                  <span className={`sb-status ${bet.status.toLowerCase()}`}>{BET_STATUS_LABELS[bet.status]}</span>
                </div>
                <span className="sb-muted">
                  {marketLabel(bet.market, bet)} · {bet.match}
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
            {pick.marketLabel}
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
    .filter((word) => word.length > 3)
    .slice(0, 2)
    .map((word) => word[0])
    .join(''),
  hue: [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360,
});

interface DetailProps {
  event: BoardEvent;
  moves: Record<number, 'up' | 'down'>;
  scored: boolean;
  pickedId?: number;
  onPick: (selection: Selection) => void;
  onBack: () => void;
}

/** One match with every market, like the event page of a sportsbook. */
function EventDetail({ event, moves, scored, pickedId, onPick, onBack }: DetailProps) {
  const [tab, setTab] = useState('ALL');
  const markets = DETAIL_TABS.find(([id]) => id === tab)![2];
  const progress = event.status === 'FINISHED' ? 100 : Math.min(100, Math.round((event.minute / SPORTS[event.sport].length) * 100));
  const state = event.status === 'LIVE' ? `${clock(event)} · En vivo` : event.status === 'FINISHED' ? 'Final' : `Inicia ${kickoff.format(new Date(event.startsAt))}`;

  return (
    <div className="sb-detail">
      <button type="button" className="sb-back" onClick={onBack}>
        ← Todos los partidos
      </button>
      <div className="sb-scoreboard">
        <span className="sb-detail-league">
          {SPORTS[event.sport].icon} {SPORTS[event.sport].label} · {event.league}
        </span>
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
        <LiveTracker event={event} scored={scored} />
        <p className="sb-muted">En tiempo real con un feed simulado: los datos de producción son confidenciales.</p>
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
            <h4>{marketLabel(market, { ...event, twoWay: twoWay(event) })}</h4>
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

const SCORE_WORD: Record<Sport, string> = { FUTBOL: '¡GOL!', BALONCESTO: '¡CANASTA!', BEISBOL: '¡CARRERA!', HOCKEY: '¡GOL!' };

/** The playing surface of each sport, drawn in a 400 x 220 box. */
function Surface({ sport }: { sport: Sport }) {
  if (sport === 'BALONCESTO') {
    return (
      <g>
        <rect width="400" height="220" fill="#c98a4b" />
        <rect x="10" y="10" width="380" height="200" fill="none" stroke="#fff6" strokeWidth="2" />
        <line x1="200" y1="10" x2="200" y2="210" stroke="#fff6" strokeWidth="2" />
        <circle cx="200" cy="110" r="26" fill="none" stroke="#fff6" strokeWidth="2" />
        <rect x="10" y="80" width="70" height="60" fill="#a8663066" stroke="#fff6" strokeWidth="2" />
        <rect x="320" y="80" width="70" height="60" fill="#a8663066" stroke="#fff6" strokeWidth="2" />
        <path d="M10 30 A 95 95 0 0 1 10 190" transform="translate(28 0)" fill="none" stroke="#fff6" strokeWidth="2" />
        <path d="M390 30 A 95 95 0 0 0 390 190" transform="translate(-28 0)" fill="none" stroke="#fff6" strokeWidth="2" />
        <circle cx="26" cy="110" r="6" fill="none" stroke="#ff7a00" strokeWidth="3" />
        <circle cx="374" cy="110" r="6" fill="none" stroke="#ff7a00" strokeWidth="3" />
      </g>
    );
  }
  if (sport === 'BEISBOL') {
    return (
      <g>
        <rect width="400" height="220" fill="#2f7d3b" />
        <path d="M200 205 L70 80 A 185 185 0 0 1 330 80 Z" fill="#3b9147" />
        <path d="M200 200 L130 130 L200 60 L270 130 Z" fill="#b5835a" />
        <path d="M200 185 L145 130 L200 75 L255 130 Z" fill="#3b9147" />
        {[
          [200, 200],
          [270, 130],
          [200, 60],
          [130, 130],
        ].map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x - 5} y={y - 5} width="10" height="10" fill="#fff" transform={`rotate(45 ${x} ${y})`} />
        ))}
        <circle cx="200" cy="130" r="7" fill="#b5835a" />
      </g>
    );
  }
  if (sport === 'HOCKEY') {
    return (
      <g>
        <rect width="400" height="220" rx="60" fill="#eef4fb" />
        <rect x="4" y="4" width="392" height="212" rx="58" fill="none" stroke="#9fb3c8" strokeWidth="3" />
        <line x1="200" y1="4" x2="200" y2="216" stroke="#d62839" strokeWidth="4" />
        <line x1="140" y1="4" x2="140" y2="216" stroke="#1d4ed8" strokeWidth="4" />
        <line x1="260" y1="4" x2="260" y2="216" stroke="#1d4ed8" strokeWidth="4" />
        <line x1="32" y1="4" x2="32" y2="216" stroke="#d62839" strokeWidth="2" />
        <line x1="368" y1="4" x2="368" y2="216" stroke="#d62839" strokeWidth="2" />
        <circle cx="200" cy="110" r="22" fill="none" stroke="#1d4ed8" strokeWidth="2" />
        <path d="M32 96 A 14 14 0 0 1 32 124" fill="#93c5fd" />
        <path d="M368 96 A 14 14 0 0 0 368 124" fill="#93c5fd" />
      </g>
    );
  }
  return (
    <g>
      <rect width="400" height="220" fill="#2e8b3d" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((stripe) => (
        <rect key={stripe} x={stripe * 50} width="25" height="220" fill="#ffffff10" />
      ))}
      <rect x="10" y="10" width="380" height="200" fill="none" stroke="#fffb" strokeWidth="2" />
      <line x1="200" y1="10" x2="200" y2="210" stroke="#fffb" strokeWidth="2" />
      <circle cx="200" cy="110" r="28" fill="none" stroke="#fffb" strokeWidth="2" />
      <rect x="10" y="62" width="56" height="96" fill="none" stroke="#fffb" strokeWidth="2" />
      <rect x="334" y="62" width="56" height="96" fill="none" stroke="#fffb" strokeWidth="2" />
      <rect x="10" y="88" width="20" height="44" fill="none" stroke="#fffb" strokeWidth="2" />
      <rect x="370" y="88" width="20" height="44" fill="none" stroke="#fffb" strokeWidth="2" />
      <rect x="2" y="96" width="8" height="28" fill="#fff" />
      <rect x="390" y="96" width="8" height="28" fill="#fff" />
    </g>
  );
}

/**
 * A live-tracker style view of the event. Score, clock and the scoring flash come from the feed; the moving
 * ball is only an animation, labeled as such, because the simulated feed has no play-by-play positions.
 */
function LiveTracker({ event, scored }: { event: BoardEvent; scored: boolean }) {
  const live = event.status === 'LIVE';
  return (
    <figure className={`sb-tracker ${event.sport.toLowerCase()}`} aria-label={`Visualización de ${SPORTS[event.sport].label}: ${event.home} ${event.score[0]}, ${event.away} ${event.score[1]}`}>
      <svg viewBox="0 0 400 220" role="presentation">
        <Surface sport={event.sport} />
        {live && <circle className="sb-tracker-ball" cx="200" cy="110" r={event.sport === 'BALONCESTO' ? 7 : 5} />}
      </svg>
      <figcaption>
        <span className="sb-tracker-team">{event.home}</span>
        <strong>
          {event.score[0]} - {event.score[1]}
        </strong>
        <span className="sb-tracker-team">{event.away}</span>
      </figcaption>
      <span className="sb-tracker-tag">{live ? `${clock(event)} · Visualización` : event.status === 'FINISHED' ? 'Final' : 'Por iniciar'}</span>
      {scored && <span className="sb-tracker-flash">{SCORE_WORD[event.sport]}</span>}
    </figure>
  );
}
