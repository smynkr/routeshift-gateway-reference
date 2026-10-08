'use client';

import { useCallback, useEffect, useState } from 'react';
import { Tag, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { EFFECTIVE_DISPATCHABLE_CHAT_MODELS } from '@routeshift/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface Alias {
  alias: string;
  canonical_name: string;
  notes: string | null;
  updated_at: string;
}

const CANONICAL_OPTIONS = EFFECTIVE_DISPATCHABLE_CHAT_MODELS
  .map((model) => model.canonical_name)
  .sort();

export function ModelAliasesSection({
  canEdit = true,
  readOnlyReason = 'Only admins can manage model aliases.',
}: {
  canEdit?: boolean;
  readOnlyReason?: string;
}) {
  const [aliases, setAliases] = useState<Alias[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [aliasInput, setAliasInput] = useState('');
  const [canonicalInput, setCanonicalInput] = useState(CANONICAL_OPTIONS[0] ?? '');
  const [notesInput, setNotesInput] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchAliases = useCallback(async () => {
    try {
      const res = await fetch('/api/model-aliases');
      if (!res.ok) throw new Error('fetch failed');
      const data = (await res.json()) as { aliases: Alias[] };
      setAliases(data.aliases);
    } catch (err) {
      console.error('aliases fetch:', err);
      setError('Failed to load aliases.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAliases();
  }, [fetchAliases]);

  const addAlias = async () => {
    if (!canEdit) {
      setError(readOnlyReason);
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const res = await fetch('/api/model-aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: aliasInput.trim(),
          canonical_name: canonicalInput,
          notes: notesInput.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Failed to add alias.');
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.proxy_cache_invalidated === false) {
        setError(`Alias saved, but the proxy cache may keep the old mapping for up to ${data.cache_ttl_seconds ?? 60} seconds.`);
      }
      setAliasInput('');
      setNotesInput('');
      await fetchAliases();
    } catch (err) {
      console.error('aliases add:', err);
      setError('Failed to add alias.');
    } finally {
      setAdding(false);
    }
  };

  const deleteAlias = async (alias: string) => {
    if (!canEdit) {
      setError(readOnlyReason);
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/model-aliases?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Failed to delete alias.');
        void fetchAliases();
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.proxy_cache_invalidated === false) {
        setError(`Alias deleted, but the proxy cache may keep the old mapping for up to ${data.cache_ttl_seconds ?? 60} seconds.`);
      }
      setAliases((prev) => (prev ? prev.filter((a) => a.alias !== alias) : prev));
    } catch (err) {
      console.error('aliases delete:', err);
      setError('Failed to delete alias.');
      void fetchAliases();
    }
  };

  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
      <header className="mb-2 flex items-center gap-3">
        <Tag className="h-5 w-5 text-emerald-400" />
        <h3 className="text-lg font-semibold text-white">Model Aliases</h3>
      </header>
      <p className="mb-4 text-sm text-neutral-400">
        Map custom model names (Azure deployments like <span className="font-mono text-neutral-300">myorg-gpt5-eastus</span>,
        OpenAI fine-tunes, internal nicknames) to a canonical model. The proxy resolves the alias before routing and pricing.
      </p>

      {!canEdit && (
        <div className="mb-4 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-neutral-500">
          {readOnlyReason}
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* Add row */}
      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
        <input
          type="text"
          aria-label="Alias"
          value={aliasInput}
          onChange={(e) => setAliasInput(e.target.value)}
          disabled={!canEdit}
          placeholder="Alias (e.g. myorg-gpt5-eastus)"
          className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-emerald-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <select
          value={canonicalInput}
          aria-label="Canonical model"
          onChange={(e) => setCanonicalInput(e.target.value)}
          disabled={!canEdit}
          className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white focus:border-emerald-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {CANONICAL_OPTIONS.map((c) => (
            <option key={c} value={c}>
              → {c}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={notesInput}
          aria-label="Notes"
          onChange={(e) => setNotesInput(e.target.value)}
          disabled={!canEdit}
          placeholder="Notes (optional)"
          className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-emerald-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          onClick={addAlias}
          disabled={!canEdit || adding || aliasInput.trim().length === 0}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-white/[0.04]" />
          ))}
        </div>
      ) : aliases && aliases.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-white/[0.06]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Alias</TableHead>
                <TableHead>Canonical</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aliases.map((a) => (
                <TableRow key={a.alias}>
                  <TableCell className="font-mono text-white">{a.alias}</TableCell>
                  <TableCell className="font-mono text-emerald-400">→ {a.canonical_name}</TableCell>
                  <TableCell className="whitespace-normal text-neutral-400">{a.notes ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    <button
                      type="button"
                      onClick={() => deleteAlias(a.alias)}
                      disabled={!canEdit}
                      title="Delete alias"
                      aria-label={`Delete alias ${a.alias}`}
                      className="rounded-md p-1.5 text-neutral-600 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500">
          No aliases configured. Add one above to start routing custom model names through the proxy.
        </p>
      )}
    </section>
  );
}
