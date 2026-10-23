import { useEffect, useState } from 'react';
import type { Dot, ModelConnection } from '../shared/types';
import { api } from './api';

export function ModelSelect({
  dot,
  mutate,
}: {
  dot: Dot;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [connectionId, setConnectionId] = useState(dot.modelConnectionId ?? '');
  const [modelId, setModelId] = useState(dot.modelId ?? '');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<ModelConnection[]>('/models', 'GET', undefined, controller.signal)
      .then(setConnections)
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Could not load model connections.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  const connection = connections.find((item) => item.id === connectionId);
  return (
    <fieldset className="space-access-fields">
      <legend>Model for {dot.name}</legend>
      <p className="muted">
        Applies to this specialist’s chats and background tasks. Changing it
        stops active work. Remote models receive the conversation context.
      </p>
      {loading ? (
        <p role="status">Loading model connections…</p>
      ) : (
        <>
          <label className="field-label" htmlFor="dot-model-connection">
            Connection
          </label>
          <select
            id="dot-model-connection"
            value={connectionId}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              setConnectionId(value);
              setModelId(
                connections.find((item) => item.id === value)?.models[0] ?? '',
              );
              setSaved(false);
            }}
          >
            <option value="">Use workspace default</option>
            {connectionId && !connection && (
              <option value={connectionId}>Unavailable connection</option>
            )}
            {connections.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.ready}>
                {item.name} ({item.location})
                {item.ready ? '' : ' — credential required'}
              </option>
            ))}
          </select>
          {connectionId && (
            <>
              <label className="field-label" htmlFor="dot-model-id">
                Model
              </label>
              <select
                id="dot-model-id"
                value={modelId}
                disabled={busy}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setSaved(false);
                }}
              >
                {!connection?.models.includes(modelId) && (
                  <option value={modelId}>Unavailable model</option>
                )}
                {connection?.models.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </>
          )}
          <button
            type="button"
            disabled={
              busy ||
              (!!connectionId &&
                (!connection?.ready || !connection.models.includes(modelId)))
            }
            onClick={async () => {
              setBusy(true);
              setError('');
              setSaved(false);
              try {
                const ok = await mutate(
                  `/dots/${encodeURIComponent(dot.id)}/model`,
                  'PUT',
                  {
                    modelConnectionId: connectionId || null,
                    modelId: connectionId ? modelId : null,
                  },
                );
                if (!ok) throw new Error();
                setSaved(true);
              } catch {
                setError(
                  'Could not save the model. Retry or choose another connection.',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save model'}
          </button>
        </>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Reload connections
          </button>
        </p>
      )}
      {saved && <p role="status">Model saved.</p>}
    </fieldset>
  );
}
