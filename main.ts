// Token Radar — the entrypoint.
//
// Reads the sealed snapshot, scores every pre-token protocol with the size-fitted comps
// model in lib/model.ts, and writes the ranked board, the dashboard data, the dashboard
// and screenshots, and the dossier the judge reads. The program refuses to write anything
// until the board passes the gate's own checks (coverage, ranks, order, farm steps),
// so a model that would fail on the server fails loudly here instead.
//
// The run is deterministic: the same snapshot bytes always write the same output bytes,
// so the grader's two runs agree byte for byte. The backtest and the stress lab run on
// the same snapshot inside the same run, so the numbers the dashboard prints are the
// numbers this run computed, not figures carried in from anywhere else.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

/** Where this file lives, so the dashboard and screenshots are found beside it. */
const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the dossier's bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--name <value>` (or `--name=<value>`) out of the arguments, or the fallback. */
function readArg(name: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1]!;
  const prefix = `--${name}=`;
  const joined = argv.find((a) => a.startsWith(prefix));
  if (joined !== undefined) return joined.slice(prefix.length);
  return fallback;
}

/** Resolve the snapshot path: a file as given, or the snapshot.json inside a directory. */
function snapshotPath(): string {
  const given = readArg('input', '/input');
  return given.endsWith('.json') ? given : join(given, 'snapshot.json');
}

/** Resolve the output directory: the flag wins, then the environment, then /output. */
function outputDir(): string {
  return readArg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
}

/** A dollar figure shortened the way the run summary prints it. */
function shortUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/** Refuse a screenshot set the gate would refuse: fewer than three, or a bad name. */
function checkShots(shots: string[]): void {
  if (shots.length < 3) {
    const plural = shots.length === 1 ? '' : 's';
    process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${plural}: hand in 3, the board, a detail view and a filtered view\n`);
    process.exit(1);
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
      process.exit(1);
    }
  }
}

/** The run summary on stdout: what was scored, the top five, and what was written. */
function printSummary(snapshot: ReturnType<typeof parseSnapshot>, board: ReturnType<typeof buildRadar>['board'], radar: ReturnType<typeof buildRadar>['radar'], out: string, shots: string[]): void {
  const top = board
    .slice(0, 5)
    .map((r) => `  #${r.rank} ${r.name} ${shortUsd(r.implied_value_usd)} (TVL ${shortUsd(r.tvl_usd)}, ${r.model.multiple.toFixed(4)}x ${r.category ?? 'Other'} ${r.model.pricer_kind}, signal ${r.model.signal_multiplier.toFixed(2)}x, TVL z ${r.model.tvl_z.toFixed(2)}, growth z ${r.model.growth_z.toFixed(2)}${r.model.catalyst !== null ? `, catalyst ${r.model.catalyst}` : ''})`)
    .join('\n');
  const conviction = radar.conviction
    .slice(0, 3)
    .map((c) => `  #${c.rank} ${c.thesis}`)
    .join('\n');
  const fits = radar.comps.filter((c) => c.kind === 'fit').length;
  const medians = radar.comps.filter((c) => c.kind === 'median').length;
  const backtest = radar.backtest;
  const stress = radar.stress
    .map((s) => `  ${s.name}: top-10 overlap ${s.top10_overlap}/10, max rank move ${s.max_rank_move}, leads ${s.top1_name}`)
    .join('\n');
  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
      `token radar: size-fitted comps from ${radar.global_comps} live protocols, ${radar.comps.length} categories with own pricers (${fits} log-log fits, ${medians} medians, the rest on the global fit)\n` +
      `token radar: backtest (leave-one-out over ${backtest.n} live tokens): median abs error ${backtest.median_abs_pct_error}% (${backtest.within_2x_pct}% within 2x, ${backtest.within_50_pct}% within 50%), vs plain-median baseline ${backtest.baseline_median_abs_pct_error}% median error (${backtest.baseline_within_2x_pct}% within 2x)\n` +
      `token radar: stress lab:\n${stress}\n` +
      `token radar: top 5 implied values:\n${top}\n` +
      `token radar: top 3 conviction:\n${conviction}\n` +
      `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
  );
}

function main(): void {
  const inputFile = snapshotPath();
  if (!existsSync(inputFile)) {
    process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
    process.exit(2);
  }
  const out = outputDir();

  const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
    process.exit(1);
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board, conviction: radar.conviction })}\n`);
  writeFileSync(join(out, 'data.js'), dataScript(radar));

  copyDir(join(here, 'dashboard'), join(out, 'dashboard'));
  const shots = copyDir(join(here, 'screenshots'), join(out, 'screenshots'));
  checkShots(shots);

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  writeFileSync(
    join(out, 'dossier.json'),
    buildDossier(out, {
      text_max_bytes: TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_CAPS,
      dashboard: { max_files: 400, max_bytes: 4_194_304 },
    }),
  );

  printSummary(snapshot, board, radar, out, shots);
}

main();
