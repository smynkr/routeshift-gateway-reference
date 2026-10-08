'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

interface SavingsDataPoint {
  hour: string;
  original_cost_usd: number;
  actual_cost_usd: number;
  savings_usd: number;
}

interface SavingsChartProps {
  data: SavingsDataPoint[];
}

export function SavingsChart({ data }: SavingsChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[350px] rounded-xl border border-white/[0.06] bg-white/[0.03]">
        <p className="text-neutral-500">No savings data yet. Route some requests through RouteShift to see cost data.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
      <ResponsiveContainer width="100%" height={350}>
        <AreaChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="hour"
            tickFormatter={(v) => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
            tick={{ fill: '#737373', fontSize: 12 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v) => `$${v.toFixed(2)}`}
            tick={{ fill: '#737373', fontSize: 12 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
            tickLine={false}
          />
          <Tooltip
            formatter={(value, name) => [
              typeof value === 'number' ? `$${value.toFixed(2)}` : String(value),
              name === 'original_cost_usd' ? 'Original Routing Cost' : name === 'actual_cost_usd' ? 'Routing Cost' : 'Routing Savings',
            ]}
            labelFormatter={(label) => new Date(label).toLocaleString()}
            contentStyle={{
              backgroundColor: '#111113',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '0.5rem',
              color: '#fff',
            }}
            itemStyle={{ color: '#a3a3a3' }}
            labelStyle={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}
          />
          <Legend
            formatter={(value) =>
              value === 'original_cost_usd' ? 'Original Routing Cost' : value === 'actual_cost_usd' ? 'Routing Cost' : 'Routing Savings'
            }
            wrapperStyle={{ color: '#a3a3a3', fontSize: 12 }}
          />
          <Area
            type="monotone"
            dataKey="original_cost_usd"
            stroke="#525252"
            fill="#525252"
            fillOpacity={0.05}
            strokeWidth={2}
            strokeDasharray="5 5"
          />
          <Area
            type="monotone"
            dataKey="actual_cost_usd"
            stroke="#10b981"
            fill="#10b981"
            fillOpacity={0.15}
            strokeWidth={2}
          />
          <Area
            type="monotone"
            dataKey="savings_usd"
            stroke="#6366f1"
            fill="#6366f1"
            fillOpacity={0.12}
            strokeWidth={2}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
