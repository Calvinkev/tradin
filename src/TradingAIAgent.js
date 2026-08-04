import { OpenAI } from 'openai';
import Groq from 'groq-sdk';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { Logger } from './utils/logger.js';
import { runAllStrategies } from './strategies.js';

dotenv.config();

export class TradingAIAgent {
  constructor(mcpAgent) {
    this.mcp = mcpAgent;                  // injected MCPAgent instance
    this.provider = (process.env.AI_PROVIDER || 'nvidia').toLowerCase();
    this.reportsDir = path.join(process.cwd(), 'reports');
    this._initAIClient();
  }

  _initAIClient() {
    if (this.provider === 'groq') {
      this.client = new Groq({ apiKey: process.env.GROQ_API_KEY });
      this.model  = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    } else if (this.provider === 'nvidia') {
      this.client = new OpenAI({
        apiKey:  process.env.NVIDIA_API_KEY,
        baseURL: 'https://integrate.api.nvidia.com/v1'
      });
      this.model = process.env.NVIDIA_MODEL || 'nvidia/llama-3.1-nemotron-ultra-253b-v1';
    } else {
      // default: openai
      this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      this.model  = process.env.OPENAI_MODEL || 'gpt-4o';
    }
    Logger.info(`AI provider: ${this.provider} / model: ${this.model}`);
  }

  async initialize() {
    await Logger.info('Initialising TradingAI agent...');
    await fs.mkdir(this.reportsDir, { recursive: true });

    // Verify TradingView is reachable via MCP
    if (this.mcp?.connected) {
      try {
        const health = await this.mcp.healthCheck();
        if (health?.healthy) {
          await Logger.info(`✅ TradingView healthy — ${health.symbol ?? ''} ${health.resolution ?? ''}`);
        } else {
          await Logger.warn('⚠️  TradingView not healthy. Launch it with the debug flag.');
        }
      } catch (e) {
        await Logger.warn(`TradingView health check skipped: ${e.message}`);
      }
    }
    return true;
  }

  // ─── Main entry-point ──────────────────────────────────────────────────────

