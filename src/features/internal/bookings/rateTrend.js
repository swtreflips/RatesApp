import { dateVal } from './rateValidity'

/*
  How each rate moved against the rate it replaced.

  At a period boundary the board holds two populations at once — rates dying in the last days of
  the old period, and rates arriving for the new one — and nothing on screen said whether the new
  ones came in above or below what they replace. This computes that.

  PURE. No React, no DOM, no store: a snapshot payload in, a Map out. Everything that can be wrong
  about this is wrong in here (a baseline from the wrong lane, a comparison between two rates that
  coexist, a percentage off by a sign) and none of it needs a browser to catch.
*/

/** Predecessors older than this are not a baseline — the market has moved on. */
export const COMPARE_LOOKBACK_DAYS = 60

/*
  IDENTITY — AND IT MUST INCLUDE POL.

  Same forwarder, POL, POD, Last CY, carrier, container type: the shape of `rateKey` in
  applyRates/matcher.js minus the rate and the validity, which are the things being compared.

  Omitting POL is not a cosmetic slip. It merged one forwarder's Nhava Sheva line (2,679) with
  their Laem Chabang line (2,071) and produced a fictional -23% between two lanes that have nothing
  to do with each other. Caught by reading the data, not by reasoning about it.
*/
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

const identityOf = (ofq, ofr) =>
  [
    norm(ofr.forwarder),
    norm(ofr.pol || ofq.pol),
    norm(ofr.pod),
    norm(ofr.lastCy),
    norm(ofr.carrier),
    norm(ofr.containerType || ofq.containerType),
  ].join('|')

const toNum = (v) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * @typedef {object} Trend
 * @property {number} pct        signed percentage change, 0 when the price held
 * @property {number} prevRate   what it was
 * @property {string} prevValidUntil  the baseline's expiry, as it appeared in the file
 */

/**
 * Build `Map<ofrId, Trend>` from a whole snapshot payload.
 *
 * ONE PASS OVER EVERYTHING, NEVER PER OFQ. A rate's baseline usually sits on a different quote —
 * one forwarder's 2,679 appears on a single OFQ while the 3,125 that replaced it appears on nine
 * others, and all nine should read the same +16.6%. Scoping the lookup to the OFQ being rendered
 * finds almost nothing; it is what made a first coverage count come out three times too low.
 *
 * Call this with the RAW snapshot, before `applyValidity`. The baseline is by definition the older
 * rate, so filtering first would delete exactly what this needs — and silently, since the result
 * is simply a smaller Map.
 *
 * @param {Array} ofqs   snapshot payload, unfiltered
 * @param {Date}  now    today, for the lookback window
 * @returns {Map<string, Trend>} keyed by ofrId
 */
export function buildRateTrends(ofqs, now = new Date()) {
  // 1. every rate in the file, grouped by what makes it the same product
  const byIdentity = new Map()
  for (const ofq of ofqs ?? []) {
    for (const ofr of ofq.oceanOptions ?? []) {
      const rate = toNum(ofr.rate)
      const until = dateVal(ofr.validUntil)
      // A rate with no price cannot be compared, and one with no expiry has no position in a
      // sequence — it is open-ended, not "latest".
      if (rate == null || !Number.isFinite(until)) continue
      const key = identityOf(ofq, ofr)
      if (!byIdentity.has(key)) byIdentity.set(key, [])
      byIdentity.get(key).push({ ofrId: ofr.ofrId, rate, until, validUntil: ofr.validUntil })
    }
  }

  const floor = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
    COMPARE_LOOKBACK_DAYS * 86400000

  const trends = new Map()
  for (const versions of byIdentity.values()) {
    // Oldest first, so each rate's predecessor is the nearest thing behind it.
    versions.sort((a, b) => a.until - b.until)

    for (let i = 0; i < versions.length; i += 1) {
      const cur = versions[i]

      /*
        Walk back to the newest STRICTLY EARLIER expiry.

        Strictly, because two rates sharing a valid_until are not a sequence — they coexist, and
        one forwarder really does hold 9,420 and 8,790 on the same lane to the same day. Comparing
        those would invent a -6.7% that never happened.
      */
      let prev = null
      for (let j = i - 1; j >= 0; j -= 1) {
        if (versions[j].until < cur.until) { prev = versions[j]; break }
      }
      if (!prev) continue

      /*
        The window rejects a STALE baseline, not a live one. A predecessor still in force counts:
        a rate running to 30 Sep superseded by one running to 30 Jun is a turn already agreed and
        not yet arrived, which is the most useful thing on the board. Only something that expired
        long ago is disqualified.
      */
      const prevDay = new Date(prev.until)
      const prevUtc = Date.UTC(prevDay.getFullYear(), prevDay.getMonth(), prevDay.getDate())
      if (prevUtc < floor) continue

      if (prev.rate === 0) continue // no percentage against nothing

      trends.set(cur.ofrId, {
        pct: ((cur.rate - prev.rate) / prev.rate) * 100,
        prevRate: prev.rate,
        prevValidUntil: prev.validUntil,
      })
    }
  }
  return trends
}

/** Rounded to one decimal — 38.9%, not 38.87654%. */
export const formatPct = (pct) => `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(1)}%`

/** Zero is a RESULT, not a gap: a price held across a renewal is something a buyer acts on. */
export const isHeld = (pct) => Math.abs(pct) < 0.05
