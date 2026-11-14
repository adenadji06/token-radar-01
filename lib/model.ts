// Token Radar — the valuation model, rebuilt as a pipeline of small stages.
//
// The program reads one sealed snapshot and hands the dashboard a ranked board. The pipeline
// runs in four stages, each a pure function of the snapshot it is given:
//
//   1. parse   — the file's text becomes a Snapshot, or the run stops with a SnapshotError.
//   2. price   — every category gets a comparable multiple from the live-token protocols in it,
//                and every category gets sector statistics (z-scores) from its own figures.
//   3. score   — every pre-token protocol gets one implied value from the snapshot's figures:
//                the comps multiple, then a signal factor from sector-relative z-scores, the
//                seven-day momentum against its own sector, and a catalyst flag.
//   4. plan    — every ranked row gets a seven-step farm plan derived from its own record,
//                each step carrying a concrete cost, a time and an expected value, the value
//                steps ordered by expected value, highest first.
//
// The board always covers the snapshot's whole watchlist and then adds the early radar: the
// pre-token protocols below the watchlist floor, strongest TVL first, up to EARLY_ROWS. The
// live-token protocols are never ranked; they are the market that prices the board, and the
// dashboard shows them apart with their market caps.
//
// Nothing in the model names a protocol. The same code scores every row, and the comparables
// table the dashboard prints is computed from this same snapshot while the program runs.
// The sector statistics are computed the same way: a protocol's z-scores are measured
// against the other protocols in its own category, never against a hand-kept list.
//
// The model, in one line per factor (the dashboard prints the same formula):
//
//   multiple   median mcap/TVL of the live protocols in the row's category (3+ comps),
//              else the global median; clamped to [multiple_floor, multiple_cap]
//   base       tvl_usd * multiple
//   growth     clamp(change_7d, growth_floor, growth_cap), in per cent
//   growthMult 1 + (growth / 100) * growth_weight
//   maturity   maturity_floor + min(age_days, maturity_days) / maturity_days * maturity_range
//              (age unknown: unknown_age_days; age is days since listed_at)
//   reach      1 + min(chains - 1, reach_max_chains) * reach_step
//   tvl_z      z-score of log10(tvl_usd) among the pre-token protocols of its category
//   growth_z   z-score of the winsorised change_7d against its category's median and MAD
//   momentum   winsorised change_7d minus its category's median change_7d, in points
//   catalyst   'surge' when change_7d >= 50, 'young-giant' when under a year old with
//              TVL at or above $100M, 'multi-chain' when on 5+ chains, else null
//   signalMult clamp(1 + signal_tvl * tanh(tvl_z) + signal_growth * tanh(growth_z)
//              + (catalyst ? catalyst_boost : 0), signal_floor, signal_cap)
//   implied    max(1, round(base * growthMult * maturity * reach * signalMult))
//
// Deterministic throughout: the same snapshot bytes always produce the same output bytes.

/* ------------------------------------------------------------------ types -- */

/** One protocol entry of the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document, as the sealed file carries it. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's tunable constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  min_comps: number;
  reach_step: number;
  reach_max_chains: number;
  signal_tvl: number;
  signal_growth: number;
  catalyst_boost: number;
  signal_floor: number;
  signal_cap: number;
  growth_winsor_lo: number;
  growth_winsor_hi: number;
  catalyst_surge_pct: number;
  catalyst_young_days: number;
  catalyst_young_tvl: number;
  catalyst_chains: number;
  ev_allocation: number;
  ev_farmers: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  multiple_floor: 0.05,
  multiple_cap: 1.0,
  min_comps: 3,
  reach_step: 0.02,
  reach_max_chains: 4,
  signal_tvl: 0.12,
  signal_growth: 0.1,
  catalyst_boost: 0.05,
  signal_floor: 0.75,
  signal_cap: 1.3,
  growth_winsor_lo: -90,
  growth_winsor_hi: 500,
  catalyst_surge_pct: 50,
  catalyst_young_days: 365,
  catalyst_young_tvl: 100_000_000,
  catalyst_chains: 5,
  ev_allocation: 0.05,
  ev_farmers: 50_000,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3-signals';

/** Early rows carried below the watchlist floor, by TVL. */
export const EARLY_ROWS = 206;

