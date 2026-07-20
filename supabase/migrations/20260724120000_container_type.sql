-- container_type as part of OCEAN rate identity (BIDDING.md §6 prerequisite).
-- Run via `supabase db push`, or paste into the Supabase SQL editor.
--
-- WHY (ocean only): ocean pricing differs by box size, so a routing key without container type is
-- incomplete — a 40' quote could wrongly dedup against (or, later, supersede) a 20' one, and bid
-- targeting would be ambiguous. 40' HC is the ~95% standard, so it is the DEFAULT.
--
-- NOT drayage: a drayage move is priced per lane regardless of box size — size affects the
-- ancillary/accessorial charges (chassis etc.), not the linehaul. So `drayage_rates` keeps its
-- lane-only identity and its existing current-rate unique index is untouched.
--
-- KEY DECISION: blank is an INPUT convenience, never a STORED state. The app resolves an empty
-- cell to '40'' HC' on write, so the column is NOT NULL and every key is total. (Storing NULL
-- would break uniqueness: Postgres treats NULLs as DISTINCT, so a NULL row and a '40'' HC' row
-- would count as two different keys — exactly the bug this prevents.)

alter table rates
  add column if not exists container_type text not null default '40'' HC';

-- Backfill accurately: a lane-linked rate answered a request that already stated the box size,
-- so take it from the lane. Standalone rates keep the 40' HC default.
update rates r
set container_type = l.container_type
from rate_request_lanes l
where r.lane_id = l.id
  and l.container_type is not null
  and btrim(l.container_type) <> '';
