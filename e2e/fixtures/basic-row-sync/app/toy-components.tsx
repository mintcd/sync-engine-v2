"use client";

import {
  useState,
} from "react";
import type { FormEvent } from "react";
import {
  useSyncEngine,
} from "@mintcd/sync-engine-v2/client/react";
import { finalConfig } from "../src/sync/sync.generated";
import styles from "./toy-components.module.css";

export function ToySyncPage({
  title,
}: {
  readonly title: string;
}) {
  const [streamId] = useState(() => browserStreamId());
  const [clientId] = useState(() => browserClientId());
  const [serviceWorkerError, setServiceWorkerError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>("note-1");
  const sync = useSyncEngine({
    config: finalConfig,
    streamId,
    clientId,
    initialSync: false,
    serviceWorker: {
      onError(error) {
        setServiceWorkerError(errorMessage(error));
      },
    },
  });
  const notes = sync.db.table("notes");
  const rows = notes.all();
  const first = rows[0];
  const selected = rows.find((row) => row.id === selectedId) ?? first;
  const canSave = sync.ready && draftTitle.trim() !== "";
  const rowTitle = first?.title ?? "";

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
    const titleValue = draftTitle.trim();
    if (!sync.ready || titleValue === "") {
      return;
    }
    const id = selected?.id ?? "note-1";
    void runAction(
      () => notes.put({ id, title: titleValue }),
      `Saved ${JSON.stringify(titleValue)} locally and queued it.`,
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
      "Deleted the selected note locally and queued it.",
    );
    setSelectedId(undefined);
  }

  function requestSync() {
    void runAction(
      () => sync.sync(),
      "Synchronization completed.",
    );
  }

  return (
    <main className={styles.shell}>
      <ToyHero
        title={title}
        eyebrow="Manual test bench"
        status={sync.phase}
        statusDetail={
          sync.ready
            ? sync.phase === "syncing" ? "sync in progress" : "ready"
            : "opening IndexedDB"
        }
      />

      <ToyMetrics
        confirmedSequence={sync.confirmedSequence}
        pendingCount={sync.pendingProposalCount}
        acceptedCount={sync.acceptedAwaitingConfirmationCount}
        resolutionCount={sync.unacknowledgedResolutionCount}
        busy={busy || sync.phase === "syncing" || !sync.ready}
        onSync={requestSync}
      />

      <div className={styles.panels}>
        <ToyNoteForm
          busy={busy || !sync.ready}
          canSave={canSave}
          draftTitle={draftTitle}
          selectedTitle={selected?.title}
          onDraftTitleChange={setDraftTitle}
          onSubmit={saveNote}
          onDelete={deleteSelected}
        />
        <ToyDiagnostics
          phase={sync.phase}
          pendingCount={sync.pendingProposalCount}
          syncError={sync.error?.message ?? ""}
          serviceWorkerError={serviceWorkerError}
          rowTitle={rowTitle}
        />
      </div>

      {notice !== "" && (
        <p className={styles.notice} role="status">{notice}</p>
      )}
      {(sync.error !== undefined || serviceWorkerError !== "") && (
        <p className={styles.error} role="alert">
          {sync.error?.message ?? serviceWorkerError}
        </p>
      )}

      <ToyRowsPanel
        rows={rows}
        selectedId={selected?.id}
        onSelect={setSelectedId}
      />
    </main>
  );
}

function browserStreamId() {
  if (typeof window === "undefined") {
    return "workspace:e2e";
  }
  return new URLSearchParams(window.location.search).get("streamId") ??
    "workspace:e2e";
}

function browserClientId() {
  if (typeof window === "undefined") {
    return "browser:e2e";
  }
  return new URLSearchParams(window.location.search).get("clientId") ??
    "browser:e2e";
}

function ToyHero({
  eyebrow,
  status,
  statusDetail,
  title,
}: {
  readonly eyebrow: string;
  readonly status: string;
  readonly statusDetail: string;
  readonly title: string;
}) {
  return (
    <header className={styles.hero}>
      <div>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1>{title}</h1>
        <p className={styles.lede}>
          Mutations land in IndexedDB first, stay visible as optimistic row
          state, and synchronize through generated protocol-v1 routes.
        </p>
      </div>
      <div className={styles.status}>
        <span className={styles.statusDot} />
        <div>
          <strong>{status}</strong>
          <small>{statusDetail}</small>
        </div>
      </div>
    </header>
  );
}

