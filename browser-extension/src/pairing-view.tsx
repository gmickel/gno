interface PairingViewProps {
  busy: boolean;
  error: string | null;
  gatewayOrigin: string;
  pairing: { pairingCode: string; expiresAt: string } | null;
  onGatewayOriginChange: (value: string) => void;
  onPoll: () => void;
  onStart: () => void;
}

export function PairingView({
  busy,
  error,
  gatewayOrigin,
  onGatewayOriginChange,
  onPoll,
  onStart,
  pairing,
}: PairingViewProps) {
  return (
    <main className="shell">
      <header>
        <span className="eyebrow">GNO · LOCAL CAPTURE</span>
        <h1>Pair this browser</h1>
        <p>Only explicit captures cross the loopback boundary.</p>
      </header>
      <section className="panel">
        {pairing ? (
          <>
            <label>
              Approval code
              <output className="pair-code">{pairing.pairingCode}</output>
            </label>
            <p className="hint">
              Enter this code in the GNO approval tab, then check approval.
            </p>
            <button disabled={busy} onClick={onPoll}>
              Check approval
            </button>
          </>
        ) : (
          <>
            <label>
              Local gateway
              <input
                onChange={(event) =>
                  onGatewayOriginChange(event.currentTarget.value)
                }
                spellCheck={false}
                value={gatewayOrigin}
              />
            </label>
            <button disabled={busy} onClick={onStart}>
              Pair with GNO
            </button>
          </>
        )}
      </section>
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
