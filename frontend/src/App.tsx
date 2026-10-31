import { useState } from 'react';
import { User } from './api';
import { AdminPage } from './pages/Admin';
import { CashierPage } from './pages/Cashier';
import { LoginPage } from './pages/Login';

export interface Session {
  token: string;
  user: User;
}

const STORAGE_KEY = 'paypoint.session';

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);

  const signIn = (next: Session) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSession(next);
  };

  const signOut = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setSession(null);
  };

  if (!session) {
    return <LoginPage onSignIn={signIn} />;
  }

  const admin = session.user.role === 'ADMIN';
  return (
    <div className="layout">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          PayPoint
        </span>
        <span className="who">
          {session.user.email}
          <small>{admin ? 'Administrador' : 'Cajero'}</small>
        </span>
        <button className="link" onClick={signOut}>
          Salir
        </button>
      </header>
      <main>
        <header className="page-header">
          <h1>{admin ? 'Administración' : 'Punto de venta'}</h1>
          <p>{admin ? 'Puntos de venta, saldos y aliados B2B.' : 'Recargas y tarjetas de regalo con saldo prepagado.'}</p>
        </header>
        {admin ? (
          <AdminPage token={session.token} onUnauthorized={signOut} />
        ) : (
          <CashierPage token={session.token} onUnauthorized={signOut} />
        )}
      </main>
    </div>
  );
}
