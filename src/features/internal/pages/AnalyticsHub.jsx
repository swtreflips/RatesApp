import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Truck, Ship, ArrowRight, TrendingUp } from 'lucide-react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'

/*
  Internal "Analytics" hub — one cross-service menu (outside the ocean/drayage sidebar groups),
  landing on a card per service. Drayage is live (Layer 1 benchmarking, DRAYAGE_ANALYTICS.md);
  Ocean is deferred (coming-soon card). Internal-only.
*/

function AnalyticsCard({ icon: Icon, accent, title, blurb, onClick, disabled }) {
  const tones = {
    signal: 'text-signal-600 bg-signal-50 ring-signal-100',
    sea: 'text-sea-600 bg-sea-50 ring-sea-100',
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'group relative flex flex-col gap-3 rounded-2xl border bg-white p-5 text-left shadow-card transition-all',
        disabled
          ? 'cursor-default border-fog-200 opacity-70'
          : 'border-fog-200 hover:-translate-y-0.5 hover:border-harbor-300 hover:shadow-card-hover',
      ].join(' ')}
    >
      <span className={`flex h-11 w-11 items-center justify-center rounded-xl ring-1 ring-inset ${tones[accent]}`}>
        <Icon size={22} strokeWidth={1.9} />
      </span>
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-base font-bold text-harbor-900">{title}</h3>
          {disabled && (
            <span className="rounded bg-fog-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-fog-500">
              coming soon
            </span>
          )}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-fog-500">{blurb}</p>
      </div>
      {!disabled && (
        <span className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-harbor-500 transition-colors group-hover:text-signal-600">
          Open <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
        </span>
      )}
    </button>
  )
}

export default function AnalyticsHub() {
  const navigate = useNavigate()
  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Internal · Analytics"
        title="Analytics"
        subtitle="Rate benchmarking and market insight, per service."
        actions={
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-fog-200 bg-white px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-fog-500 shadow-card">
            <TrendingUp size={13} className="text-signal-500" /> Internal only
          </span>
        }
      />
      <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:max-w-3xl">
        <AnalyticsCard
          icon={Truck}
          accent="signal"
          title="Drayage"
          blurb="How competitive is each forwarder? $/mile and $/hour on every current lane, benchmarked against the real truck route."
          onClick={() => navigate('/internal/analytics/drayage')}
        />
        <AnalyticsCard
          icon={Ship}
          accent="sea"
          title="Ocean"
          blurb="Ocean rate analytics — planned next once the drayage view proves out."
          disabled
        />
      </div>
    </div>
  )
}
