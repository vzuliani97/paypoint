import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage, PointOfSale, Sale } from '../api';
import { formatCop, formatDate, STATUS_LABELS } from '../format';

interface PageProps {
  token: string;
  onUnauthorized: () => void;
}

export function AdminPage({ token, onUnauthorized }: PageProps) {
  const [points, setPoints] = useState<PointOfSale[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [posId, setPosId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      setMessage({ kind: 'error', text: errorMessage(err) });
    },
    [onUnauthorized],
  );

  const load = useCallback(async () => {
    try {
      const [posData, saleData] = await Promise.all([
        api<PointOfSale[]>('/pos', { token }),
        api<Sale[]>('/sales', { token }),
      ]);
      setPoints(posData);
      setSales(saleData);
    } catch (err) {
      handleError(err);
    }
  }, [token, handleError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function credit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      const result = await api<{ balance: number }>(`/pos/${posId}/credits`, {
        method: 'POST',
        token,
        body: { amount: Number(amount), ...(note.trim() ? { note: note.trim() } : {}) },
      });
      setMessage({ kind: 'ok', text: `Saldo acreditado. Nuevo saldo: ${formatCop(result.balance)}.` });
      setAmount('');
      setNote('');
      await load();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  const posName = (id: string) => points.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="grid">
      <section className="card">
        <h2>Puntos de venta</h2>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Saldo</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{formatCop(p.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form className="card" onSubmit={credit}>
        <h2>Acreditar saldo</h2>
        <label>
          Punto de venta
          <select value={posId} onChange={(e) => setPosId(e.target.value)} required>
            <option value="" disabled>
              Selecciona un punto de venta
            </option>
            {points.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Valor (COP)
          <input type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <label>
          Nota (opcional)
          <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Consignación bancaria" />
        </label>
        {message && <p className={`alert ${message.kind}`}>{message.text}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Acreditando…' : 'Acreditar'}
        </button>
      </form>

      <section className="card wide">
        <h2>Ventas de toda la red</h2>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Punto de venta</th>
              <th>Producto</th>
              <th>Canal</th>
              <th>Valor</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {sales.map((sale) => (
              <tr key={sale.id}>
                <td>{formatDate(sale.createdAt)}</td>
                <td>{posName(sale.posId)}</td>
                <td>{sale.productName}</td>
                <td>{sale.channel === 'PARTNER' ? 'Integrador' : 'Portal'}</td>
                <td>{formatCop(sale.amount)}</td>
                <td>
                  <span className={`badge ${sale.status.toLowerCase()}`}>{STATUS_LABELS[sale.status]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sales.length === 0 && <p className="muted">Aún no hay ventas.</p>}
      </section>
    </div>
  );
}
