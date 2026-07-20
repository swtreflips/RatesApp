/*
  serviceConfig — the single seam between the service-parameterized app and each
  service's real objects (DRAY.md §3 / Diagram E).

  Ocean keeps the ORIGINAL table names (no renames — DRAY.md's no-rename decision);
  drayage arrives in §9b step 5 as a second entry pointing at drayage_* tables.
  Everything outside this file addresses tables/labels via serviceConfig[service],
  so adding a service never touches the shell.

  The app's list of live services IS this object's keys: the sidebar, route guards,
  and AuthProvider all derive from it, so a service appears everywhere the moment
  its entry lands here (and a forwarder company holds the capability row).
*/

import { Ship, Truck } from 'lucide-react'

export const serviceConfig = {
  ocean: {
    slug: 'ocean',
    label: 'Ocean',
    // The service's mark — used wherever a service is shown as itself (sidebar
    // nav, dashboard CTA). Action-specific icons (upload, new, …) stay at their
    // call site; this one is the SERVICE's identity, so it lives here.
    icon: Ship,
    // Sidebar item labels that differ per service live here; anything not listed
    // falls back to the shared defaults in the Sidebar.
    nav: {
      openRequests: 'Open Requests',
    },
    tables: {
      batches: 'rate_request_batches',
      lanes: 'rate_request_lanes',
      submissions: 'rate_submissions',
      rates: 'rates',
    },
  },
  drayage: {
    slug: 'drayage',
    label: 'Drayage',
    icon: Truck,
    nav: {
      openRequests: 'Open Drayage Requests',
    },
    tables: {
      batches: 'rate_request_batches', // shared, tagged by `service` (DRAY.md §2b)
      lanes: 'drayage_request_lanes',
      submissions: 'drayage_submissions',
      rates: 'drayage_rates',
    },
  },
}

/** Service slugs the app currently ships, in sidebar display order. */
export const SERVICE_SLUGS = Object.keys(serviceConfig)

/** True if `slug` names a live service. */
export const isService = (slug) => Object.hasOwn(serviceConfig, slug)
