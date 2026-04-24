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
