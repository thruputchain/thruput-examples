/** Default demo assets. Custom deployments can provide their own token list. */
export const ASSETS = [
  { symbol: "tUSDC", name: "Test USDC", decimals: 6, amount: "1000" },
  { symbol: "tEURC", name: "Test EURC", decimals: 6, amount: "1000" },
  { symbol: "tBTC", name: "Test BTC", decimals: 8, amount: "0.01" },
  { symbol: "tETH", name: "Test ETH", decimals: 8, amount: "0.1" },
  { symbol: "tXLM", name: "Test XLM", decimals: 7, amount: "1000" },
  { symbol: "tUSDT", name: "Test USDT", decimals: 6, amount: "1000" },
  { symbol: "tXAUM", name: "Test XAUM", decimals: 8, amount: "0.1" },
] as const;