/** Live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One farm step: what to do, what it costs, how long it takes, and its expected value. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
  ev: number;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    multiple: number;
    comps_n: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    reach_multiplier: number;
    signal_multiplier: number;
    tvl_z: number;
    growth_z: number;
    sector_z: number;
    momentum_pct: number;
    catalyst: string | null;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row thinned for data.js; the page regenerates the farm plan from it. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  comps_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  reach_multiplier: number;
  signal_multiplier: number;
  tvl_z: number;
  growth_z: number;
  sector_z: number;
  momentum_pct: number;
  catalyst: string | null;
}

/** A protocol that already trades: the board shows the market's value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One category's comparable multiple, as the dashboard's comps table shows it. */
export interface CategoryComp {
  category: string;
  comps: number;
  multiple: number;
}

/** One of the top ten, with the one-line thesis the dashboard's conviction section prints. */
export interface ConvictionEntry {
  rank: number;
  slug: string;
  name: string;
  thesis: string;
}

/** Everything the dashboard renders, built from one snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  global_comps: number;
  comps: CategoryComp[];
  rows: RadarRow[];
  live: LiveRow[];
  conviction: ConvictionEntry[];
}

/** Thrown when the snapshot file is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/* ---------------------------------------------------------- number helpers -- */

const DAY_MS = 86_400_000;

/** A finite number out of an unknown value, or `fallback` when it is not one. */
function asFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `x` into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** The middle of a sorted array, or null for an empty one. */
function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The mean of an array, or null for an empty one. */
function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** The population standard deviation of an array, or null when it has fewer than two values. */
function sdOf(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = meanOf(values);
  if (mean === null) return null;
  let sum = 0;
  for (const v of values) sum += (v - mean) * (v - mean);
  return Math.sqrt(sum / values.length);
}

/** The median absolute deviation of an array around its median, or null for an empty one. */
function madOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const med = medianOf(sorted);
  if (med === null) return null;
  const devs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return medianOf(devs);
}

/** Round to four decimals, as the dashboard's comps table prints it. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Round to two decimals, as the dashboard's z-scores print. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A dollar amount in the board's short form ($502.1M, $3.2K), for step and thesis text. */
export function shortUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/** Whole days from `listedAt` to `asOf`, never negative; null when either date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/* ------------------------------------------------------------- stage 1: parse -- */

/** A string field, or null when the value is not a string. */
function optString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A finite number field, or null when the value is not a finite number. */
function optNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A string array field: only the string members survive. */
function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) if (typeof item === 'string') out.push(item);
  return out;
}

