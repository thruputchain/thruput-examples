The swap-* contracts are an example port (not for production) from Ethereum to
Groundhog of UniswapV2, adding a request-batching layer:

- `swap-if`: Interface-only crate.  It defines every swap contract's trait,
  client, and error type, plus the shared value types (including the
  `SwapRequest` request types), so the contracts can call one another -- and be
  created by the factory -- without depending on each other's implementations.
- `swap-pair`: Fundamental operations (cf. [UniswapV2Pair]).
- `swap-handler`: Executes high-level swap-operation requests.  (It performs the
  price-optimizing calculations against the reserves when a request is serviced,
  not when it is submitted.)
- `swap-driver`: An abstract request-processing driver that batches requests and
  forwards each to its handler, all in the same block.
- `swap-factory`: Creates new pairs and keeps a registry of them.
- `swap-router`: High-level facilities similar to those in [UniswapV2Router02];
  it builds `SwapRequest` values and enqueues them with the driver.

[UniswapV2Pair]: https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol
[UniswapV2Router02]: https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol
