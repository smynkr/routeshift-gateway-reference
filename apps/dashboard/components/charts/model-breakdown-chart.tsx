'use client';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

interface ModelStat {
  model: string;
  requests: number;
  avg_latency_ms: number;
  tokens: number;
}

const BAR_COLORS = ['#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#22d3ee', '#34d399'];

export function ModelBreakdownChart({ data }: { data: ModelStat[] }) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px] rounded-xl border border-white/[0.06] bg-white/[0.03]">
        <p className="text-neutral-500">No model usage data yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} layout="vertical" margin={{ left: 150 }}>
          <XAxis
            type="number"
            tick={{ fill: '#737373', fontSize: 12 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="model"
            tick={{ fill: '#a3a3a3', fontSize: 12 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
            tickLine={false}
            width={150}
          />
          <Tooltip
            formatter={(value) => [(value as number).toLocaleString(), 'Requests']}
            contentStyle={{
              backgroundColor: '#111113',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '0.5rem',
              color: '#fff',
            }}
            itemStyle={{ color: '#a3a3a3' }}
            labelStyle={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
          />
          <Bar dataKey="requests" radius={[0, 4, 4, 0]}>
            {data.map((_, index) => (
              <Cell key={`cell-${index}`} fill={BAR_COLORS[index % BAR_COLORS.length]} fillOpacity={0.8} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