/** One protocol entry out of a raw object, refused unless it carries slug, name and TVL. */
function parseProtocol(value: unknown, index: number): SnapshotProtocol {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotError(`snapshot.json's protocol ${index} is not an object`);
  }
  const p = value as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${index} lacks a slug, a name or a TVL`);
  }
  return {
    slug: p.slug,
    name: p.name,
    category: optString(p.category),
    chains: strList(p.chains),
    tvl_usd: p.tvl_usd,
    change_7d: optNumber(p.change_7d),
    mcap_usd: optNumber(p.mcap_usd),
    listed_at: optString(p.listed_at),
    gecko_id: optString(p.gecko_id),
    symbol: optString(p.symbol),
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols: o.protocols.map((v, i) => parseProtocol(v, i)),
    watchlist: o.watchlist as string[],
  };
}

/* ------------------------------------------------------- classification -- */

/** A name ending in a release marker (V2, v2, 2.0, …) is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A protocol records no token when all three token fields are null. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A protocol the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocols indexed by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/* ------------------------------------------------------------ stage 2: price -- */

/** The comparable multiples of one snapshot: per category, and one global fallback. */
export interface Multiples {
  byCategory: Map<string, { multiple: number; comps: number }>;
  global: { multiple: number; comps: number };
}

/** Keep a multiple inside the model's band. */
function bandMultiple(x: number, model: ModelConstants): number {
  return clamp(x, model.multiple_floor, model.multiple_cap);
}

/**
 * For each category, the median market-cap / TVL of its live-token protocols, when at least
 * `min_comps` of them exist; the global median across every live protocol otherwise. The
 * market itself prices each category, and the snapshot alone is the source.
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): Multiples {
  const perCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio)) continue;
    all.push(ratio);
    const key = p.category ?? 'Other';
    const bucket = perCategory.get(key);
    if (bucket !== undefined) bucket.push(ratio);
    else perCategory.set(key, [ratio]);
  }
  all.sort((a, b) => a - b);
  const globalMedian = medianOf(all);
  const global = {
    multiple: bandMultiple(globalMedian ?? 0.25, model),
    comps: all.length,
  };
  const byCategory = new Map<string, { multiple: number; comps: number }>();
  for (const [key, ratios] of perCategory) {
    ratios.sort((a, b) => a - b);
    if (ratios.length < model.min_comps) continue;
    const mid = medianOf(ratios);
    byCategory.set(key, { multiple: bandMultiple(mid ?? global.multiple, model), comps: ratios.length });
  }
  return { byCategory, global };
}

/** The multiple one category gets: its own comps when it has them, else the global median. */
export function multipleFor(category: string | null, multiples: Multiples): { multiple: number; comps: number } {
  return multiples.byCategory.get(category ?? 'Other') ?? multiples.global;
}

/* ----------------------------------------------------- stage 2b: sector stats -- */

/** One category's sector statistics, all computed from the snapshot's own figures. */
export interface SectorStats {
  category: string;
  /** Mean and sd of log10(mcap/TVL) of the category's live comps, for the sector z-score. */
  liveLogMean: number | null;
  liveLogSd: number | null;
  /** Mean and sd of log10(TVL) of the category's pre-token protocols, for the TVL z-score. */
  preTvlLogMean: number | null;
  preTvlLogSd: number | null;
  /** Median and MAD of the winsorised change_7d of the category's pre-token protocols. */
  growthMedian: number | null;
  growthMad: number | null;
}

/** The change_7d winsorised into the model's band, so one 4,448% week cannot move a sector. */
export function winsorGrowth(change7d: number | null, model: ModelConstants): number {
  return clamp(asFinite(change7d, 0), model.growth_winsor_lo, model.growth_winsor_hi);
}

/**
 * Every category's sector statistics: the live comps' log-ratio distribution, the pre-token
 * protocols' log-TVL distribution, and the pre-token protocols' winsorised growth median and
 * MAD. A category with too few members leaves its fields null, and the z-scores that read
 * them fall back to 0 — a thin sector is never scored on a statistic it cannot support.
 */
export function sectorStats(snapshot: Snapshot, model: ModelConstants = MODEL): Map<string, SectorStats> {
  const byCategory = new Map<string, { liveLogs: number[]; preTvlLogs: number[]; preGrowth: number[] }>();
  const bucketFor = (key: string): { liveLogs: number[]; preTvlLogs: number[]; preGrowth: number[] } => {
    let bucket = byCategory.get(key);
    if (bucket === undefined) {
      bucket = { liveLogs: [], preTvlLogs: [], preGrowth: [] };
      byCategory.set(key, bucket);
    }
    return bucket;
  };
  for (const p of snapshot.protocols) {
    const key = p.category ?? 'Other';
    const bucket = bucketFor(key);
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      const ratio = p.mcap_usd / p.tvl_usd;
      if (Number.isFinite(ratio) && ratio > 0) bucket.liveLogs.push(Math.log10(ratio));
    }
    if (isPreToken(p) && p.tvl_usd > 0) {
      bucket.preTvlLogs.push(Math.log10(p.tvl_usd));
      bucket.preGrowth.push(winsorGrowth(p.change_7d, model));
    }
  }
  const out = new Map<string, SectorStats>();
  for (const [category, b] of byCategory) {
    out.set(category, {
      category,
      liveLogMean: meanOf(b.liveLogs),
      liveLogSd: sdOf(b.liveLogs),
      preTvlLogMean: meanOf(b.preTvlLogs),
      preTvlLogSd: sdOf(b.preTvlLogs),
      growthMedian: medianOf([...b.preGrowth].sort((x, y) => x - y)),
      growthMad: madOf(b.preGrowth),
    });
  }
  return out;
}

/** A z-score, or 0 when the sector cannot support one (no mean, no spread, or a zero spread). */
function zOf(value: number, mean: number | null, sd: number | null): number {
  if (mean === null || sd === null || sd <= 0) return 0;
  const z = (value - mean) / sd;
  return Number.isFinite(z) ? clamp(z, -4, 4) : 0;
}

/* ------------------------------------------------------------ stage 3: score -- */

/** One protocol's score, factor by factor, so the dashboard can show each input. */
export interface Score {
  implied: number;
  multiple: number;
  comps: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  reachMult: number;
  signalMult: number;
  tvlZ: number;
  growthZ: number;
  sectorZ: number;
  momentumPct: number;
  catalyst: string | null;
  age: number | null;
}

/** The catalyst one protocol carries, or null: surge first, then young-giant, then multi-chain. */
export function catalystFor(
  protocol: SnapshotProtocol,
  age: number | null,
  growthW: number,
  model: ModelConstants,
): string | null {
  if (growthW >= model.catalyst_surge_pct) return 'surge';
  if (age !== null && age < model.catalyst_young_days && protocol.tvl_usd >= model.catalyst_young_tvl) return 'young-giant';
  if (protocol.chains.length >= model.catalyst_chains) return 'multi-chain';
  return null;
}

/** The words a catalyst prints as, for the board, the detail view and the thesis. */
export function catalystLabel(catalyst: string | null, protocol: SnapshotProtocol, growthW: number): string {
  if (catalyst === 'surge') return `7d surge of +${growthW.toFixed(1)}%`;
  if (catalyst === 'young-giant') return 'young protocol already at scale';
  if (catalyst === 'multi-chain') return `live on ${protocol.chains.length} chains`;
  return '';
}

/**
 * The multipliers and the implied value one protocol gets under `model`. The arithmetic is
 * written in the same order the dashboard's formula prints it, so the page's recomputation
 * lands on the same number board.json carries. The signal factor is the break from the
 * comps-only model: a protocol that is large for its own sector, growing faster than its
 * sector, or carrying a catalyst earns a higher implied value than its category median
 * alone would give it, and a protocol small and shrinking for its sector earns less.
 */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiples: Multiples,
  stats: Map<string, SectorStats>,
  globalLogMean: number | null,
  globalLogSd: number | null,
  model: ModelConstants,
): Score {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clamp(asFinite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const cappedAge = clamp(ageForModel, 0, model.maturity_days);
  const maturityMult = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
  const extraChains = clamp(protocol.chains.length - 1, 0, model.reach_max_chains);
  const reachMult = 1 + extraChains * model.reach_step;
  const { multiple, comps } = multipleFor(protocol.category, multiples);

  const sector = stats.get(protocol.category ?? 'Other');
  const growthW = winsorGrowth(protocol.change_7d, model);
  const tvlZ = round2(zOf(Math.log10(Math.max(1, protocol.tvl_usd)), sector?.preTvlLogMean ?? null, sector?.preTvlLogSd ?? null));
  const growthMedian = sector?.growthMedian ?? 0;
  const growthMad = sector?.growthMad ?? null;
  const growthZ = round2(zOf(growthW, growthMedian, growthMad === null ? null : 1.4826 * growthMad));
  const momentumPct = round2(growthW - growthMedian);
  const sectorZ = round2(zOf(Math.log10(Math.max(0.0001, multiple)), globalLogMean, globalLogSd));
  const catalyst = catalystFor(protocol, age, growthW, model);
  const signalMult = round4(
    clamp(
      1 + model.signal_tvl * Math.tanh(tvlZ) + model.signal_growth * Math.tanh(growthZ) + (catalyst !== null ? model.catalyst_boost : 0),
      model.signal_floor,
      model.signal_cap,
    ),
  );
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * reachMult * signalMult));
  return { implied, multiple, comps, growthPct, growthMult, maturityMult, reachMult, signalMult, tvlZ, growthZ, sectorZ, momentumPct, catalyst, age };
}

/** The global log-ratio mean and sd across every live protocol, for the sector z-score. */
export function globalLogStats(snapshot: Snapshot): { mean: number | null; sd: number | null } {
  const logs: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (Number.isFinite(ratio) && ratio > 0) logs.push(Math.log10(ratio));
  }
  return { mean: meanOf(logs), sd: sdOf(logs) };
}

/** Compare two protocols by implied value, then TVL, then slug: a total, deterministic order. */
function byValue(a: { implied: number; tvl: number; slug: string }, b: { implied: number; tvl: number; slug: string }): number {
  if (a.implied !== b.implied) return b.implied - a.implied;
  if (a.tvl !== b.tvl) return b.tvl - a.tvl;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** Compare two protocols by TVL, then slug: how the early radar picks its rows. */
function byTvl(a: SnapshotProtocol, b: SnapshotProtocol): number {
  if (a.tvl_usd !== b.tvl_usd) return b.tvl_usd - a.tvl_usd;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/* ------------------------------------------------------------ stage 4: farm plans -- */

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  const tiers: Array<[number, number]> = [
    [5_000_000_000, 250],
    [1_000_000_000, 150],
    [100_000_000, 100],
  ];
  for (const [floor, capital] of tiers) if (p.tvl_usd >= floor) return capital;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The expected value of one farm position, in dollars, under the stated assumption. */
export function evFor(implied: number, model: ModelConstants): number {
  return (implied * model.ev_allocation) / model.ev_farmers;
}

/** An expected value as the step text prints it: whole dollars above $100, cents below. */
export function evText(ev: number): string {
  if (ev >= 100) return `~$${Math.round(ev)}`;
  if (ev >= 10) return `~$${ev.toFixed(0)}`;
  return `~$${ev.toFixed(2)}`;
}

/** One category rule: when the category names one of `words`, the plan's action is `write`. */
interface ActionRule {
  words: string[];
  write: (name: string, capital: number, chain: string) => string;
}

/**
 * The action rules, in the order they are tried: the first rule whose word appears in the
 * category wins. The words are matched as substrings of the lowercased category, so a
 * category like "Lending" and one like "Lending (Borrowing)" take the same rule.
 */
const ACTION_RULES: ActionRule[] = [
  { words: ['lend', 'cdp', 'collateral'], write: (n, c, ch) => `Supply $${c} of USDC to ${n} on ${ch} and keep the position open.` },
  { words: ['dex', 'yield', 'leveraged farm'], write: (n, c, ch) => `Provide $${c} of liquidity to ${n}'s main pool on ${ch} and keep the position open.` },
  { words: ['bridge', 'cross chain'], write: (n, c, ch) => `Bridge $${c} of USDC to ${ch} through ${n} and use the bridged funds in its app.` },
  { words: ['staking', 'restak'], write: (n, c) => `Stake $${c} of the chain's staking asset through ${n} and keep the receipt token.` },
  { words: ['perpetual', 'derivative', 'options', 'synthetic'], write: (n, c) => `Deposit $${c} of USDC as margin on ${n} and open one small hedged position.` },
  { words: ['prediction'], write: (n, c) => `Fund $${c} and place one market position on ${n}.` },
  { words: ['curator', 'allocator', 'onchain capital'], write: (n, c, ch) => `Deposit $${c} into a ${n} vault on ${ch} and keep the shares.` },
  { words: ['stable'], write: (n, c, ch) => `Mint or deposit $${c} of the stable asset through ${n} on ${ch}.` },
  { words: ['rwa', 'basis'], write: (n, c, ch) => `Mint $${c} of the protocol's yield asset on ${ch} and hold it.` },
  { words: ['insurance'], write: (n, c, ch) => `Buy $${c} of cover from ${n} on ${ch} and keep the policy.` },
  { words: ['privacy'], write: (n, c, ch) => `Deposit $${c} through ${n}'s shielded pool on ${ch} and keep the receipt.` },
  { words: ['launchpad'], write: (n, c, ch) => `Commit $${c} to the next ${n} sale on ${ch} and hold the allocation.` },
  { words: ['nft'], write: (n, c, ch) => `Use $${c} to mint or trade through ${n} on ${ch} and keep the receipt.` },
  { words: ['gaming', 'social', 'ai'], write: (n, c, ch) => `Spend $${c} inside ${n} on ${ch} and keep the account active.` },
];

/** The fallback action when no rule names the category. */
function defaultAction(name: string, capital: number, chain: string): string {
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's one action, in words a farmer can follow. */
export function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.words.some((w) => c.includes(w))) return rule.write(p.name, capital, chain);
  }
  return defaultAction(p.name, capital, chain);
}

/** One weekly rule: when the category names one of `words`, the week looks like `text`. */
interface WeeklyRule {
  words: string[];
  text: string;
}

const WEEKLY_RULES: WeeklyRule[] = [
  { words: ['dex', 'yield'], text: 'Swap a small amount through the protocol each week and add a little liquidity when the pool moves.' },
  { words: ['lend', 'cdp', 'collateral'], text: 'Borrow a small amount against the deposit each week, then repay part of it so the loan stays active.' },
  { words: ['bridge', 'cross chain'], text: 'Bridge a small amount each week so the account shows repeated cross-chain use.' },
  { words: ['staking', 'restak'], text: 'Top up the stake by a small amount each week and claim any rewards the page shows.' },
  { words: ['perpetual', 'derivative'], text: 'Open and close one small position each week instead of leaving the account idle.' },
  { words: ['prediction'], text: 'Place one small market position each week on a market you have read.' },
];

/** The weekly qualifying action, matched to what the category actually does. */
export function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  for (const rule of WEEKLY_RULES) {
    if (rule.words.some((w) => c.includes(w))) return rule.text;
  }
  return 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
}

/** One step as a single string: its action, then its cost, time and expected value. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (step.ev > 0) s += ` Expected value: ${evText(step.ev)} at a 5% community allocation split across ~50,000 farmers.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** A protocol's share of its own TVL from one position, as the plan prints it. */
function poolShare(capital: number, tvl: number): string {
  const pct = (capital / Math.max(1, tvl)) * 100;
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  if (pct >= 0.0001) return `${pct.toFixed(4)}%`;
  if (pct >= 0.0000001) return `${pct.toFixed(7).replace(/0+$/, '')}%`;
  return '<0.0000001%';
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost, a time and an expected
 * value computed from the protocol's own figures. Step one is the prerequisite (a fresh
 * wallet); the five value steps that follow are ordered by expected value, highest first,
 * so the step a reader should do first is the step worth the most; the farm log closes
 * the plan. The first value step is protocol-specific: it names the protocol, its chain,
 * its capital and the share of its TVL that capital is, so no two rows share the same
 * opening move. Nothing here claims a token, an airdrop date or a points program exists:
 * the claim step says to check the protocol's own page, because the snapshot records no
 * token and a record is not proof there is none. The expected value is the model's own
 * claim under one stated assumption — a 5% community allocation of the implied value,
 * split across about 50,000 farmers — and it is printed next to every step it belongs to,
 * so a reader can see what each action is worth before paying its gas.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number, model: ModelConstants = MODEL): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const gas = capital >= 150 ? 8 : 4;
  const baseEv = evFor(implied, model);
  const share = poolShare(capital, p.tvl_usd);
  const main: FarmStep = {
    text: `${actionFor(p, capital, chain).replace(/\.$/, '')} — $${capital} is ${share} of its ${shortUsd(p.tvl_usd)} TVL on ${chain}.`,
    cost: `$${capital} of capital and about $${gas} of gas`,
    time: '15 minutes to set up',
    ev: baseEv,
  };
  const weekly: FarmStep = {
    text: `${weeklyFor(p)} Repeat it for ${weeks} weeks while the position is open.`,
    cost: `about $2 of gas a week, about $${2 * weeks} over ${weeks} weeks`,
    time: '10 minutes a week',
    ev: baseEv * 0.35,
  };
  const holdStep: FarmStep = {
    text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot, and do not withdraw early: an early exit forfeits the weeks already farmed.`,
    cost: `the $${capital} stays in the position`,
    time: `${hold} days`,
    ev: baseEv * 0.25,
  };
  const claim: FarmStep = {
    text: `Before you withdraw, open the protocol's own points or rewards page from its docs and claim only from a link it publishes.`,
    cost: 'no fee to check, and never pay to claim',
    time: '10 minutes',
    ev: baseEv * 0.1,
  };
  const monitor: FarmStep = {
    text: `Check ${p.name}'s TVL and seven-day growth once a week; if growth turns negative for two straight weeks, unwind half the position and move that capital to the next row on the board.`,
    cost: 'nothing but the check',
    time: '5 minutes a week',
    ev: baseEv * 0.05,
  };
  // The value steps, ordered by expected value, highest first: the reader's first move is
  // the move worth the most, and every step below it is worth less than the one above it.
  const valueSteps = [main, weekly, holdStep, claim, monitor].sort((a, b) => b.ev - a.ev);
  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
      ev: 0,
    },
    ...valueSteps,
    {
      text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      cost: 'nothing but the log',
      time: '5 minutes',
      ev: 0,
    },
  ];
}

