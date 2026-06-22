# Institutional Options Pricing Platform (N-API & Next.js)

An enterprise-grade, high-performance web application that leverages a **C++ Quantitative Engine** using `node-addon-api` directly embedded within a **Node.js WebSocket Backend**, consumed by a highly responsive **Next.js & Tailwind Analytics Frontend**.

## Features

1. **C++ Black-Scholes-Merton Engine via N-API**: Heavy floating point arithmetic (Option pricing, Greeks calculation: Delta, Theta, Gamma, Vega, Rho) natively compiled and executed in C++ via `<cmath>` using the `node-addon-api` interface. This eliminates the v8 Javascript garbage collection performance penalities and executes algorithmic models in microseconds.
2. **WebSocket Real-time Updates**: The Node.js Express server runs a constant real-time index pricing simulator and pushes Option Chain calculation iterations live to the front-end dynamically.
3. **Institutional UI Design**: A deeply optimized Dark Mode Tailwind interface modeled after Bloomberg Terminals and professional trading software. Dense layout, high contrast color coding based on moneyness (ITM vs OTM).
4. **Resiliency via Defensiv Programming**: If the C++ Add-on fails to compile (e.g., due to missing C++ Build Tools or MSVC), the backend intelligently falls back to a hand-written JavaScript BSM math approximation engine.

## Architecture

```text
[ Next.js Frontend ] <--- WebSockets (Live Options Chain) ---> [ Node.js Express Backend ]
                                                                      |
                                                               (node-addon-api N-API)
                                                                      |
                                                          [ C++ Engine (quant_engine.node) ]
```

### Time Complexities

#### `calculateAll(spot, strike, t, r, v, type)`: **O(1)**
The core function for options pricing relies on standard normal distribution CDF and PDF functions. Both custom implementations utilizing `std::erfc` (error function complement) run in **$O(1)$** constant time using native C++ intrinsic instruction sets.

#### `generateOptionsChain()`: **$O(N)$**
Generates data across $N$ strikes. Because iterating array strikes occurs within the V8 Node context but pushes bounded O(1) ops to C++, memory management is highly performant.

## Setup Instructions

Ensure Node.js and C++ Build Tools (like Visual Studio Build Tools, or GCC/MinGW) are installed on your OS.

1. **Start Backend Engine**
   ```bash
   cd backend
   npm install
   npx node-gyp rebuild   # Compiles C++ add-on
   node server.js         # Port 3001
   ```

2. **Start Frontend Dashboard**
   ```bash
   cd frontend
   npm install
   npm run dev            # Port 3000
   ```
## Dual-Broker Architecture

This platform uses a **clear separation of concerns** between two brokers:

| Responsibility | Provider | Why |
|---|---|---|
| **Order Management** (place, modify, cancel, exit) | **Kotak Neo** | All user positions live on Kotak's demat. Cross-broker order fallback is impossible — you cannot exit a Kotak position from Upstox. |
| **Market Data** (live quotes, option chain, P&L tracking) | **Upstox** | Upstox provides fast, reliable REST APIs for real-time call/put prices and option chains, eliminating reliance on manual BSM calculations. |

### Why No Cross-Broker Order Fallback?

Each broker maintains its **own order book and positions ledger**. If you place an order on Kotak, that position exists only on Kotak's servers. Upstox has zero visibility into it. Attempting to "hedge" by selling on Upstox would require massive margin (₹1L+ for option writing) — impractical for retail users.

**If Kotak goes down**, the platform:
1. Returns a clear error: *"Kotak Neo is unavailable"*
2. Continues showing **live prices via Upstox** so users can track P&L
3. Users can exit manually via the Kotak mobile app (the exchange itself never goes down)

### Upstox Market Data Endpoints

- `GET /api/upstox/quote?instrument_key=NSE_FO|54819` — Live market quote
- `GET /api/upstox/option-chain?instrument_key=NSE_INDEX|Nifty 50&expiry_date=2026-06-26` — Full option chain with call & put prices

### Order Management Endpoints (Kotak Neo Only)

- `POST /api/orders/place` — Place a new order
- `POST /api/orders/modify` — Modify an existing order
- `POST /api/orders/cancel` — Cancel an order
- `POST /api/orders/exit-all` — Square off all open positions

## Problem → Solution

| Problem | Solution |
|---|---|
| Inaccurate pricing – handcrafted BSM deviates from live market quotes. | Pull live call & put prices from Upstox API, ensuring exact market prices. |
| Broker downtime – Kotak API may be temporarily unavailable. | Upstox continues providing market data; orders are queued with clear user feedback. |
| Scaling to 1,000+ users – high concurrency stresses the server. | Node.js event loop + connection pooling + rate limiting handle concurrent requests efficiently. |

## Tech-Stack Rationale

- **Node.js** – excels at I/O-bound real-time APIs; a single runtime simplifies deployment and CI/CD.
- **Kotak Neo API** – the execution broker; all trades settle through a single demat account.
- **Upstox API** – fast, reliable market data; option chain and LTP endpoints with a single auth token.
- **C++ N-API Engine** – performs heavy option-pricing maths (Greeks) in microseconds without blocking the event loop.
- **Why not Python/Java?** – Those would require separate services, increasing inter-process communication overhead and complicating scaling. Keeping everything in JavaScript/Node ensures a lightweight, container-friendly architecture.

