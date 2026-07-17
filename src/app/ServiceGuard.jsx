import React from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useAuth } from './providers/AuthProvider'
import { serviceConfig, isService } from '../features/rates/serviceConfig'
import PlaceholderPage from '../components/shell/PlaceholderPage'

/**
 * Guards a `:service` route segment (DRAY.md §3 / Diagram C): the slug must name
 * a shipped service AND one the signed-in user can access (internal → all;
 * forwarder → their company's forwarder_services). Otherwise redirect to the
 * role's dashboard. Services flagged `placeholder` render a coming-soon page
 * instead of their (ocean-implemented) children.
 */
export default function ServiceGuard({ fallbackTo, children }) {
  const { service } = useParams()
  const { services } = useAuth()

  if (!isService(service) || !services.includes(service)) {
    return <Navigate to={fallbackTo} replace />
  }

  const cfg = serviceConfig[service]
  if (cfg.placeholder) {
    return (
      <PlaceholderPage
        title={`${cfg.label} — coming soon`}
        description={`The ${cfg.label.toLowerCase()} workflow is being built. Its request, rates, and upload pages will appear here.`}
      />
    )
  }
  return children
}
