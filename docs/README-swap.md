The swap-* contracts are an example port (not for production) from Ethereum to
Groundhog of UniswapV2, adding a request-batching layer:

- `swap-if`: Interface-only crate.
- `swap-pair`: Fundamental operations (cf. [UniswapV2Pair]).
- `swap-request`: High-level swap-operation request types and the handlers that
  execute them.  (The handlers perform price-optimizing calculations against the
  reserves when the request is serviced, not when it is submitted.)
- `swap-driver`: An abstract request-processing driver that batches requests and
  forwards each to its handler, all in the same block.
- `swap-factory`: Creates new pairs and keeps a registry of them.
- `swap-router`: High-level facilities similar to those in [UniswapV2Router02];
  it builds `swap_request` values and enqueues them with the driver.

[UniswapV2Pair]: https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol
[UniswapV2Router02]: https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol
