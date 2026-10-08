'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, RotateCcw, ScrollText } from 'lucide-react';
import { TableSkeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const MICROCENTS_TO_USD = 100_000_000;

interface Transaction {
  id: string;
  type: 'purchase' | 'deduction' | 'auto_topup';
  description: string;
  amount_microcents: number;
  balance_after_microcents: number;
  created_at: string;
}

interface TransactionsResponse {
  transactions: Transaction[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

function formatUsd(microcents: number): string {
  const usd = microcents / MICROCENTS_TO_USD;
  if (Math.abs(usd) < 0.01 && usd !== 0) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function TypeBadge({ type }: { type: Transaction['type'] }) {
  const styles: Record<string, string> = {
    purchase: 'bg-emerald-500/10 text-emerald-400',
    deduction: 'bg-red-500/10 text-red-400',
    auto_topup: 'bg-blue-500/10 text-blue-400',
  };
  const labels: Record<string, string> = {
    purchase: 'Purchase',
    deduction: 'Deduction',
    auto_topup: 'Auto Top-Up',
  };
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${styles[type] ?? 'bg-neutral-500/10 text-neutral-400'}`}>
      {labels[type] ?? type}
    </span>
  );
}

export function TransactionHistory() {
  const [data, setData] = useState<TransactionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const fetchTransactions = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      const res = await fetch(`/api/credits/transactions?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to fetch transactions:', err);
      setError('Could not load transactions.');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    setLoading(true);
    fetchTransactions();
  }, [fetchTransactions]);

  if (loading && !data) {
    return <TableSkeleton rows={5} cols={4} />;
  }

  if (error && !data) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] py-12 text-center">
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-red-400" />
        <p className="text-sm text-red-300">{error}</p>
        <button
          onClick={fetchTransactions}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-white/[0.1]"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Retry
        </button>
      </div>
    );
  }

  if (data && data.transactions.length === 0) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
        <ScrollText className="mx-auto mb-4 h-10 w-10 text-neutral-600" />
        <h3 className="mb-2 text-lg font-semibold text-white">No transactions yet</h3>
        <p className="mx-auto max-w-md text-sm text-neutral-500">
          Purchase credits to see your transaction history here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {data && (
        <>
          <div className="overflow-hidden rounded-xl border border-white/[0.06]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Balance After</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.transactions.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell className="text-neutral-400" suppressHydrationWarning>
                      {new Date(tx.created_at).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </TableCell>
                    <TableCell>
                      <TypeBadge type={tx.type} />
                    </TableCell>
                    <TableCell className="whitespace-normal text-neutral-300">{tx.description}</TableCell>
                    <TableCell className={`text-right font-medium ${
                      tx.amount_microcents >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {tx.amount_microcents >= 0 ? '+' : ''}{formatUsd(tx.amount_microcents)}
                    </TableCell>
                    <TableCell className="text-right text-neutral-400">
                      {formatUsd(tx.balance_after_microcents)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {data.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-neutral-500">
                Page {data.page} of {data.totalPages}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-neutral-400 transition-colors hover:border-white/[0.1] hover:text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                  disabled={page === data.totalPages}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-neutral-400 transition-colors hover:border-white/[0.1] hover:text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
