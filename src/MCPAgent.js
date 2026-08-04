/**
 * MCPAgent — drives TVControl via its CLI (JSON over stdout).
 *
 * Every MCP tool is also a `tv <command>` CLI command that returns JSON.
 * This approach bypasses the MCP stdio protocol entirely and is the most
 * reliable way to call TVControl from Node.js.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from './utils/logger.js';

const execFileAsync = promisify(execFile);

const TV_CLI  = '/home/calvin/Desktop/trading/tvcontrol/src/cli/index.js';
const NODE    = process.execPath;   // same node binary that's running us
const TIMEOUT = 30_000;             // 30 s per call

export class MCPAgent {
  constructor() {
    this.connected = false;
    this.tools = [];
  }

  // ─── Init / health ──────────────────────────────────────────────────────────

  async initialize() {
    await Logger.info('Connecting to TVControl CLI…');
    try {
      const status = await this.call('status');
      if (status?.healthy || status?.success) {
        this.connected = true;
        // Enumerate available tools via capabilities
        try {
          const caps = await this.call('capabilities');
          this.tools = caps?.tools ?? [];
        } catch { this.tools = []; }
        await Logger.info(`✅ TVControl connected — ${this.tools.length} tools | ${status.chart_symbol ?? ''} ${status.chart_resolution ?? ''}`);
        return true;
      }
      throw new Error(status?.error ?? 'unhealthy');
    } catch (err) {
      await Logger.warn(`TVControl connection failed: ${err.message}`);
      await Logger.info('Attempting to launch TradingView with CDP enabled…');
      try {
        const launchResult = await this.call('launch');
        await Logger.info('TradingView launch initiated, waiting 5 seconds for startup…');
        await new Promise(r => setTimeout(r, 5000));
        
        // Retry connection after launch
        const retryStatus = await this.call('status');
        if (retryStatus?.healthy || retryStatus?.success) {
          this.connected = true;
          try {
            const caps = await this.call('capabilities');
            this.tools = caps?.tools ?? [];
          } catch { this.tools = []; }
          await Logger.info(`✅ TVControl connected after launch — ${this.tools.length} tools | ${retryStatus.chart_symbol ?? ''} ${retryStatus.chart_resolution ?? ''}`);
          return true;
        }
        throw new Error('TradingView launched but still not healthy');
      } catch (launchErr) {
        await Logger.error(`Failed to launch TradingView: ${launchErr.message}`);
        this.connected = false;
        return false;
      }
    }
  }

  // ─── Core CLI caller ────────────────────────────────────────────────────────

  /**
   * Run: node tv_cli <subcommand...> [--key value …]
   * subcommand can be a string (split on spaces) or an array of tokens.
   * Returns parsed JSON result.
   */
  async call(subcommand, args = {}) {
    const subcmdTokens = Array.isArray(subcommand)
      ? subcommand
      : subcommand.trim().split(/\s+/);

    const argv = [TV_CLI, ...subcmdTokens];

    // Append args as --key value pairs
    for (const [key, val] of Object.entries(args)) {
      argv.push(`--${key}`);
      if (val !== true && val !== undefined) {
        argv.push(Array.isArray(val) ? val.join(',') : String(val));
      }
    }

    try {
      const { stdout } = await execFileAsync(NODE, argv, {
        timeout: TIMEOUT,
        env: { ...process.env, TV_MCP_TELEMETRY: '0' }
      });
      return JSON.parse(stdout.trim());
    } catch (err) {
      const raw = err.stdout?.trim() || err.stderr?.trim() || err.message;
      try { return JSON.parse(raw); } catch { throw new Error(raw); }
    }
  }

  // ─── Convenience wrappers ───────────────────────────────────────────────────

  healthCheck()            { return this.call('status'); }
  getChartState()          { return this.call('state'); }
  getQuote()               { return this.call('quote'); }
  getStudyValues()         { return this.call('values'); }
  getOHLCV(count = 100, summary = false) {
    return summary
      ? this.call('ohlcv', { summary: true })
      : this.call('ohlcv', { count });
  }
  getCurrentSymbol()       { 
    const result = this.call('symbol');
    return result?.symbol ?? result ?? 'Unknown';
  }
  getPineLines(filter)     { return filter ? this.call('data lines', { filter }) : this.call('data lines'); }
  getPineLabels(filter)    { return filter ? this.call('data labels', { filter }) : this.call('data labels'); }
  getPineTables(filter)    { return filter ? this.call('data tables', { filter }) : this.call('data tables'); }

  setSymbol(symbol)        { return this.call(['symbol', String(symbol)]); }
  setTimeframe(tf)         { return this.call('timeframe', { timeframe: tf }); }

  async captureScreenshot(region = 'chart') {
    return this.call('screenshot', region !== 'full' ? { region } : {});
  }

  snapshotState(name)      { return this.call('state snapshot', { name }); }
  restoreState(name)       { return this.call('state restore', { name }); }
  listSnapshots()          { return this.call('state list'); }

  getWatchlist()           { return this.call('watchlist get'); }
  addToWatchlist(sym)      { return this.call('watchlist add', { symbol: sym }); }
  removeFromWatchlist(sym) { return this.call('watchlist remove', { symbol: sym }); }

  capabilityMatrix()       { return this.call('capabilities'); }

  strategySweep(symbols, timeframes, inputs) {
    return this.call('sweep', {
      symbols: symbols.join(','),
      timeframes: timeframes.join(','),
      ...inputs
    });
  }

  // ─── Chart drawing ──────────────────────────────────────────────────────────

  drawHorizontalLine(price, overrides = {}) {
    const args = { type: 'horizontal_line', price: String(price), time: String(Math.floor(Date.now() / 1000)) };
    if (Object.keys(overrides).length) args.overrides = JSON.stringify(overrides);
    return this.call('draw shape', args);
  }

  drawTrendLine(price1, time1, price2, time2) {
    return this.call('draw shape', {
      type: 'trend_line',
      price: String(price1), time: String(time1),
      price2: String(price2), time2: String(time2)
    });
  }

  drawRectangle(price1, time1, price2, time2) {
    return this.call('draw shape', {
      type: 'rectangle',
      price: String(price1), time: String(time1),
      price2: String(price2), time2: String(time2)
    });
  }

  drawText(price, time, text) {
    return this.call('draw shape', {
      type: 'text',
      price: String(price),
      time:  String(time ?? Math.floor(Date.now() / 1000)),
      text
    });
  }

  listDrawings()       { return this.call('draw list'); }
  removeDrawing(id)    { return this.call('draw remove', { id }); }
  clearAllDrawings()   { return this.call('draw clear'); }

  // ─── Indicators ────────────────────────────────────────────────────────────

  addIndicator(name) {
    // add-search <query> --match <title> — searches the TV indicator dialog and adds it
    return this.call(['indicator', 'add-search', name], { match: name });
  }

  removeIndicator(entityId)        { return this.call('indicator remove', { id: entityId }); }
  toggleIndicator(entityId)        { return this.call('indicator toggle', { id: entityId }); }
  searchIndicators(query)          { return this.call('indicator search', { query }); }

  // ─── Alerts ────────────────────────────────────────────────────────────────

  createAlert(price, condition = 'crossing', message = '') {
    return this.call('alert create', { price, condition, message });
  }

  listAlerts()         { return this.call('alert list'); }
  deleteAlert(id)      { return this.call('alert delete', { id }); }

  // ─── Replay / paper trading ────────────────────────────────────────────────

  replayStart(date)    { return this.call('replay start', { date }); }
  replayStep(bars = 1) { return this.call('replay step', { bars }); }
  replayStop()         { return this.call('replay stop'); }
  replayStatus()       { return this.call('replay status'); }
  replayAutoplay(speed = 500) { return this.call('replay autoplay', { speed }); }

  replayTrade(action)  { return this.call('replay trade', { action }); }  // buy | sell | close

  // ─── UI / navigation ──────────────────────────────────────────────────────

  uiClick(target)      { return this.call('ui click', { target }); }
  uiKeyboard(keys)     { return this.call('ui keyboard', { keys }); }
  openPanel(panel)     { return this.call('ui panel', { panel }); }        // pine-editor | strategy-tester | watchlist
  setChartType(type)   { return this.call('type', { type }); }
  scrollToDate(date)   { return this.call('scroll', { date }); }
  setVisibleRange(from, to) { return this.call('range', { from, to }); }

  // ─── Pine Script ──────────────────────────────────────────────────────────

  pineGet()            { return this.call('pine get'); }
  pineSet(source)      { return this.call('pine set', { source }); }
  pineCompile()        { return this.call('pine compile'); }
  pineErrors()         { return this.call('pine errors'); }
  pineSave(name)       { return this.call('pine save', { name }); }
  pineNew(type = 'indicator') { return this.call('pine new', { type }); }

  // ─── Data ─────────────────────────────────────────────────────────────────

  getStrategyResults() { return this.call('data strategy'); }
  getTrades()          { return this.call('data trades'); }
  getEquityCurve()     { return this.call('data equity'); }

  // ─── Full data bundle (parallel) ───────────────────────────────────────────

  async collectChartData() {
    const [state, quote, studyValues, ohlcv, pineLines, pineLabels, pineTables] =
      await Promise.allSettled([
        this.getChartState(),
        this.getQuote(),
        this.getStudyValues(),
        this.getOHLCV(100, true),
        this.getPineLines(),
        this.getPineLabels(),
        this.getPineTables()
      ]);

    const v = r => (r.status === 'fulfilled' ? r.value : null);

    // Pine data comes back as { studies: [ { name, lines: [...] } ] }
    // Flatten all lines/labels/tables across studies into a single array
    const flatStudies = key => {
      const res = v(pineLines);  // reuse same ref for lines
      const src = key === 'lines'  ? v(pineLines)
                : key === 'labels' ? v(pineLabels)
                : v(pineTables);
      const studies = src?.studies ?? [];
      return studies.flatMap(s => s[key] ?? s.data ?? []);
    };

    return {
      symbol:      v(state)?.symbol       ?? v(state)?.chart_symbol    ?? 'Unknown',
      resolution:  v(state)?.resolution   ?? v(state)?.chart_resolution ?? 'Unknown',
      chartType:   v(state)?.chartType    ?? v(state)?.chart_type       ?? 'Unknown',
      studies:     v(state)?.studies      ?? [],
      quote:       v(quote)               ?? {},
      studyValues: v(studyValues)?.studies ?? [],
      ohlcv:       v(ohlcv)               ?? {},
      pineLines:   flatStudies('lines'),
      pineLabels:  flatStudies('labels'),
      pineTables:  flatStudies('tables')
    };
  }

  // ─── Status display ─────────────────────────────────────────────────────────

  async status() {
    console.log('\n📊 MCP STATUS');
    console.log('━'.repeat(45));
    console.log(`Connected:  ${this.connected ? '✅' : '❌'}`);
    console.log(`Tools:      ${this.tools.length}`);
    if (this.connected) {
      try {
        const h = await this.healthCheck();
        console.log(`TV healthy: ${h.healthy ? '✅' : '❌'}`);
        if (h.chart_symbol)     console.log(`Symbol:     ${h.chart_symbol}`);
        if (h.chart_resolution) console.log(`Resolution: ${h.chart_resolution}`);
        if (h.target_url)       console.log(`URL:        ${h.target_url}`);
      } catch (e) {
        console.log(`TV check:   ⚠️  ${e.message}`);
      }
    }
    console.log('━'.repeat(45) + '\n');
  }

  listTools() { return this.tools.map(t => t.name ?? t); }
  hasTool(n)  { return this.tools.some(t => (t.name ?? t) === n); }

  async close() {
    this.connected = false;
    await Logger.info('MCPAgent closed');
  }
}