/* ------------------------------------------------------- conviction -- */

/** A z-score in words, for the thesis: strong, mild, or near its sector's median. */
function zWords(z: number, what: string): string {
  const az = Math.abs(z);
  const dir = z >= 0 ? 'above' : 'below';
  if (az >= 1.5) return `${Math.abs(z).toFixed(1)}σ ${dir} its sector's ${what}`;
  if (az >= 0.5) return `${Math.abs(z).toFixed(1)}σ ${dir} its sector's ${what}`;
  return `near its sector's median ${what}`;
}

/** An age in words, for the thesis. */
function ageWords(age: number | null): string {
  if (age === null) return 'of unknown age';
  if (age >= 365) return `${(age / 365).toFixed(1)} years old`;
  return `${age} days old`;
}

/**
 * One top-ten protocol's thesis, in a single line: its TVL and category, where it stands
 * against its own sector on size and growth, how long it has run with no token on record,
 * and its catalyst when it carries one. Every clause comes from the snapshot's figures
 * through the same score the board ranks on, so the thesis and the rank never disagree.
 */
export function thesisFor(row: BoardRow): string {
  const growth = row.change_7d === null ? 'unreported growth' : `${row.change_7d >= 0 ? '+' : ''}${row.change_7d.toFixed(1)}% in 7d`;
  const catalyst = row.model.catalyst !== null
    ? ` — catalyst: ${catalystLabel(row.model.catalyst, { chains: row.chains, tvl_usd: row.tvl_usd } as SnapshotProtocol, winsorGrowth(row.change_7d, MODEL))}`
    : '';
  const thesis =
    `#${row.rank} ${row.name}: ${shortUsd(row.tvl_usd)} TVL in ${row.category ?? 'Other'}, ${zWords(row.model.tvl_z, 'pre-token TVL')} and ${zWords(row.model.growth_z, 'growth')} (${growth}, ${row.model.momentum_pct >= 0 ? '+' : ''}${row.model.momentum_pct.toFixed(1)} pts vs its sector), ${ageWords(row.model.age_days)} with no token on record${catalyst}.`;
  if (thesis.length <= 280) return thesis;
  return `${thesis.slice(0, 277)}...`;
}

/* ------------------------------------------------------- board assembly -- */

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const multiples = categoryMultiples(snapshot, model);
  const stats = sectorStats(snapshot, model);
  const global = globalLogStats(snapshot);
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is chosen, even one the snapshot no
  // longer carries (it cannot, but coverage is the gate's row and is never gambled on a
  // missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. A
  // chosen protocol stays chosen; the early rows only ever add to the board.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort(byTvl)
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const score = impliedValue(p, snapshot.as_of, multiples, stats, global.mean, global.sd, model);
    return { p, score };
  });
  scored.sort((a, b) => byValue(
    { implied: a.score.implied, tvl: a.p.tvl_usd, slug: a.p.slug },
    { implied: b.score.implied, tvl: b.p.tvl_usd, slug: b.p.slug },
  ));
  return scored.map((entry, i) => {
    const { p, score } = entry;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token' as const,
      age_days: score.age,
      implied_value_usd: score.implied,
      model: {
        multiple: score.multiple,
        comps_n: score.comps,
        growth_pct: score.growthPct,
        growth_multiplier: score.growthMult,
        maturity_multiplier: score.maturityMult,
        reach_multiplier: score.reachMult,
        signal_multiplier: score.signalMult,
        tvl_z: score.tvlZ,
        growth_z: score.growthZ,
        sector_z: score.sectorZ,
        momentum_pct: score.momentumPct,
        catalyst: score.catalyst,
        age_days: score.age,
      },
      farm_steps: farmSteps(p, score.age, score.implied, model).map(stepText),
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  live.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return live.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    multiple: row.model.multiple,
    comps_n: row.model.comps_n,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    reach_multiplier: row.model.reach_multiplier,
    signal_multiplier: row.model.signal_multiplier,
    tvl_z: row.model.tvl_z,
    growth_z: row.model.growth_z,
    sector_z: row.model.sector_z,
    momentum_pct: row.model.momentum_pct,
    catalyst: row.model.catalyst,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const multiples = categoryMultiples(snapshot, model);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const comps: CategoryComp[] = [...multiples.byCategory.entries()]
    .map(([category, v]) => ({ category, comps: v.comps, multiple: round4(v.multiple) }))
    .sort((a, b) => b.multiple - a.multiple || a.category.localeCompare(b.category));
  const conviction: ConvictionEntry[] = board.slice(0, 10).map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    thesis: thesisFor(r),
  }));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: round4(multiples.global.multiple),
    global_comps: multiples.global.comps,
    comps,
    rows: board.map(radarRow),
    live,
    conviction,
  };
  return { board, radar };
}

/* ------------------------------------------------------------- validation -- */

/**
 * Why a board is not one the gate will take, or null: coverage, ranks, order, one shared
 * implied value, and farm steps. The entrypoint refuses to write a board this flags.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(', ');
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${shown}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  const first = board[0];
  const last = board[board.length - 1];
  if (board.length >= 2 && first !== undefined && last !== undefined && first.implied_value_usd === last.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${first.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
