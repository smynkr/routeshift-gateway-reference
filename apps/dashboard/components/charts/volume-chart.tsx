'use client';

import {
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Line,
} from 'recharts';

interface VolumeDataPoint {
  hour: string;
  requests: number;
  avg_latency_ms: number;
}

interface VolumeChartProps {
  data: VolumeDataPoint[];
}

export function VolumeChart({ data }: VolumeChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px] rounded-xl border border-white/[0.06] bg-white/[0.03]">
        <p className="text-neutral-500">No request data yet. Send requests through RouteShift to see volume data.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="hour"
            tickFormatter={(v) => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
            tick={{ fill: '#737373', fontSize: 12 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
            tickLine={false}
          />
          <YAxis
            yAxisId="left"
            tick={{ fill: '#737373', fontSize: 12 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
            tickLine={false}
          />
          <YAxis yAxisId="right" orientation="right" stroke="#525252" tick={{ fill: '#737373', fontSize: 11 }} />
          <Tooltip
            formatter={(value, name) => [
              name === 'avg_latency_ms' ? `${value as number}ms` : (value as number).toLocaleString(),
              name === 'avg_latency_ms' ? 'Avg Latency' : 'Requests',
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
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="requests"
            stroke="#10b981"
            fill="#10b981"
            fillOpacity={0.1}
            strokeWidth={2}
          />
          <Line yAxisId="right" type="monotone" dataKey="avg_latency_ms" stroke="#f59e0b" strokeWidth={1.5} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
