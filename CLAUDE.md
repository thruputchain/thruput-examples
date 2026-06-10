# Groundhog contract examples

These are example contracts for the new Groundhog blockchain.

For background on writing Groundhog contracts, start with:
- [SDK README](`../sdk_rs/README.md`)
- [Programming Model](`../developers-site/docs/programming-model/README.md`)

The swap contracts are a port from Ethereum to Groundhog of UniswapV2:
- `swap`: Fundamental operations
- `swap_driver`: A request-processing driver that performs multiple swap
  operations in a batch, all in the same block.
- `swap_router`: High-level facilities similar to those in [UniswapV2Router02].

[UniswapV2Router02]: https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol
