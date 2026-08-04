import { TradingAIAgent } from './TradingAIAgent.js';
import { MCPAgent }       from './MCPAgent.js';
import { Logger }         from './utils/logger.js';
import { runAllStrategies } from './strategies.js';
import readline           from 'readline';
import dotenv             from 'dotenv';

dotenv.config();

// ─── Help text ────────────────────────────────────────────────────────────────

const HELP = `
Commands:
  analyze  <SYMBOL> <TF>         Full analysis + act on chart (e.g. analyze XAUUSD 1h)
  act      <SYMBOL> <TF>         Analyse then draw levels, alerts & replay trade
  replay   <DATE> [BARS]         Replay session with auto-trading (e.g. replay 2025-03-10 30)
  setup                          Add RSI, MACD, BB, Volume indicators to chart
  chart                          Take a screenshot
  draw     <TYPE> <PRICE>        Draw on chart (hline|text) at price
  alert    <PRICE> [above|below] Set a price alert
  alerts                         List active alerts
  drawings                       List current drawings
  clear                          Clear all drawings
  sweep    <S1,S2> <TF1,TF2>     Strategy sweep (e.g. sweep XAUUSD,EURUSD 1h,4h)
  mcp                            MCP + TradingView status
  tools                          List all 102 TVControl tools
  snapshot <name>                Save chart state
  restore  <name>                Restore chart state
  snapshots                      List saved states
  watchlist                      Show watchlist
  help                           Show this message
  exit                           Quit
`;

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🤖 TradingView AI Agent + TVControl MCP');
  console.log('━'.repeat(45));
  console.log(HELP);

  // 1. Start MCP (TVControl) — agents share the same MCP client
  const mcp = new MCPAgent();
  await mcp.initialize();

  // 2. Start the AI agent, injecting the MCP client
  const agent = new TradingAIAgent(mcp);
  await agent.initialize();

  // 3. CLI or REPL
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const input = args.join(' ');
    try {
      await dispatch(input, agent, mcp);
    } catch (err) {
      await Logger.error(`Command error: ${err.message}`);
    }
    await agent.close();
    await mcp.close();
    process.exit(0);
    return;
  }

  // 4. REPL
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: '> '
  });

  rl.prompt();

  rl.on('line', async (raw) => {
    const input = raw.trim();
    if (!input) { rl.prompt(); return; }

    try {
      await dispatch(input, agent, mcp);
    } catch (err) {
      await Logger.error(`Command error: ${err.message}`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    await agent.close();
    await mcp.close();
    console.log('\n👋 Goodbye\n');
    process.exit(0);
  });
}

// ─── Command dispatcher ────────────────────────────────────────────────────────

async function dispatch(input, agent, mcp) {
  const [cmd, ...rest] = input.split(/\s+/);

  switch (cmd.toLowerCase()) {

    case 'exit':
    case 'quit':
      process.stdin.emit('end');
      break;

    case 'help':
      console.log(HELP);
      break;

    case 'chart':
    case 'screenshot':
      await agent.takeScreenshot();
      break;

    case 'mcp':
    case 'status':
      await mcp.status();
      break;

    case 'tools':
      if (!mcp.connected) { console.log('MCP not connected'); break; }
      console.log('\n🔧 Available MCP tools:');
      mcp.listTools().forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)}. ${t}`));
      console.log('');
      break;

    case 'analyze':
    case 'analyse': {
      const symbol    = rest[0] || process.env.DEFAULT_SYMBOL || 'XAUUSD';
      const timeframe = rest[1] || process.env.DEFAULT_TIMEFRAME || '1h';
      await agent.analyzeChart(symbol, timeframe);
      break;
    }

    // Full analyze → act pipeline
    case 'act': {
      const symbol    = rest[0] || process.env.DEFAULT_SYMBOL || 'XAUUSD';
      const timeframe = rest[1] || process.env.DEFAULT_TIMEFRAME || '1h';
      await Logger.info(`🎯 Analyze + Act on ${symbol} ${timeframe}`);
      await agent.navigateTo(symbol, timeframe);
      await agent.setupIndicators();
      await agent._sleep(2000);  // let indicators load
      const chartData      = await agent._collectData();
      const screenshotPath = await agent.takeScreenshot();
      const strategyData   = agent.buildStrategyData(chartData);
      const strategyReport = runAllStrategies(strategyData);
      agent._printStrategyTable(strategyReport);
      const actions = await agent.actOnChart(symbol, chartData, strategyReport);
      console.log('\n✅ Chart actions taken:');
      (actions ?? []).forEach(a => console.log(`  • ${a}`));
      const analysis = await agent.getAIAnalysis(screenshotPath, chartData, strategyReport);
      const report   = await agent.saveReport(symbol, timeframe, chartData, strategyReport, analysis, screenshotPath);
      console.log('\n🤖 AI ANALYSIS:\n' + analysis);
      console.log(`\n📄 Report: ${report}\n`);
      break;
    }

    // Replay session with auto-trading
    case 'replay': {
      const date = rest[0];
      const bars = parseInt(rest[1] ?? '20', 10);
      if (!date) { console.log('Usage: replay <DATE> [BARS]  e.g. replay 2025-03-10 30'); break; }
      const results = await agent.runReplaySession(date, bars);
      console.log('\n📊 REPLAY RESULTS:');
      console.log('─'.repeat(70));
      console.log('Bar  Date                   Price       Trade  P&L');
      results.forEach(r =>
        console.log(`${String(r.bar).padStart(3)}  ${r.date.padEnd(22)} ${String(r.price).padEnd(12)}${r.trade.padEnd(7)}${r.pnl ?? 'n/a'}`)
      );
      console.log('─'.repeat(70) + '\n');
      break;
    }

    // Setup standard indicators
    case 'setup':
      await agent.setupIndicators();
      console.log('✅ Indicators added to chart\n');
      break;

    // Draw on chart
    case 'draw': {
      const type  = rest[0] || 'hline';
      const price = parseFloat(rest[1]);
      const text  = rest.slice(2).join(' ') || '';
      if (!price) { console.log('Usage: draw <hline|text> <price> [text]'); break; }
      if (type === 'hline') {
        const r = await mcp.drawHorizontalLine(price);
        console.log(`📐 Horizontal line @ ${price}: ${r?.success ? '✅' : '❌'}`);
      } else if (type === 'text') {
        const ts = Math.floor(Date.now() / 1000);
        const r  = await mcp.drawText(price, ts, text || `Level ${price}`);
        console.log(`📝 Text @ ${price}: ${r?.success ? '✅' : '❌'}`);
      } else {
        console.log('Types: hline, text');
      }
      break;
    }

    // Set price alert
    case 'alert': {
      const price     = parseFloat(rest[0]);
      const condition = rest[1] === 'above' ? 'greater_than' : rest[1] === 'below' ? 'less_than' : 'crossing';
      if (!price) { console.log('Usage: alert <price> [above|below]'); break; }
      const r = await mcp.createAlert(price, condition, `Price ${condition} ${price}`);
      console.log(`🔔 Alert @ ${price} (${condition}): ${r?.success ? '✅' : '❌'}`);
      break;
    }

    // List alerts
    case 'alerts': {
      const r = await mcp.listAlerts();
      const list = r?.alerts ?? r?.items ?? [];
      if (!list.length) { console.log('No active alerts'); break; }
      console.log(`\n🔔 Alerts (${list.length}):`);
      list.forEach(a => console.log(`  [${a.id}] ${a.price ?? ''} ${a.condition ?? ''} ${a.message ?? ''}`));
      console.log('');
      break;
    }

    // List drawings
    case 'drawings': {
      const r = await mcp.listDrawings();
      const list = r?.drawings ?? r?.shapes ?? [];
      if (!list.length) { console.log('No drawings on chart'); break; }
      console.log(`\n✏️  Drawings (${list.length}):`);
      list.forEach(d => console.log(`  [${d.id}] ${d.type ?? ''} @ ${d.price ?? ''}`));
      console.log('');
      break;
    }

    // Clear all drawings
    case 'clear': {
      const r = await mcp.clearAllDrawings();
      console.log(`🗑  Drawings cleared: ${r?.success ? '✅' : '❌'}`);
      break;
    }

    case 'snapshot': {
      const name = rest.join('_') || `snapshot_${Date.now()}`;
      const r = await mcp.snapshotState(name);
      console.log(`📸 Snapshot "${name}": ${r?.success ? '✅' : '❌'}`);
      break;
    }

    case 'restore': {
      const name = rest.join('_');
      if (!name) { console.log('Usage: restore <name>'); break; }
      const r = await mcp.restoreState(name);
      console.log(`♻️  Restore "${name}": ${r?.success ? '✅' : '❌'}`);
      break;
    }

    case 'snapshots': {
      const r    = await mcp.listSnapshots();
      const list = r?.snapshots ?? r?.states ?? [];
      if (!list.length) { console.log('No snapshots'); break; }
      console.log('\n📂 Snapshots:');
      list.forEach(s => console.log(`  - ${s.name ?? s} (${s.timestamp ?? ''})`));
      console.log('');
      break;
    }

    case 'watchlist': {
      const r    = await mcp.getWatchlist();
      const syms = r?.symbols ?? r?.watchlist ?? [];
      console.log(`\n📋 Watchlist (${syms.length}):`);
      syms.forEach(s => console.log(`  ${s}`));
      console.log('');
      break;
    }

    case 'sweep': {
      const symbols    = (rest[0] || 'XAUUSD').split(',');
      const timeframes = (rest[1] || '1h').split(',');
      console.log(`\n🔄 Sweeping ${symbols.join(', ')} × ${timeframes.join(', ')}…`);
      const r = await mcp.strategySweep(symbols, timeframes, {});
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    default:
      console.log(`Unknown command: "${cmd}". Type "help" for available commands.`);
  }
}

main().catch(async (err) => {
  await Logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
