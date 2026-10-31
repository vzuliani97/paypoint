import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage, Movement, PointOfSale, Product, Sale } from '../api';
import { formatCop, formatDate, MOVEMENT_LABELS, STATUS_LABELS } from '../format';
import { LiveBetting } from './Betting';
import { Casino } from './Casino';

const TABS = [
  ['topups', 'Recargas'],
  ['betting', 'Apuestas en vivo'],
  ['casino', 'Casino'],
] as const;

interface PageProps {
  token: string;
  onUnauthorized: () => void;
}

export function CashierPage({ token, onUnauthorized }: PageProps) {
  const [pos, setPos] = useState<PointOfSale | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('topups');

  const load = useCallback(async () => {
    try {
      const [posData, productData, saleData, movementData] = await Promise.all([
        api<PointOfSale>('/pos/me', { token }),
        api<Product[]>('/products', { token }),
        api<Sale[]>('/sales', { token }),
        api<Movement[]>('/pos/me/movements', { token }),
      ]);
      setPos(posData);
      setProducts(productData);
      setSales(saleData);
      setMovements(movementData);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      setError(errorMessage(err));
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="cashier-top">
      <section className="card balance">
          <div>
            <span className="muted">{pos?.name ?? 'Punto de venta'} · Saldo disponible</span>
            <div className="amount">{pos ? formatCop(pos.balance) : '—'}</div>
          </div>
          <div className="stats">
            <div className="stat">
              <strong>{sales.filter((sale) => sale.status === 'CONFIRMED').length}</strong>
              <span>Confirmadas</span>
            </div>
            <div className="stat">
              <strong>{sales.filter((sale) => sale.status === 'PENDING').length}</strong>
              <span>En verificación</span>
            </div>
            <div className="stat">
              <strong>{sales.filter((sale) => sale.status === 'FAILED').length}</strong>
              <span>Reembolsadas</span>
            </div>
          </div>
        </section>
        <nav className="section-tabs" aria-label="Secciones de la caja">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
      </div>

      {error && <p className="alert error">{error}</p>}

      {tab === 'topups' && (
        <div className="grid">
          <SellForm products={products} token={token} onCompleted={load} onUnauthorized={onUnauthorized} />
      <section className="card wide">
            <h2>Ventas recientes</h2>
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Producto</th>
                  <th>Destino</th>
                  <th className="num">Valor</th>
                  <th>Estado</th>
                  <th>Referencia</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((sale) => (
                  <tr key={sale.id}>
                    <td>{formatDate(sale.createdAt)}</td>
                    <td>{sale.productName}</td>
                    <td>{sale.destination}</td>
                    <td className="num">{formatCop(sale.amount)}</td>
                    <td>
                      <span className={`badge ${sale.status.toLowerCase()}`}>{STATUS_LABELS[sale.status]}</span>
                    </td>
                    <td>{sale.providerReference ?? sale.failureReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sales.length === 0 && <p className="muted">Aún no hay ventas.</p>}
          </section>
        </div>
      )}
      {tab === 'betting' && <LiveBetting token={token} onCompleted={load} onUnauthorized={onUnauthorized} />}
      {tab === 'casino' && <Casino token={token} onCompleted={load} onUnauthorized={onUnauthorized} />}

      <div className="grid" style={{ marginTop: '1.25rem' }}>
      <section className="card wide">
          <h2>Movimientos de saldo</h2>
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th className="num">Valor</th>
                <th className="num">Saldo después</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{formatDate(movement.createdAt)}</td>
                  <td>{MOVEMENT_LABELS[movement.type]}</td>
                  <td className={`num ${movement.amount < 0 ? 'negative' : 'positive'}`}>
                    {movement.amount > 0 ? '+' : ''}
                    {formatCop(movement.amount)}
                  </td>
                  <td className="num">{formatCop(movement.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

const QUICK_AMOUNTS = [2_000, 5_000, 10_000, 20_000, 50_000];

interface SellFormProps {
  products: Product[];
  token: string;
  onCompleted: () => void;
  onUnauthorized: () => void;
}

function SellForm({ products, token, onCompleted, onUnauthorized }: SellFormProps) {
  const [productId, setProductId] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  // One key per sale attempt. It survives a network error, so "try again" can never sell twice.
  const pendingKey = useRef<string | null>(null);

  const product = products.find((p) => p.id === productId);
  const fixedPrice = product !== undefined && product.minAmount === product.maxAmount;

  // Editing the form means a different sale, so it needs a new key.
  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    pendingKey.current = null;
    setter(value);
  };

  function selectProduct(id: number) {
    edit(setProductId)(id);
    const selected = products.find((p) => p.id === id);
    setAmount(selected && selected.minAmount === selected.maxAmount ? String(selected.minAmount) : '');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!product) return;

    pendingKey.current ??= crypto.randomUUID();
    setBusy(true);
    setResult(null);

    try {
      const response = await api<{ data: Sale }>('/sales', {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': pendingKey.current },
        body: { productId: product.id, amount: Number(amount), destination: destination.trim() },
      });
      pendingKey.current = null;
      const sale = response.data;

      if (sale.status === 'CONFIRMED') {
        setResult({ kind: 'ok', text: `Venta confirmada. Referencia ${sale.providerReference}.` });
        setDestination('');
      } else if (sale.status === 'FAILED') {
        setResult({ kind: 'error', text: `El operador rechazó la venta (${sale.failureReason}). El saldo fue reembolsado.` });
      } else {
        setResult({ kind: 'info', text: 'La venta quedó en verificación con el operador. El saldo queda reservado.' });
      }
      onCompleted();
    } catch (err) {
      if (err instanceof ApiError) {
        // The server answered, so this attempt is finished; a retry is a new sale.
        pendingKey.current = null;
        if (err.status === 401) {
          onUnauthorized();
          return;
        }
      }
      setResult({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Nueva venta</h2>
      <div className="products" role="radiogroup" aria-label="Producto">
        {products.map((p) => (
          <label key={p.id} className="product">
            <input type="radio" name="product" checked={productId === p.id} onChange={() => selectProduct(p.id)} required />
            {p.name}
            <small>
              {p.type === 'GIFT_CARD' ? 'Tarjeta de regalo' : 'Recarga'} ·{' '}
              {p.minAmount === p.maxAmount ? formatCop(p.minAmount) : `${formatCop(p.minAmount)} – ${formatCop(p.maxAmount)}`}
            </small>
          </label>
        ))}
      </div>
      <label>
        Valor (COP)
        <input
          type="number"
          inputMode="numeric"
          value={amount}
          min={product?.minAmount}
          max={product?.maxAmount}
          step={1}
          disabled={fixedPrice}
          onChange={(e) => edit(setAmount)(e.target.value)}
          required
        />
      </label>
      {product && !fixedPrice && (
        <div className="chips" aria-label="Valores frecuentes">
          {QUICK_AMOUNTS.filter((value) => value >= product.minAmount && value <= product.maxAmount).map((value) => (
            <button
              key={value}
              type="button"
              className={Number(amount) === value ? 'chip active' : 'chip'}
              onClick={() => edit(setAmount)(String(value))}
            >
              {formatCop(value)}
            </button>
          ))}
        </div>
      )}
      <label>
        {product?.type === 'GIFT_CARD' ? 'Correo del cliente' : 'Celular'}
        <input
          type={product?.type === 'GIFT_CARD' ? 'email' : 'tel'}
          value={destination}
          placeholder={product?.type === 'GIFT_CARD' ? 'cliente@correo.com' : '3001234567'}
          onChange={(e) => edit(setDestination)(e.target.value)}
          required
        />
      </label>
      {result && <p className={`alert ${result.kind}`}>{result.text}</p>}
      <button type="submit" disabled={busy || !product}>
        {busy ? 'Procesando…' : amount ? `Vender ${formatCop(Number(amount))}` : 'Vender'}
      </button>
    </form>
  );
}
