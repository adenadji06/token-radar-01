// Token Radar — the dashboard.
//
// Reads window.RADAR (written beside dashboard/ by main.ts) and renders the ranked board,
// a filterable table, a per-protocol detail drawer with the model's own inputs and the
// protocol's farm plan, the top-ten conviction section, the size-fitted comparables
// table the model runs on, and the backtest and stress lab it is checked with. No
// network: every byte it shows is already in data.js. The page never prints the
// snapshot's source string, only its date, so no address ever appears in the page.
//
// The page recomputes every row's implied value from the snapshot figures with the same
// arithmetic main.ts runs, and the detail view says whether the two numbers agree — the
// board's data and the page's code are visibly the same model. The farm plan the page
// shows is the same derivation main.ts writes to board.json: category, chains, TVL, age,
// implied value and the signal factor decide the action, the capital, the hold, every cost,
// every time and every expected value. No name is special-cased, and the page's plan and
// the board's plan are the same strings.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;

  var app = document.getElementById('board');
  var state = {
    q: '',
    category: 'all',
    chain: 'all',
    mintvl: 0,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
  };

  /* ---------------------------------------------------------- formatting -- */

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  /** A dollar amount in the board's short form, or 'n/a' when there is none. */
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }

  /** A per-cent change with its sign, or 'n/a' when unreported. */
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  /** An age in days as years past a year, days otherwise, 'unknown' when unlisted. */
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  /** A multiple to two decimals with its x. */
  function fmtMult(n) {
    return (Math.round(n * 100) / 100).toFixed(2) + 'x';
  }

  /** A z-score with its sign and sigma, or 'n/a' when it is not a number. */
  function fmtZ(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + 'σ';
  }

  /** An expected value as the farm plan prints it. */
  function fmtEv(ev) {
    if (ev >= 100) return '~$' + Math.round(ev);
    if (ev >= 10) return '~$' + ev.toFixed(0);
    return '~$' + ev.toFixed(2);
  }

  /** The short words for a catalyst flag. */
  function catalystShort(catalyst, row) {
    if (catalyst === 'surge') return 'surge';
    if (catalyst === 'young-giant') return 'young + large';
    if (catalyst === 'multi-chain') return (row.chains || []).length + ' chains';
    return '';
  }

  /**
   * A row's implied value, recomputed here from the snapshot figures with the model's own
   * arithmetic, including the signal factor the row carries. The multiple is the row's
   * category comparable, already carried in the data; the signal multiplier is the
   * sector-relative factor main.ts computed from the same snapshot.
   */
  function impliedOf(row, model) {
    var change = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, change));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var cappedAge = Math.min(Math.max(age, 0), model.maturity_days);
    var maturity = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
    var chains = (row.chains || []).length;
    var reach = 1 + Math.min(Math.max(chains - 1, 0), model.reach_max_chains) * model.reach_step;
    var signal = row.signal_multiplier === null || row.signal_multiplier === undefined ? 1 : row.signal_multiplier;
    return Math.max(1, Math.round(row.tvl_usd * row.multiple * growthMult * maturity * reach * signal));
  }

  /* ------------------------------------------------------ element builder -- */

  /**
   * Build one element: `h('div', { class: 'x', text: 'hi' }, child1, [child2, child3])`.
   * Attribute keys: class sets the class name, text sets text content, html sets inner HTML,
   * on* registers a listener, anything else is set as an attribute unless null/undefined.
   * Children may be elements, strings, arrays of either, or null (skipped).
   */
  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else if (value !== null && value !== undefined) node.setAttribute(key, value);
      });
    }
    for (var i = 2; i < arguments.length; i++) appendChild(node, arguments[i]);
    return node;
  }

  function appendChild(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (c) { appendChild(node, c); });
      return;
    }
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else node.appendChild(child);
  }

  /* ------------------------------------------------------- farm plan, page -- */

  // The farm plan is the same derivation main.ts writes to board.json: category, chains,
  // TVL, age and implied value decide the action, the capital, the hold, every cost, every
  // time and every expected value. No name is special-cased, and the page's plan and the
  // board's plan are the same strings. The six value steps are ordered by expected value,
  // highest first, with the fresh-wallet prerequisite before them and the farm log after.
  function chainOf(p) {
    return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
  }

  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }

  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  /** The expected value of one farm position, under the stated 5% / 50,000-farmer assumption. */
  function evFor(implied) {
    return (implied * DATA.model.ev_allocation) / DATA.model.ev_farmers;
  }

  /** A protocol's share of its own TVL from one position, as the plan prints it. */
  function poolShare(capital, tvl) {
    var pct = (capital / Math.max(1, tvl)) * 100;
    if (pct >= 0.01) return pct.toFixed(2) + '%';
    if (pct >= 0.0001) return pct.toFixed(4) + '%';
    if (pct >= 0.0000001) return pct.toFixed(7).replace(/0+$/, '') + '%';
    return '<0.0000001%';
  }

  /** Action rules, first match wins: words matched as substrings of the lowercased category. */
  var ACTION_RULES = [
    { words: ['lend', 'cdp', 'collateral'], write: function (n, c, ch) { return 'Supply $' + c + ' of USDC to ' + n + ' on ' + ch + ' and keep the position open.'; } },
    { words: ['dex', 'yield', 'leveraged farm'], write: function (n, c, ch) { return 'Provide $' + c + ' of liquidity to ' + n + "'s main pool on " + ch + ' and keep the position open.'; } },
    { words: ['bridge', 'cross chain'], write: function (n, c, ch) { return 'Bridge $' + c + ' of USDC to ' + ch + ' through ' + n + ' and use the bridged funds in its app.'; } },
    { words: ['staking', 'restak'], write: function (n, c) { return "Stake $" + c + " of the chain's staking asset through " + n + ' and keep the receipt token.'; } },
    { words: ['perpetual', 'derivative', 'options', 'synthetic'], write: function (n, c) { return 'Deposit $' + c + ' of USDC as margin on ' + n + ' and open one small hedged position.'; } },
    { words: ['prediction'], write: function (n, c) { return 'Fund $' + c + ' and place one market position on ' + n + '.'; } },
    { words: ['curator', 'allocator', 'onchain capital'], write: function (n, c, ch) { return 'Deposit $' + c + ' into a ' + n + ' vault on ' + ch + ' and keep the shares.'; } },
    { words: ['stable'], write: function (n, c, ch) { return 'Mint or deposit $' + c + ' of the stable asset through ' + n + ' on ' + ch + '.'; } },
    { words: ['rwa', 'basis'], write: function (n, c, ch) { return "Mint $" + c + " of the protocol's yield asset on " + ch + ' and hold it.'; } },
    { words: ['insurance'], write: function (n, c, ch) { return 'Buy $' + c + ' of cover from ' + n + ' on ' + ch + ' and keep the policy.'; } },
    { words: ['privacy'], write: function (n, c, ch) { return 'Deposit $' + c + " through " + n + "'s shielded pool on " + ch + ' and keep the receipt.'; } },
    { words: ['launchpad'], write: function (n, c, ch) { return 'Commit $' + c + ' to the next ' + n + ' sale on ' + ch + ' and hold the allocation.'; } },
    { words: ['nft'], write: function (n, c, ch) { return 'Use $' + c + ' to mint or trade through ' + n + ' on ' + ch + ' and keep the receipt.'; } },
    { words: ['gaming', 'social', 'ai'], write: function (n, c, ch) { return 'Spend $' + c + ' inside ' + n + ' on ' + ch + ' and keep the account active.'; } },
  ];

  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    for (var i = 0; i < ACTION_RULES.length; i++) {
      var rule = ACTION_RULES[i];
      if (rule.words.some(function (w) { return c.indexOf(w) >= 0; })) return rule.write(p.name, capital, chain);
    }
    return 'Deposit $' + capital + ' of USDC into ' + p.name + ' on ' + chain + ' and keep the position open.';
  }

  /** Weekly rules, first match wins, same substring matching as the action rules. */
  var WEEKLY_RULES = [
    { words: ['dex', 'yield'], text: 'Swap a small amount through the protocol each week and add a little liquidity when the pool moves.' },
    { words: ['lend', 'cdp', 'collateral'], text: 'Borrow a small amount against the deposit each week, then repay part of it so the loan stays active.' },
    { words: ['bridge', 'cross chain'], text: 'Bridge a small amount each week so the account shows repeated cross-chain use.' },
    { words: ['staking', 'restak'], text: 'Top up the stake by a small amount each week and claim any rewards the page shows.' },
    { words: ['perpetual', 'derivative'], text: 'Open and close one small position each week instead of leaving the account idle.' },
    { words: ['prediction'], text: 'Place one small market position each week on a market you have read.' },
  ];

  function weeklyFor(p) {
    var c = (p.category || '').toLowerCase();
    for (var i = 0; i < WEEKLY_RULES.length; i++) {
      var rule = WEEKLY_RULES[i];
      if (rule.words.some(function (w) { return c.indexOf(w) >= 0; })) return rule.text;
    }
    return 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
  }

  /** Mechanism rules, first match wins, same order and words as the action rules: how the
      category earns, and the one risk check that mechanism demands every week. */
  var MECHANISM_RULES = [
    { words: ['lend', 'cdp', 'collateral'], m: 'borrowers pay interest on supplied collateral, and the protocol keeps the spread plus liquidation fees', r: 'Check the health factor of the borrow; if it falls below 2.0, repay part of the borrow or add collateral before it nears liquidation' },
    { words: ['dex', 'yield', 'leveraged farm'], m: 'swap fees and incentives paid to liquidity providers', r: 'Check the pool price against your liquidity range; if the price leaves the range, re-centre it or accept the impermanent loss before withdrawing' },
    { words: ['bridge', 'cross chain'], m: 'relayer and bridging fees on each transfer', r: 'Check that the destination chain shows the bridged funds and the bridge\u2019s own status page reports no incident before bridging more' },
    { words: ['staking', 'restak'], m: 'validator rewards shared with stakers', r: 'Check the unbonding period and whether your validator is still in the active set; restake elsewhere if it drops out' },
    { words: ['perpetual', 'derivative', 'options', 'synthetic'], m: 'trading fees and funding payments from open positions', r: 'Check the funding rate and your liquidation price while a position is open; close it if funding runs against you for three days' },
    { words: ['prediction'], m: 'fees on resolved markets', r: 'Check the market\u2019s resolution rules before placing a position; a market that resolves on an ambiguous outcome can pay nothing' },
    { words: ['curator', 'allocator', 'onchain capital'], m: 'performance and management fees on the vault\u2019s strategy', r: 'Check the vault\u2019s strategy and its curator\u2019s recent changes; withdraw if the strategy changes to one you did not sign up for' },
    { words: ['stable'], m: 'minting fees and yield on the reserves backing the stable asset', r: 'Check the peg; if the stable asset trades below $0.99 for more than a day, unwind the position' },
    { words: ['rwa', 'basis'], m: 'yield on the real-world or basis assets backing the token', r: 'Check the backing and the redemption queue; if redemptions pause, treat the position as locked and stop adding' },
    { words: ['insurance'], m: 'premiums paid by protocols buying cover', r: 'Check the cover\u2019s terms and the claims queue; a claim filed against your pool pays out of staked capital' },
    { words: ['privacy'], m: 'fees on shielded transfers', r: 'Check the shielded pool\u2019s anonymity set; a shrinking set weakens the privacy the deposit buys' },
    { words: ['launchpad'], m: 'allocation fees on token sales', r: 'Check the sale\u2019s vesting terms before committing; a long cliff turns a quick flip into a months-long hold' },
    { words: ['nft'], m: 'trading and mint fees', r: 'Check the floor price and the collection\u2019s volume; an illiquid collection can take weeks to exit' },
    { words: ['gaming', 'social', 'ai'], m: 'fees on in-app spending', r: 'Check the app\u2019s reward rules; a rule change can cut the points a session earns' },
  ];

  function mechanismFor(p) {
    var c = (p.category || '').toLowerCase();
    for (var i = 0; i < MECHANISM_RULES.length; i++) {
      var rule = MECHANISM_RULES[i];
      if (rule.words.some(function (w) { return c.indexOf(w) >= 0; })) return { mechanism: rule.m, risk: rule.r };
    }
    return { mechanism: 'fees on the activity it hosts', risk: 'Check the protocol\u2019s TVL and seven-day growth; if growth turns negative for two straight weeks, unwind half the position' };
  }

  /** One step as a single string: its action, then its cost, time and expected value. */
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (step.ev > 0) s += ' Expected value: ' + fmtEv(step.ev) + ' at a 5% community allocation split across ~50,000 farmers.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }

  /** A protocol's eight-step farm plan, each step an action with a cost, a time and an EV. */
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var weeks = Math.max(1, Math.ceil(hold / 7));
    var gas = capital >= 150 ? 8 : 4;
    var baseEv = evFor(p.implied_value_usd);
    var share = poolShare(capital, p.tvl_usd);
    var mech = mechanismFor(p);
    var main = {
      text: actionFor(p, capital, chain).replace(/\.$/, '') + ' — $' + capital + ' is ' + share + ' of its ' + fmtUsd(p.tvl_usd) + ' TVL on ' + chain + '. The protocol earns ' + mech.mechanism + '.',
      cost: '$' + capital + ' of capital and about $' + gas + ' of gas',
      time: '15 minutes to set up',
      ev: baseEv,
    };
    var weekly = {
      text: weeklyFor(p) + ' Repeat it for ' + weeks + ' weeks while the position is open.',
      cost: 'about $2 of gas a week, about $' + (2 * weeks) + ' over ' + weeks + ' weeks',
      time: '10 minutes a week',
      ev: baseEv * 0.35,
    };
    var holdStep = {
      text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot, and do not withdraw early: an early exit forfeits the weeks already farmed.',
      cost: 'the $' + capital + ' stays in the position',
      time: hold + ' days',
      ev: baseEv * 0.25,
    };
    var riskStep = {
      text: mech.risk + '. Do this check once a week while the position is open, and act on it the same day it trips.',
      cost: 'nothing but the check',
      time: '10 minutes a week',
      ev: baseEv * 0.15,
    };
    var claim = {
      text: "Before you withdraw, open the protocol's own points or rewards page from its docs and claim only from a link it publishes.",
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
      ev: baseEv * 0.1,
    };
    var monitor = {
      text: "Check " + p.name + "'s TVL and seven-day growth once a week; if growth turns negative for two straight weeks, unwind half the position and move that capital to the next row on the board.",
      cost: 'nothing but the check',
      time: '5 minutes a week',
      ev: baseEv * 0.05,
    };
    var valueSteps = [main, weekly, holdStep, riskStep, claim, monitor].sort(function (a, b) { return b.ev - a.ev; });
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes', ev: 0 },
    ].concat(valueSteps).concat([
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes', ev: 0 },
    ]).map(stepText);
  }

  /* ------------------------------------------------------------ URL state -- */

  /** Read the filter, tab, sort and selection out of the location hash. */
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('mintvl')) state.mintvl = Number(params.get('mintvl')) || 0;
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('sort')) state.sort = params.get('sort');
    if (params.get('dir')) state.dir = params.get('dir') === '1' ? 1 : -1;
  }

  /** Write the current filter, tab, sort and selection back into the hash. */
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.mintvl) params.set('mintvl', String(state.mintvl));
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.dir !== -1) params.set('dir', String(state.dir));
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /* ----------------------------------------------------- filtering + sorting -- */

  /** The board rows the current filters let through. */
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (r.tvl_usd < state.mintvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  /** The value one row sorts by under the current sort key. */
  function sortValue(r) {
    if (state.sort === 'name') return r.name.toLowerCase();
    if (state.sort === 'tvl') return r.tvl_usd;
    if (state.sort === 'growth') return r.change_7d === null ? -Infinity : r.change_7d;
    if (state.sort === 'age') return r.age_days === null ? Infinity : r.age_days;
    if (state.sort === 'multiple') return r.multiple;
    if (state.sort === 'signal') return r.signal_multiplier;
    return r.implied_value_usd;
  }

  /** A filtered list in the current sort order, ties broken by slug. */
  function sortedRows(list) {
    return list.slice().sort(function (a, b) {
      var av = sortValue(a);
      var bv = sortValue(b);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  /** Clear every filter back to the full board. */
  function clearFilters() {
    state.q = '';
    state.category = 'all';
    state.chain = 'all';
    state.mintvl = 0;
    writeHash();
    render();
  }

  /* ------------------------------------------------------------- sections -- */

  function header() {
    return h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'mark' }), h('span', { class: 'brand-name', html: 'TOKEN <em>RADAR</em>' })),
      h('div', { class: 'top-meta' },
        h('span', null, h('span', { class: 'live-dot' }), 'Snapshot ' + DATA.as_of),
        h('span', { text: 'DefiLlama protocol index' }),
        h('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    return h('section', { class: 'lede' },
      h('div', null,
        h('h1', { html: DATA.watchlist_size + ' watchlist protocols, ranked by <span class="hl">implied value</span>' }),
        h('p', null,
          'The board is every protocol the watchlist rule keeps, at any size: the ', h('b', { text: String(DATA.watchlist_size) }),
          ' on the watchlist plus ', h('b', { text: String(DATA.early_size) }),
          ' more that record no token and are not a wrapped, staked or bridged product of one that trades. Implied value is a size-fitted comparables price — a log-log fit of live-token market caps on TVL in the same category, so a large protocol is priced at the multiple large live protocols actually carry — then adjusted by sector-relative signals: how large the protocol is for its own sector, how fast it grows against its sector, and any catalyst it carries. It is not a promise and not a price.'
        )
      ),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('span', { text: 'Watchlist covered' }), h('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        h('div', { class: 'fact' }, h('span', { text: 'Pre-token rows scored' }), h('b', { text: String(DATA.board_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Rows outside the watchlist' }), h('b', { text: String(DATA.early_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Backtest median error' }), h('b', { text: DATA.backtest.median_abs_pct_error + '% over ' + DATA.backtest.n + ' live tokens' })),
        h('div', { class: 'fact' }, h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(DATA.live_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Global median multiple' }), h('b', { text: fmtMult(DATA.global_multiple) + ' (' + DATA.global_comps + ' live tokens)' }))
      )
    );
  }

  function podium() {
    var top = DATA.rows.slice(0, 3);
    return h('section', { class: 'podium', 'aria-label': 'Top three by implied value' }, top.map(function (r) {
      return h('button', { type: 'button', class: 'pod', onclick: function () { openDetail(r.slug); } },
        h('span', { class: 'rank', text: 'RANK #' + r.rank + ' · ' + (r.category || 'Other').toUpperCase() }),
        h('span', { class: 'name', text: r.name }),
        h('span', { class: 'val', text: fmtUsd(r.implied_value_usd) }),
        h('span', { class: 'sub', text: 'TVL ' + fmtUsd(r.tvl_usd) + ' · ' + fmtMult(r.multiple) + ' comparable · signal ' + fmtMult(r.signal_multiplier) + (r.catalyst ? ' · ' + catalystShort(r.catalyst, r) : '') })
      );
    }));
  }

  /** The top-ten conviction section: one thesis line per protocol, each opening its detail. */
  function conviction() {
    var items = (DATA.conviction || []).map(function (c) {
      return h('li', null,
        h('button', { type: 'button', class: 'thesis', onclick: function () { openDetail(c.slug); } },
          h('span', { class: 'thesis-text', text: c.thesis })
        )
      );
    });
    return h('section', { class: 'panel conviction' },
      h('h2', { text: 'Top 10 conviction — why these ten, in one line each' }),
      h('p', { class: 'sub', text: 'Each thesis is written from the same snapshot figures the board ranks on: the protocol’s TVL and category, its size and growth against its own sector, how long it has run with no token on record, and its catalyst when it carries one. Select a line to open that protocol’s model and farm plan.' }),
      h('ol', { class: 'thesis-list' }, items)
    );
  }

  /** One filter control: a labelled search box, select or tab group. */
  function field(label, forId, control) {
    return h('div', { class: 'field' }, h('label', { for: forId, text: label }), control);
  }

  function option(value, label, isSelected) {
    return h('option', { value: value, text: label, selected: isSelected ? 'selected' : null });
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();

    var search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });

    var categorySel = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      option('all', 'All categories', state.category === 'all'),
      categories.map(function (c) { return option(c, c, c === state.category); })
    );
    categorySel.addEventListener('change', function () { state.category = categorySel.value; writeHash(); render(); });

    var chainSel = h('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      option('all', 'All chains', state.chain === 'all'),
      chains.map(function (c) { return option(c, c, c === state.chain); })
    );
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); render(); });

    var tvlOptions = [['0', 'Any TVL'], ['5000000', 'TVL $5M+'], ['50000000', 'TVL $50M+ (watchlist)'], ['250000000', 'TVL $250M+'], ['1000000000', 'TVL $1B+']];
    var tvlSel = h('select', { id: 'mintvl', 'aria-label': 'Filter by minimum TVL' },
      tvlOptions.map(function (o) { return option(o[0], o[1], String(state.mintvl) === o[0]); })
    );
    tvlSel.addEventListener('change', function () { state.mintvl = Number(tvlSel.value) || 0; writeHash(); render(); });

    var preTab = h('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } });
    var liveTab = h('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    var tabs = h('div', { class: 'tabs' }, preTab, liveTab);
    var countText = state.tab === 'pre-token' ? filteredRows().length + ' rows shown' : DATA.live.length + ' live-token protocols';

    return h('div', { class: 'controls' },
      field('Search', 'q', search),
      field('Category', 'category', categorySel),
      field('Chain', 'chain', chainSel),
      field('Min TVL', 'mintvl', tvlSel),
      h('div', { class: 'field' }, h('span', { class: 'sub', text: 'Token status' }), tabs),
      h('span', { class: 'count', text: countText })
    );
  }

  /** One sortable column header: clicking it sorts, or flips the direction. */
  function sortHeader(key, label) {
    var arrow = state.sort === key ? h('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null;
    var button = h('button', { type: 'button' }, label, arrow);
    button.addEventListener('click', function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = -1; }
      writeHash();
      render();
    });
    return h('th', { scope: 'col' }, button);
  }

  /** The chain list a row shows, or the fallback when it names none. */
  function chainList(r, max) {
    if (r.chains && r.chains.length) return r.chains.slice(0, max).join(', ');
    return 'an unnamed chain';
  }

  /** One board row: rank, protocol, TVL, growth, age, multiple, signal, implied value, token status. */
  function boardRow(r, maxImplied) {
    var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
    var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
    var barWidth = Math.max(3, Math.round((r.implied_value_usd / maxImplied) * 100));
    var signalCell = h('td', { class: 'num signal' },
      h('span', { text: fmtMult(r.signal_multiplier) }),
      r.catalyst ? h('span', { class: 'catalyst', text: catalystShort(r.catalyst, r) }) : null
    );
    var tr = h('tr', {
      'data-selected': state.selected === r.slug ? 'true' : 'false',
      tabindex: '0',
      onclick: function () { openDetail(r.slug); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } },
    },
      h('td', { class: 'num rank-badge' + (r.rank <= 3 ? ' top' : ''), text: '#' + String(r.rank) }),
      h('td', null, h('div', { class: 'name' },
        h('b', { text: r.name }),
        h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainList(r, 2) })
      )),
      h('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
      h('td', { class: 'num ' + growthClass, text: growth }),
      h('td', { class: 'num', text: fmtAge(r.age_days) }),
      h('td', { class: 'num mult', text: fmtMult(r.multiple) }),
      signalCell,
      h('td', null, h('div', { class: 'implied' },
        h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + barWidth + '%' })),
        h('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
      )),
      h('td', null, h('span', { class: 'status', text: 'records no token' }))
    );
    return tr;
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: clearFilters })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = h('tbody');
    list.forEach(function (r) { tbody.appendChild(boardRow(r, max)); });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model, its signals and its farm plan.' }),
          h('thead', null, h('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('multiple', 'Comp x'),
            sortHeader('signal', 'Signal'),
            sortHeader('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  /** One live-token row: it already trades, so its market cap is shown, not a model. */
  function liveRow(r) {
    var growthClass = r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg';
    return h('tr', null,
      h('td', { class: 'num', text: 'live' }),
      h('td', null, h('div', { class: 'name' },
        h('b', { text: r.name }),
        h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainList(r, 2) })
      )),
      h('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
      h('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
      h('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
      h('td', null, h('span', { class: 'status live', text: 'already trades' }))
    );
  }

  function liveTable() {
    var tbody = h('tbody');
    DATA.live.forEach(function (r) { tbody.appendChild(liveRow(r)); });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking — and they are the comparables that price it.' }),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', text: 'Status' }),
            h('th', { scope: 'col', text: 'Protocol' }),
            h('th', { scope: 'col', text: 'TVL' }),
            h('th', { scope: 'col', text: '7d' }),
            h('th', { scope: 'col', text: 'Market cap' }),
            h('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function pricerLabel(kind) {
    if (kind === 'fit') return 'size fit';
    if (kind === 'global-fit') return 'global fit';
    return 'median';
  }

  function modelPanel() {
    var m = DATA.model;
    var compsRows = DATA.comps.slice(0, 12).map(function (c) {
      return h('tr', null,
        h('td', { text: c.category }),
        h('td', { class: 'num', text: String(c.comps) }),
        h('td', { text: pricerLabel(c.kind) }),
        h('td', { class: 'num', text: c.slope === null || c.slope === undefined ? '—' : c.slope.toFixed(2) }),
        h('td', { class: 'num', text: c.r2 === null || c.r2 === undefined ? '—' : c.r2.toFixed(2) }),
        h('td', { class: 'num', text: fmtMult(c.multiple) })
      );
    });
    var formula = 'base = size-fitted comparables price: log10(mcap) = a + b x log10(tvl), fitted on the live-token protocols of the row’s own category (5+ comps); the category median mcap / TVL where comps are thin (3-4); the global fit where thinner still. implied = round( base x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x (1 + min(chains - 1, ' + m.reach_max_chains + ') x ' + m.reach_step + ') x signal )';
    var signalFormula = 'signal = clamp( 1 + ' + m.signal_tvl + ' x tanh(tvl_z) + ' + m.signal_growth + ' x tanh(growth_z) + ' + m.catalyst_boost + ' when a catalyst is present, ' + m.signal_floor + ', ' + m.signal_cap + ' )';
    var bt = DATA.backtest;
    var stressRows = DATA.stress.map(function (s) {
      return h('tr', null,
        h('td', { text: s.name }),
        h('td', { class: 'num', text: s.top10_overlap + ' / 10' }),
        h('td', { class: 'num', text: String(s.max_rank_move) }),
        h('td', { text: s.top1_name })
      );
    });
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. The price is not a guess and not a flat median: a plain median multiple prices a $5M protocol and a $2B protocol at the same ratio, and the market does not — larger protocols trade at a different multiple of TVL than small ones — so each category is fitted with a log-log line of market cap on TVL, and the multiple is read off that line at the row’s own size. Categories with fewer than ' + m.min_fit_comps + ' live comparables use their median multiple, and the thinnest use the global fit across ' + DATA.global_comps + ' live tokens. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' }, formula),
      h('div', { class: 'formula' }, signalFormula),
      h('p', { class: 'sub', text: 'The signal factor is what separates this board from a comps table. tvl_z is the z-score of log TVL among the pre-token protocols of the row’s own category; growth_z is the z-score of its winsorised seven-day growth against its category’s median and MAD, so one 4,000% week cannot move a sector; momentum is the winsorised growth minus the category median, in points; the sector z-score compares the category’s own multiple with the global live-token distribution. A catalyst — a seven-day surge of ' + m.catalyst_surge_pct + '% or more, a protocol under ' + m.catalyst_young_days + ' days old already at ' + fmtUsd(m.catalyst_young_tvl) + ' of TVL, or a presence on ' + m.catalyst_chains + ' or more chains — adds ' + m.catalyst_boost + ' to the factor.' }),
      h('p', { class: 'sub', text: 'Each farm step states its expected value under one stated assumption: a 5% community allocation of the implied value, split across about 50,000 farmers. The value steps are ordered by that expected value, highest first, so the first move is the move worth the most. Each plan is mechanism-aware: the opening step names how the protocol earns, and the risk step is the one check that mechanism demands every week, with the threshold that says to stop.' }),
      h('h3', { text: 'Comparable prices by category — multiple at $100M of TVL' }),
      h('table', { class: 'comps' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col', text: 'Category' }),
          h('th', { scope: 'col', class: 'num', text: 'Live comps' }),
          h('th', { scope: 'col', text: 'Method' }),
          h('th', { scope: 'col', class: 'num', text: 'Slope' }),
          h('th', { scope: 'col', class: 'num', text: 'R²' }),
          h('th', { scope: 'col', class: 'num', text: 'Multiple @ $100M' })
        )),
        h('tbody', null, compsRows)
      ),
      h('h3', { text: 'Backtest — pricing the live market with itself' }),
      h('p', { class: 'sub', text: 'Leave-one-out over ' + bt.n + ' live-token protocols: each one is priced by the method trained on the other ' + (bt.n - 1) + ', and the prediction is scored against the market cap the market actually gave it. Median absolute error ' + bt.median_abs_pct_error + '%, ' + bt.within_2x_pct + '% of predictions within 2x of the real market cap and ' + bt.within_50_pct + '% within 50%. The plain median-multiple method, on the same leave-one-out training sets, misses by ' + bt.baseline_median_abs_pct_error + '% at the median (' + bt.baseline_within_2x_pct + '% within 2x) — the size fit earns its keep.' }),
      h('h3', { text: 'Stress lab — what survives a change of assumption' }),
      h('table', { class: 'comps' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col', text: 'Scenario' }),
          h('th', { scope: 'col', class: 'num', text: 'Top-10 overlap' }),
          h('th', { scope: 'col', class: 'num', text: 'Max rank move' }),
          h('th', { scope: 'col', text: 'Leads under the scenario' })
        )),
        h('tbody', null, stressRows)
      ),
      h('p', { class: 'sub', text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. The board is every protocol the watchlist rule keeps, at any size — the watchlist plus the rest the rule keeps below the floor and above it — and the live-token protocols are set aside with their market caps shown.' })
    );
  }

  function caveats() {
    return h('section', { class: 'caveats' },
      h('p', null, h('b', { text: 'Read this before farming. ' }), 'Implied value is this entry\u2019s own claim from the snapshot\u2019s figures, never a price and never a promise a token is coming. The snapshot records no token for these protocols; it does not prove they have none. A farm plan costs real gas and real capital, and a protocol can change its rules, cap its rewards or never issue a token at all.'),
      h('p', { text: 'Never pay to claim anything: a real claim link comes from the protocol\u2019s own docs, and any page that asks for a fee or a seed phrase to claim is a scam.' })
    );
  }

  /* ------------------------------------------------------- detail drawer -- */

  var dialog = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  /** One row of the detail view's equation: a label and its value. */
  function equationRow(label, value) {
    return h('div', null, h('span', { text: label }), h('b', { class: 'num', text: value }));
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';

    var recomputed = impliedOf(row, DATA.model);
    var agrees = recomputed === row.implied_value_usd;
    var verdict = 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed) + (agrees ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.';
    var chainsText = row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain';

    dialog.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + chainsText })
      ),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));

    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        equationRow('TVL', fmtUsd(row.tvl_usd)),
        equationRow('Comparable multiple (' + (row.category || 'Other') + ', ' + row.comps_n + ' live comps)', fmtMult(row.multiple)),
        equationRow('Comparable pricing', pricerLabel(row.pricer_kind) + (row.pricer_kind === 'fit' || row.pricer_kind === 'global-fit' ? ' — multiple read off the log-log fit at this TVL' : ' — category median mcap / TVL')),
        row.fit_slope === null || row.fit_slope === undefined ? null : equationRow('Fit slope (log mcap on log TVL)', row.fit_slope.toFixed(2)),
        row.fit_r2 === null || row.fit_r2 === undefined ? null : equationRow('Fit R² (share of the category the fit explains)', row.fit_r2.toFixed(2)),
        equationRow('Seven-day growth', fmtPct(row.change_7d)),
        equationRow('Age with no token', fmtAge(row.age_days)),
        equationRow('Growth multiplier', row.growth_multiplier.toFixed(4)),
        equationRow('Maturity multiplier', row.maturity_multiplier.toFixed(4)),
        equationRow('Multi-chain reach', row.reach_multiplier.toFixed(4)),
        h('div', { class: 'total' }, h('span', { text: 'Implied value' }), h('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      h('p', { class: 'sub', text: verdict })
    ));

    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Sector signals — where it stands against its own category' }),
      h('div', { class: 'equation' },
        equationRow('TVL z-score (log TVL vs its sector)', fmtZ(row.tvl_z)),
        equationRow('Growth z-score (winsorised 7d vs its sector)', fmtZ(row.growth_z)),
        equationRow('Sector z-score (its category multiple vs the market)', fmtZ(row.sector_z)),
        equationRow('Momentum vs its sector median', (row.momentum_pct >= 0 ? '+' : '') + row.momentum_pct.toFixed(2) + ' pts'),
        equationRow('Catalyst', row.catalyst ? catalystShort(row.catalyst, row) : 'none'),
        equationRow('Signal multiplier', fmtMult(row.signal_multiplier))
      ),
      h('p', { class: 'sub', text: 'Z-scores are measured against the other protocols in this row’s own category, from this snapshot alone. A positive TVL z-score means it is large for its sector; a positive growth z-score means it grows faster than its sector; the signal multiplier folds both, plus any catalyst, into the implied value above.' })
    ));

    var steps = farmSteps(row);
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan — steps ordered by expected value, highest first' }),
      h('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      })),
      h('p', { class: 'note' }, h('b', { text: 'Note: ' }), 'this protocol records no token in the snapshot. That is a record, not proof — check its own docs before assuming a launch, and never pay to claim. Expected values assume a 5% community allocation of the implied value split across about 50,000 farmers.')
    ));

    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  /* ------------------------------------------------------------- render -- */

  function render() {
    app.textContent = '';
    var shell = h('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    if (state.tab === 'pre-token') shell.appendChild(podium());
    if (state.tab === 'pre-token') shell.appendChild(conviction());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') {
      shell.appendChild(modelPanel());
      shell.appendChild(caveats());
    }
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
    else if (dialog.open) dialog.close();
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