function ToyMetrics({
  acceptedCount,
  busy,
  confirmedSequence,
  onSync,
  pendingCount,
  resolutionCount,
}: {
  readonly acceptedCount: number;
  readonly busy: boolean;
  readonly confirmedSequence: number;
  readonly onSync: () => void;
  readonly pendingCount: number;
  readonly resolutionCount: number;
}) {
  return (
    <section className={styles.metrics} aria-label="Sync state">
      <Metric label="Pending" value={pendingCount} />
      <Metric label="Accepted" value={acceptedCount} />
      <Metric label="Confirmed" value={confirmedSequence} />
      <Metric label="Receipts" value={resolutionCount} />
      <button type="button" onClick={onSync} disabled={busy}>Sync</button>
    </section>
  );
}

function Metric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number | string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ToyNoteForm({
  busy,
  canSave,
  draftTitle,
  onDelete,
  onDraftTitleChange,
  onSubmit,
  selectedTitle,
}: {
  readonly busy: boolean;
  readonly canSave: boolean;
  readonly draftTitle: string;
  readonly onDelete: () => void;
  readonly onDraftTitleChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly selectedTitle: string | undefined;
}) {
  return (
    <section className={styles.panel} aria-label="Edit notes">
      <h2>Note</h2>
      <p>{selectedTitle === undefined ? "Create a local note." : `Selected: ${selectedTitle}`}</p>
      <form onSubmit={onSubmit}>
        <label htmlFor="title">title</label>
        <input
          id="title"
          name="title"
          placeholder="Offline first"
          value={draftTitle}
          onChange={(event) => onDraftTitleChange(event.currentTarget.value)}
        />
        <div className={styles.buttonRow}>
          <button disabled={busy || !canSave}>Save</button>
          <button
            className={styles.danger}
            type="button"
            onClick={onDelete}
            disabled={busy || selectedTitle === undefined}
          >
            Delete
          </button>
        </div>
      </form>
    </section>
  );
}

function ToyDiagnostics({
  pendingCount,
  phase,
  rowTitle,
  serviceWorkerError,
  syncError,
}: {
  readonly pendingCount: number;
  readonly phase: string;
  readonly rowTitle: string;
  readonly serviceWorkerError: string;
  readonly syncError: string;
}) {
  return (
    <section className={styles.panel} aria-label="Diagnostics">
      <h2>Diagnostics</h2>
      <p>Stable selectors for the browser e2e tests.</p>
      <dl className={styles.diagnostics}>
        <div>
          <dt>phase</dt>
          <dd data-testid="phase">{phase}</dd>
        </div>
        <div>
          <dt>pending</dt>
          <dd data-testid="pending">{pendingCount}</dd>
        </div>
        <div>
          <dt>sync error</dt>
          <dd data-testid="sync-error">{syncError}</dd>
        </div>
        <div>
          <dt>service worker</dt>
          <dd data-testid="service-worker-error">{serviceWorkerError}</dd>
        </div>
        <div>
          <dt>first row</dt>
          <dd>
            <output data-testid="row-title">{rowTitle}</output>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ToyRowsPanel({
  onSelect,
  rows,
  selectedId,
}: {
  readonly onSelect: (id: string) => void;
  readonly rows: readonly { readonly id: string; readonly title: string }[];
  readonly selectedId: string | undefined;
}) {
  return (
    <section className={styles.dataPanel}>
      <div className={styles.rowsHeader}>
        <div>
          <p className={styles.eyebrow}>IndexedDB notes</p>
          <h2>Local rows</h2>
        </div>
        <span>{rows.length} rows</span>
      </div>
      <div className={styles.tableWrap}>
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
                className={selectedId === row.id ? styles.selected : undefined}
              >
                <td>
                  <input
                    type="radio"
                    name="selected-note"
                    aria-label={`Select ${row.title}`}
                    checked={selectedId === row.id}
                    onChange={() => onSelect(row.id)}
                  />
                </td>
                <td className={styles.mono}>{row.id}</td>
                <td>{row.title}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className={styles.empty} colSpan={3}>
                  No local rows yet. Save one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