  async analyzeChart(symbol, timeframe) {
    await Logger.info(`📊 Analysing ${symbol} ${timeframe}…`);

    try {
      // 1. Navigate
      await this.navigateTo(symbol, timeframe);

      // 2. Ensure key indicators are on the chart
      await this.setupIndicators();

      // 3. Collect all chart data via MCP
      const chartData = await this._collectData();

      // 3. Screenshot
      const screenshotPath = await this.takeScreenshot();

      // 4. Build strategy signals
      const strategyData  = this.buildStrategyData(chartData);
      const strategyReport = runAllStrategies(strategyData);

      // 5. AI analysis
      const analysis = await this.getAIAnalysis(screenshotPath, chartData, strategyReport);

      // 6. Save report
      const reportPath = await this.saveReport(symbol, timeframe, chartData, strategyReport, analysis, screenshotPath);

      // 7. Print
      console.log('\n📈 ANALYSIS RESULTS:');
      console.log('━'.repeat(70));
      this._printStrategyTable(strategyReport);
      console.log('\n🤖 AI ANALYSIS:');
      console.log(analysis);
      console.log('━'.repeat(70));
      console.log(`📄 Report: ${reportPath}\n`);

      return { analysis, strategyReport, reportPath };
    } catch (error) {
      await Logger.error(`Analysis failed: ${error.message}`);
      throw error;
    }
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  async navigateTo(symbol, timeframe) {
    if (!this.mcp?.connected) {
      await Logger.warn('MCP not connected — cannot navigate');
      return;
    }

    await Logger.info(`Setting symbol → ${symbol}`);
    await this.mcp.setSymbol(symbol);
    await this._sleep(5000); // Increased wait time for symbol change

    // Verify symbol actually changed using getCurrentSymbol
    try {
      const currentSymbol = await this.mcp.getCurrentSymbol();
      await Logger.info(`Current symbol after navigation: ${currentSymbol}`);
      
      if (currentSymbol && currentSymbol !== symbol && !currentSymbol.includes(symbol)) {
        await Logger.warn(`Symbol verification failed: expected ${symbol}, got ${currentSymbol}`);
        await Logger.info('Retrying symbol change...');
        await this.mcp.setSymbol(symbol);
        await this._sleep(5000);
        
        // Second verification
        const retrySymbol = await this.mcp.getCurrentSymbol();
        await Logger.info(`Current symbol after retry: ${retrySymbol}`);
        
        if (retrySymbol && retrySymbol !== symbol && !retrySymbol.includes(symbol)) {
          await Logger.error(`Failed to switch to ${symbol}. Current: ${retrySymbol}`);
        }
      }
    } catch (e) {
      await Logger.warn(`Could not verify symbol change: ${e.message}`);
    }

    await Logger.info(`Setting timeframe → ${timeframe}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.mcp.setTimeframe(timeframe);
        await Logger.info('Timeframe set');
        break;
      } catch (e) {
        if (attempt < 3) {
          await Logger.warn(`Timeframe retry ${attempt}/3…`);
          await this._sleep(2000);
        } else {
          await Logger.warn('Could not set timeframe — analysing current chart');
        }
      }
    }
    await this._sleep(2000); // Increased wait after timeframe
  }

  // ─── Screenshot ────────────────────────────────────────────────────────────

  async takeScreenshot() {
    const screenshotDir = path.join(process.cwd(), 'screenshots');
    await fs.mkdir(screenshotDir, { recursive: true });
    const filepath = path.join(screenshotDir, `chart_${Date.now()}.png`);

    if (!this.mcp?.connected) {
      await Logger.warn('MCP not connected — screenshot skipped');
      return filepath;
    }

    try {
      const result = await this.mcp.captureScreenshot('chart');
      if (result?.file_path) {
        await fs.copyFile(result.file_path, filepath);
        await Logger.info(`📸 Screenshot: ${filepath}`);
      }
    } catch (e) {
      await Logger.warn(`Screenshot failed: ${e.message}`);
    }
    return filepath;
  }

  // ─── Data collection ───────────────────────────────────────────────────────

  async _collectData() {
    if (!this.mcp?.connected) {
      await Logger.warn('MCP not connected — returning empty chart data');
      return { symbol: 'Unknown', resolution: 'Unknown', studies: [], studyValues: [], ohlcv: {}, quote: {}, pineLines: [], pineLabels: [], pineTables: [] };
    }
    return this.mcp.collectChartData();
  }

  /**
   * Flatten MCP chart data into the flat shape expected by TradingStrategies.check().
   */
  buildStrategyData(chartData) {
    const quote = chartData.quote ?? {};
    const price = quote.close ?? quote.last ?? quote.price ?? 0;

    // Parse values that may come as comma-formatted strings e.g. "4,063.201"
    const parseNum = v => {
      if (v == null) return undefined;
      const n = parseFloat(String(v).replace(/,/g, ''));
      return isFinite(n) ? n : undefined;
    };

    // Find indicator value by name fragment + key
    const findVal = (nameFragment, key) => {
      const studies = chartData.studyValues ?? [];
      for (const s of studies) {
        if (s.name?.toLowerCase().includes(nameFragment.toLowerCase())) {
          const raw = s.values?.[key];
          if (raw != null) return parseNum(raw);
          // also try case-insensitive key match
          for (const [k, val] of Object.entries(s.values ?? {})) {
            if (k.toLowerCase() === key.toLowerCase()) return parseNum(val);
          }
        }
      }
      return undefined;
    };

    // pineLines is now a flat array of line objects
    const pineLines = Array.isArray(chartData.pineLines) ? chartData.pineLines : [];

    return {
      price,
      open:          parseNum(quote.open),
      high:          parseNum(quote.high),
      low:           parseNum(quote.low),
      close:         parseNum(quote.close) ?? price,
      volume:        parseNum(quote.volume),
      rsi:           findVal('RSI', 'RSI') ?? findVal('Relative Strength', 'RSI') ?? findVal('rsi', 'Value'),
      macd:          findVal('MACD', 'MACD'),
      macdSignal:    findVal('MACD', 'Signal'),
      macdHistogram: findVal('MACD', 'Histogram'),
      sma20:         findVal('Moving Average Simple', 'MA'),
      sma50:         findVal('SMA 50', 'MA') ?? findVal('50', 'MA'),
      sma200:        findVal('SMA 200', 'MA') ?? findVal('200', 'MA'),
      ema9:          findVal('EMA 9', 'EMA') ?? findVal('Exponential', '9'),
      ema21:         findVal('EMA 21', 'EMA') ?? findVal('Exponential', '21'),
      bbUpper:       findVal('Bollinger', 'Upper'),
      bbMiddle:      findVal('Bollinger', 'Basis'),
      bbLower:       findVal('Bollinger', 'Lower'),
      bbWidth:       findVal('Bollinger', 'Width'),
      atr:           findVal('ATR', 'ATR') ?? findVal('Average True', 'ATR'),
      vwap:          findVal('VWAP', 'VWAP'),
      stochK:        findVal('Stoch', '%K'),
      stochD:        findVal('Stoch', '%D'),
      pineLines,
      pineLabels:    Array.isArray(chartData.pineLabels) ? chartData.pineLabels : []
    };
  }

  // ─── AI analysis ──────────────────────────────────────────────────────────

  async getAIAnalysis(screenshotPath, chartData, strategyReport) {
    try {
      const systemPrompt = `You are a professional technical analyst. Analyse the TradingView chart provided.
Focus on: price action, trend, support/resistance, indicator confluence, volume profile, and risk/reward.
Be concise and actionable. Output in this order:
1. TREND SUMMARY  
2. KEY LEVELS  
3. INDICATOR CONFLUENCE  
4. TRADE SETUP (entry, stop, target)  
5. RISK ASSESSMENT`;

      const stratSummary = strategyReport.results
        .filter(r => r.signal !== 'NEUTRAL' && r.signal !== 'ERROR')
        .map(r => `${r.name}: ${r.signal} — ${r.reason} (conf ${(r.confidence * 100).toFixed(0)}%)`)
        .join('\n') || 'All strategies neutral';

      const userText = `Symbol: ${chartData.symbol}  Timeframe: ${chartData.resolution}
Quote: ${JSON.stringify(chartData.quote)}
OHLCV summary: ${JSON.stringify(chartData.ohlcv)}
Indicator values: ${JSON.stringify(chartData.studyValues?.slice(0, 10))}
Pine levels: ${JSON.stringify(chartData.pineLines?.slice(0, 20))}
Pine labels: ${JSON.stringify(chartData.pineLabels?.slice(0, 10))}

--- Strategy signals ---
Consensus: ${strategyReport.consensus}  (Bull ${strategyReport.bullPct}% / Bear ${strategyReport.bearPct}%)
${stratSummary}`;

      if (this.provider === 'groq') {
        // Groq text-only
        const res = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userText }
          ],
          max_tokens:  2048,
          temperature: 0.5
        });
        return res.choices[0].message.content;

      } else {
        // OpenAI / NVIDIA — vision
        let imageContent = null;
        try {
          const buf = await fs.readFile(screenshotPath);
          const b64 = buf.toString('base64');
          imageContent = { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } };
        } catch { /* screenshot may not exist */ }

        const userContent = imageContent
          ? [{ type: 'text', text: userText }, imageContent]
          : userText;

        const res = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userContent }
          ],
          max_tokens:  4096,
          temperature: 0.5
        });
        return res.choices[0].message.content;
      }
    } catch (error) {
      await Logger.error(`AI analysis error: ${error.message}`);
      return `⚠️  AI analysis unavailable (${this.provider}): ${error.message}`;
    }
  }

  // ─── Report saving ─────────────────────────────────────────────────────────

  async saveReport(symbol, timeframe, chartData, strategyReport, analysis, screenshotPath) {
    const timestamp = new Date().toISOString();
    const base      = `${symbol}_${timeframe}_${Date.now()}`;
    const reportPath = path.join(this.reportsDir, `${base}.md`);

    const stratLines = strategyReport.results.map(r =>
      `| ${r.name} | ${r.signal} | ${(r.confidence * 100).toFixed(0)}% | ${r.reason} |`
    ).join('\n');

    const indicatorSection = (chartData.studyValues ?? []).map(s => {
      const vals = Object.entries(s.values ?? {})
        .map(([k, v]) => `  - ${k}: ${v}`)
        .join('\n');
      return `**${s.name}:**\n${vals}`;
    }).join('\n\n');

    const reportContent = `# Trading Analysis Report

| Field | Value |
|-------|-------|
| Symbol | ${chartData.symbol} |
| Timeframe | ${chartData.resolution} |
| Generated | ${timestamp} |
| AI Provider | ${this.provider.toUpperCase()} |
| Model | ${this.model} |

## Market Quote
\`\`\`json
${JSON.stringify(chartData.quote, null, 2)}
\`\`\`

## OHLCV Summary
\`\`\`json
${JSON.stringify(chartData.ohlcv, null, 2)}
\`\`\`

## Active Studies
${(chartData.studies ?? []).map(s => `- ${s.name ?? s}`).join('\n') || '_none_'}

## Indicator Values
${indicatorSection || '_no values_'}

## Strategy Signals

**Consensus: ${strategyReport.consensus}** | Bull ${strategyReport.bullPct}% / Bear ${strategyReport.bearPct}%

| Strategy | Signal | Confidence | Reason |
|----------|--------|-----------|--------|
${stratLines}

## AI Analysis
${analysis}

---
*Generated by Trading AI Agent with TVControl MCP*
`;

    await fs.writeFile(reportPath, reportContent);

    // Copy screenshot next to report
    try {
      await fs.copyFile(screenshotPath, path.join(this.reportsDir, `${base}.png`));
    } catch { /* skip if screenshot missing */ }

    return reportPath;
  }

  // ─── Chart actions based on analysis ─────────────────────────────────────

  /**
   * After analysis, act on the chart:
   * - Draw support/resistance levels from Pine lines + strategy signals
   * - Place alerts at key levels
   * - Annotate chart with signal text
   * - Enter replay trade if in replay mode
   */
  async actOnChart(symbol, chartData, strategyReport) {
    if (!this.mcp?.connected) {
      await Logger.warn('MCP not connected — skipping chart actions');
      return;
    }

    await Logger.info('🎯 Acting on chart based on analysis…');
    const actions = [];

    const quote   = chartData.quote ?? {};
    const price   = quote.close ?? quote.price ?? 0;
    const ts      = Math.floor(Date.now() / 1000);

    // 1. Clear previous agent drawings
    try {
      await this.mcp.clearAllDrawings();
      await Logger.info('🗑  Cleared previous drawings');
    } catch (e) {
      await Logger.warn(`Clear drawings: ${e.message}`);
    }

    // 2. Draw Pine custom levels as horizontal lines
    const pineLines = chartData.pineLines ?? [];
    let levelCount = 0;
    for (const line of pineLines.slice(0, 10)) {
      const lvlPrice = line.price ?? line.value;
      if (!lvlPrice) continue;
      try {
        await this.mcp.drawHorizontalLine(lvlPrice, { linecolor: '#2196F3', linewidth: 1 });
        levelCount++;
      } catch { /* skip bad levels */ }
    }
    if (levelCount) {
      await Logger.info(`📐 Drew ${levelCount} Pine key levels`);
      actions.push(`Drew ${levelCount} key levels`);
    }

    // 3. Draw support/resistance from RSI/strategy context
    const stratData = this.buildStrategyData(chartData);
    if (stratData.bbUpper && stratData.bbLower) {
      try {
        await this.mcp.drawHorizontalLine(stratData.bbUpper, { linecolor: '#F44336', linewidth: 2 });
        await this.mcp.drawHorizontalLine(stratData.bbLower, { linecolor: '#4CAF50', linewidth: 2 });
        actions.push('Drew BB upper/lower bands');
        await Logger.info('📊 Drew Bollinger Band levels');
      } catch { /* skip */ }
    }

    if (stratData.vwap) {
      try {
        await this.mcp.drawHorizontalLine(stratData.vwap, { linecolor: '#FF9800', linewidth: 2 });
        actions.push('Drew VWAP level');
        await Logger.info('📊 Drew VWAP');
      } catch { /* skip */ }
    }

    // 4. Annotate with consensus signal text
    if (price) {
      const signal    = strategyReport.consensus;
      const labelText = `${signal} | Bull ${strategyReport.bullPct}% Bear ${strategyReport.bearPct}%`;
      try {
        await this.mcp.drawText(price * 1.001, ts, labelText);
        actions.push(`Annotated: ${labelText}`);
        await Logger.info(`📝 Annotated chart: ${labelText}`);
      } catch { /* skip */ }
    }

    // 5. Set alerts at key levels
    if (stratData.bbUpper) {
      try {
        await this.mcp.createAlert(stratData.bbUpper, 'crossing', `${symbol} BB Upper cross`);
        actions.push(`Alert @ BB Upper ${stratData.bbUpper.toFixed(2)}`);
      } catch { /* skip */ }
    }
    if (stratData.bbLower) {
      try {
        await this.mcp.createAlert(stratData.bbLower, 'crossing', `${symbol} BB Lower cross`);
        actions.push(`Alert @ BB Lower ${stratData.bbLower.toFixed(2)}`);
      } catch { /* skip */ }
    }

    // 6. If in replay mode — execute trade based on consensus
    let replayAction = null;
    try {
      const replayStatus = await this.mcp.replayStatus();
      if (replayStatus?.active || replayStatus?.in_replay) {
        const consensus = strategyReport.consensus;
        if (consensus === 'STRONG_BUY' || consensus === 'BUY') {
          await this.mcp.replayTrade('buy');
          replayAction = 'BUY executed in replay';
          await Logger.info('🟢 Replay BUY placed');
        } else if (consensus === 'STRONG_SELL' || consensus === 'SELL') {
          await this.mcp.replayTrade('sell');
          replayAction = 'SELL executed in replay';
          await Logger.info('🔴 Replay SELL placed');
        } else {
          replayAction = 'No trade — consensus NEUTRAL';
          await Logger.info('⏸  Replay: no trade (NEUTRAL)');
        }
        if (replayAction) actions.push(replayAction);
      }
    } catch { /* not in replay mode — fine */ }

    return actions;
  }

  /**
   * Add a standard indicator set to the chart for analysis.
   * Idempotent — won't crash if already present.
   */
  async setupIndicators() {
    if (!this.mcp?.connected) return;

    // Exact titles as returned by tvcontrol indicator search
    const toAdd = [
      'Relative Strength Index',
      'Moving Average Convergence Divergence',
      'Bollinger Bands',
      'Volume',
      'Volume Weighted Average Price',
      'Stochastic'
    ];

    // Get current studies so we don't add duplicates
    let existing = [];
    try {
      const state = await this.mcp.getChartState();
      existing = (state?.studies ?? []).map(s => s.name?.toLowerCase());
    } catch { /* ignore */ }

    await Logger.info('📈 Setting up indicators…');
    for (const name of toAdd) {
      if (existing.some(e => e.includes(name.toLowerCase().slice(0, 8)))) {
        await Logger.info(`  ✓ ${name} already present`);
        continue;
      }
      try {
        await this.mcp.addIndicator(name);
        await Logger.info(`  + ${name}`);
        await this._sleep(1500);  // let each indicator load before adding next
      } catch (e) {
        await Logger.warn(`  ⚠ Could not add ${name}: ${e.message}`);
      }
    }
    // Final wait for all indicator values to populate
    await this._sleep(3000);
    await Logger.info('✅ Indicators ready');
  }

  /**
   * Run a strategy sweep across multiple symbols and timeframes,
   * then return ranked results.
   */
  async runSweep(symbols, timeframes) {
    if (!this.mcp?.connected) throw new Error('MCP not connected');
    await Logger.info(`🔄 Sweeping ${symbols.join(',')} × ${timeframes.join(',')}…`);
    const result = await this.mcp.strategySweep(symbols, timeframes, {});
    return result;
  }

  /**
   * Start replay at a date and simulate trading bar by bar using strategy signals.
   * @param {string} date  ISO date string e.g. '2025-03-10'
   * @param {number} bars  Number of bars to step through
   */
  async runReplaySession(date, bars = 20) {
    if (!this.mcp?.connected) throw new Error('MCP not connected');
    await Logger.info(`⏪ Starting replay from ${date} for ${bars} bars…`);

    await this.mcp.replayStart(date);
    await this._sleep(2000);

    const results = [];
    for (let i = 0; i < bars; i++) {
      await this.mcp.replayStep();
      await this._sleep(400);

      const chartData    = await this._collectData();
      const stratData    = this.buildStrategyData(chartData);
      const { consensus, bullPct, bearPct } = runAllStrategies(stratData);

      let trade = 'HOLD';
      if (consensus === 'STRONG_BUY' || consensus === 'BUY') {
        await this.mcp.replayTrade('buy');
        trade = 'BUY';
      } else if (consensus === 'STRONG_SELL' || consensus === 'SELL') {
        await this.mcp.replayTrade('sell');
        trade = 'SELL';
      }

      const status = await this.mcp.replayStatus();
      const bar = {
        bar:       i + 1,
        date:      status?.date ?? '',
        price:     stratData.price,
        consensus,
        bullPct,
        bearPct,
        trade,
        pnl:       status?.pnl ?? status?.open_profit ?? null
      };
      results.push(bar);
      await Logger.info(`  Bar ${i+1}: ${bar.date} | ${trade} @ ${bar.price} | P&L: ${bar.pnl ?? 'n/a'}`);
    }

    await this.mcp.replayStop();
    await Logger.info('⏩ Replay complete');
    return results;
  }

  _printStrategyTable(strategyReport) {
    const COLOURS = {
      STRONG_BUY:  '\x1b[32m', BUY:   '\x1b[32m',
      STRONG_SELL: '\x1b[31m', SELL:  '\x1b[31m',
      WATCH:       '\x1b[33m', NEUTRAL: '\x1b[37m',
      ERROR:       '\x1b[35m', reset: '\x1b[0m'
    };
    console.log(`\n📊 Strategy Consensus: ${strategyReport.consensus}  (Bull ${strategyReport.bullPct}% / Bear ${strategyReport.bearPct}%)`);
    console.log('─'.repeat(70));
    for (const r of strategyReport.results) {
      const c = COLOURS[r.signal] ?? '';
      console.log(`  ${c}${r.signal.padEnd(12)}${COLOURS.reset} ${r.name.padEnd(28)} ${r.reason}`);
    }
    console.log('─'.repeat(70));
  }

  // ─── Misc ──────────────────────────────────────────────────────────────────

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async close() {
    await Logger.info('TradingAI agent closed');
  }
}
