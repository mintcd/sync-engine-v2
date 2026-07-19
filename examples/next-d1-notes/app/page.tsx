"use client";

import {
  useState,
} from "react";
import type { FormEvent } from "react";
import {
  useSyncEngine,
} from "@mintcd/sync-engine/client/react";
import {
  deleteIndexedDbReplicaDatabase,
} from "@mintcd/sync-engine/indexeddb";
import { finalConfig } from "./sync/sync.generated";

function browserValue(name: string, fallback: string) {
  if (typeof window === "undefined") {
    return fallback;
  }
  return new URLSearchParams(window.location.search).get(name) ?? fallback;
}

function optionalBrowserValue(name: string) {
  if (typeof window === "undefined") {
    return undefined;
  }
  return new URLSearchParams(window.location.search).get(name) ?? undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function Page() {
  const [streamId] = useState(() => browserValue("streamId", "manual:toy"));
  const [clientId] = useState(() => optionalBrowserValue("clientId"));
  const [draftTitle, setDraftTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [serviceWorkerError, setServiceWorkerError] = useState("");
  const sync = useSyncEngine({
    config: finalConfig,
    streamId,
    ...(clientId === undefined ? {} : { clientId }),
    serviceWorker: {
      onError(error) {
        setServiceWorkerError(errorMessage(error));
      },
    },
  });
  const notes = sync.db.table("notes");
  const rows = notes.all();
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];
  const canSave = sync.ready && draftTitle.trim() !== "";

  async function runAction(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      await action();
      setNotice(success);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = draftTitle.trim();
    if (!sync.ready || title === "") {
      return;
    }
    const id = selected?.id ?? crypto.randomUUID();
    void runAction(
      () => notes.put({ id, title }),
      "Saved locally and queued for sync.",
    );
    setSelectedId(id);
    setDraftTitle("");
  }

  function deleteSelected() {
    if (!sync.ready || selected === undefined) {
      return;
    }
    void runAction(
      () => notes.delete({ id: selected.id }),
      "Deleted locally and queued for sync.",
    );
    setSelectedId(undefined);
  }

  function requestSync() {
    void runAction(() => sync.sync(), "Synchronization completed.");
  }

  function hardReset() {
    void runAction(async () => {
      const response = await fetch("/api/sync/reset", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`reset endpoint returned HTTP ${response.status}`);
      }
      await sync.client?.close();
      await deleteIndexedDbReplicaDatabase(finalConfig.databaseName);
      if (typeof navigator !== "undefined" && navigator.serviceWorker) {
        const registrations =
          await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          registrations
            .filter((registration) =>
              registration.active?.scriptURL.endsWith(
                finalConfig.serviceWorker?.url ?? "",
              ) ?? true,
            )
            .map((registration) => registration.unregister()),
        );
      }
      window.location.reload();
    }, "Reset local and remote sync state.");
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Manual test bench</p>
          <h1>sync-engine toy sync</h1>
          <p className="lede">
            Notes are written to IndexedDB first, rendered from optimistic row
            state, and synchronized through generated protocol-v1 routes.
          </p>
        </div>
        <div className="status">
          <span className="statusDot" />
          <div>
            <strong>{sync.phase}</strong>
            <small>{sync.ready ? "client ready" : "opening IndexedDB"}</small>
          </div>
        </div>
      </header>

      <section className="metrics" aria-label="Sync state">
        <div>
          <span>Pending</span>
          <strong data-testid="pending">{sync.pendingProposalCount}</strong>
        </div>
        <div>
          <span>Accepted</span>
          <strong>{sync.acceptedAwaitingConfirmationCount}</strong>
        </div>
        <div>
          <span>Confirmed</span>
          <strong>{sync.confirmedSequence}</strong>
        </div>
        <div>
          <span>Phase</span>
          <strong data-testid="phase">{sync.phase}</strong>
        </div>
        <button
          type="button"
          onClick={requestSync}
          disabled={busy || !sync.ready || sync.phase === "syncing"}
        >
          Sync
        </button>
        <button
          className="danger"
          type="button"
          onClick={hardReset}
          disabled={busy}
        >
          Hard reset
        </button>
      </section>

      <div className="panels">
        <section className="panel" aria-label="Edit notes">
          <h2>Note</h2>
          <p>
            {selected === undefined
              ? "Create a local note."
              : `Selected: ${selected.title}`}
          </p>
          <form onSubmit={saveNote}>
            <label htmlFor="title">title</label>
            <input
              id="title"
              name="title"
              placeholder="Offline first"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.currentTarget.value)}
            />
            <div className="buttonRow">
              <button disabled={busy || !canSave}>Save</button>
              <button
                className="danger"
                type="button"
                onClick={deleteSelected}
                disabled={busy || !sync.ready || selected === undefined}
              >
                Delete
              </button>
            </div>
          </form>
        </section>

        <section className="panel" aria-label="Diagnostics">
          <h2>Diagnostics</h2>
          <dl className="diagnostics">
            <div>
              <dt>stream</dt>
              <dd>{streamId}</dd>
            </div>
            <div>
              <dt>client</dt>
              <dd>{sync.client?.clientId ?? clientId ?? "opening"}</dd>
            </div>
            <div>
              <dt>sync error</dt>
              <dd data-testid="sync-error">{sync.error?.message ?? ""}</dd>
            </div>
            <div>
              <dt>service worker</dt>
              <dd data-testid="service-worker-error">{serviceWorkerError}</dd>
            </div>
            <div>
              <dt>first row</dt>
              <dd>
                <output data-testid="row-title">{rows[0]?.title ?? ""}</output>
              </dd>
            </div>
          </dl>
        </section>
      </div>

      {notice !== "" && <p className="notice" role="status">{notice}</p>}
      {(sync.error !== undefined || serviceWorkerError !== "") && (
        <p className="error" role="alert">
          {sync.error?.message ?? serviceWorkerError}
        </p>
      )}

      <section className="dataPanel">
        <div className="rowsHeader">
          <div>
            <p className="eyebrow">IndexedDB notes</p>
            <h2>Local rows</h2>
          </div>
          <span>{rows.length} rows</span>
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Select</th>
                <th>ID</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={selected?.id === row.id ? "selected" : undefined}
                >
                  <td>
                    <input
                      type="radio"
                      name="selected-note"
                      aria-label={`Select ${row.title}`}
                      checked={selected?.id === row.id}
                      onChange={() => setSelectedId(row.id)}
                    />
                  </td>
                  <td className="mono">{row.id}</td>
                  <td>{row.title}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="empty" colSpan={3}>
                    No local rows yet. Save one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
