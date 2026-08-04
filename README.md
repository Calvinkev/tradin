# TradingView AI Agent

AI-powered chart analysis via [TVControl MCP](https://github.com/FerroxLabs/tvcontrol) — 102 tools driving TradingView Desktop over CDP, with multi-strategy signal engine and multi-provider LLM analysis.

## Architecture

```
TradingAI Agent
  ├── MCPAgent          ← connects to tvcontrol MCP server (stdio)
  │     └── 102 TVControl tools (chart, Pine, snapshot, sweep, replay…)
  ├── TradingAIAgent    ← orchestrates navigation, data collection, AI analysis
  ├── strategies.js     ← 8 strategies + consensus aggregator
  └── logger.js         ← coloured console + file logging
```

## Setup

```bash
# 1. Install
npm install

# 2. Launch TradingView with the CDP debug port
/home/calvin/Desktop/trading/tvcontrol/scripts/launch_tv_debug_linux.sh
# Or manually: /path/to/TradingView --remote-debugging-port=9222

# 3. Configure .env (already set up — update keys if needed)
nano .env

# 4. Run
npm start
```

## .env variables

| Variable | Description |
|----------|-------------|
| `AI_PROVIDER` | `groq` (default) \| `nvidia` \| `openai` |
| `GROQ_API_KEY` | Groq API key |
| `NVIDIA_API_KEY` | NVIDIA NIM API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `DEFAULT_SYMBOL` | Default chart symbol (XAUUSD) |
| `DEFAULT_TIMEFRAME` | Default timeframe (1h) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

## Commands

| Command | Description |
|---------|-------------|
| `analyze XAUUSD 1h` | Full analysis — navigate, collect data, run strategies, AI report |
| `chart` | Screenshot current chart |
| `mcp` | Show MCP + TradingView connection status |
| `tools` | List all 102 available MCP tools |
| `snapshot <name>` | Save current chart state |
| `restore <name>` | Restore a saved chart state |
| `snapshots` | List saved snapshots |
| `watchlist` | Show current watchlist |
| `sweep SPY,QQQ 5m,15m` | Strategy sweep across symbols × timeframes |
| `help` | Show all commands |
| `exit` | Quit |

## Strategies

Eight built-in strategies run on every `analyze` call:

| Strategy | Signal logic |
|----------|-------------|
| RSI Mean Reversion | Oversold < 30 → BUY, Overbought > 70 → SELL |
| MA Crossover | Golden cross / Death cross (SMA50 × SMA200) |
| MACD Momentum | MACD × Signal line crossover |
| Bollinger Band | Price at bands; squeeze detection |
| VWAP Bias | Price vs VWAP intraday directional bias |
| EMA Trend Pullback | Pullback to EMA21 in EMA9 trend direction |
| Stochastic Oscillator | %K/%D crossover in oversold/overbought zones |
| Pine Custom Levels | Proximity to key levels drawn by Pine indicators |

Results are weighted by confidence and aggregated into a single **consensus** signal.

## Output

Each `analyze` run produces:
- Coloured strategy table in terminal
- AI analysis (trend, key levels, indicator confluence, trade setup, risk)
- Markdown report in `reports/`
- Screenshot in `reports/` (and `screenshots/`)
- Log entry in `logs/trading.log`
