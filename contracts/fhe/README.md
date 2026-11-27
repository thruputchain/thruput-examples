# FHE: gates on encrypted bits

A contract that computes on data it cannot read. Users encrypt bits under their own secret key,
the contract evaluates logic gates on the ciphertexts, and only the key holder can decrypt the
results. The scheme is FHEW/TFHE-style *gate bootstrapping* (the CGGI, or "GINX", blind
rotation): every gate also refreshes its output's noise, so circuits of any depth work.

> **This is an educational, unaudited implementation.** It has one key holder per keyset (no
> threshold decryption), it is IND-CPA secure only (no protection against chosen ciphertexts or
> malicious evaluation), and it is not constant-time. Use it to learn how FHE fits a blockchain,
> not to protect anything.

Crates, in reading order:

- [`core`](core/src/lib.rs) (`fhe-core`, `no_std`, no allocation): the parameters
  ([`params.rs`](core/src/params.rs)), arithmetic mod the 27-bit ring prime and the negacyclic
  NTT ([`ntt.rs`](core/src/ntt.rs)), LWE ciphertexts and the key-free gates
  ([`lwe.rs`](core/src/lwe.rs)), and the blind rotation one step at a time, plus key switching
  ([`bootstrap.rs`](core/src/bootstrap.rs)). The contract and the client share it, so the scheme
  exists once.
- [`client`](client/src/lib.rs) (`fhe-client`): key generation, encryption, decryption, the
  evaluation key in memory (which makes a native reference evaluator out of the contract's step
  code), and, with the `node` feature, a driver that sends the contract's calls
  ([`node.rs`](client/src/node.rs)) and the `fhe-demo` program
  ([`fhe-demo.rs`](client/src/bin/fhe-demo.rs)).
- [`contract`](contract/src/contract.rs) (`fhe`): keysets, ciphertexts, and gate jobs that span
  transactions.

## How a gate is evaluated

A ciphertext of bit `m` is an LWE sample `(a, b)` with `b = a·s + m·q/4 + e mod q`, where `s` is
the user's ternary secret of dimension 554, `q = 2048`, and `e` is small noise. Adding two
ciphertexts adds their bits' encodings (and their noise), so NOT and the *linear part* of every
gate are free: NAND starts from `x + y`, whose phase `b − a·s` is near 0, q/4 or q/2 for 0, 1 or 2
true inputs. What remains is a non-linear test on that phase -- "is it near q/2?" -- and that is
what bootstrapping does, under encryption:

1. **Test polynomial.** An accumulator, an RLWE ciphertext over `Z_Q[X]/(X^1024 + 1)`, starts as
   a trivial encryption of a polynomial whose coefficient `i` says what the gate should output if
   the phase were `b − i` (`init_accumulator`).
2. **Blind rotation.** For each of the 554 secret coefficients, the accumulator is multiplied by
   `X^(−a_i·s_i)` without revealing `s_i`: the evaluation key holds RGSW encryptions of
   `[s_i = 1]` and `[s_i = −1]`, and `acc += (acc ⊡ BK⁺)(X^−a_i − 1) + (acc ⊡ BK⁻)(X^a_i − 1)`
   (`blind_rotate_step`). After all of them the accumulator is rotated by the phase, so its
   constant coefficient encrypts the gate's output.
3. **Sample extraction and key switching.** The constant coefficient is read out as an LWE
   ciphertext under the ring secret (dimension 1024), rounded to modulus 2^15, switched to the
   user's secret with the key-switching key, and rounded back to `q` (`extract`, `KeySwitch`). The
   output has fresh, bounded noise, whatever the inputs had.

Each step is an external product: the accumulator is cut into signed base-2^7 (or 2^9) digits,
each digit polynomial is transformed by the NTT and multiplied by key polynomials, and two inverse
transforms bring the update back. All of it is exact integer arithmetic (Montgomery
multiplication, NTT modulo the prime `Q = 2^27 − 2^11 + 1`), so every validator computes the same
bits. There are no floats anywhere on chain.

## How it is laid out on Thruput

**A keyset** is one user's public evaluation key: 11,288 bootstrapping-key polynomials (4,096
bytes each, one storage value per polynomial) and 15,360 key-switching samples (three per storage
value, 3,330 bytes). Its owner creates it (`create_keyset`), uploads the pieces in any order
(`upload_bsk`, `upload_ksk`), and seals it (`seal`). Uploads count their pieces with an `NNInt`,
so many can share a block, and re-uploading a piece replaces it without counting it twice. Anyone
can compute with a sealed keyset, so the contract serves any number of users with their own keys.

**A ciphertext** is stored under an id with its keyset (`put_ciphertext`, `constant`, `not`, and
the result of every gate). It packs to 764 bytes (555 values of 11 bits), so it fits a storage
value, an event and a return buffer.

**A job** is one bootstrapped gate. A gate costs about 1.8 × 10^9 gas and a transaction may use
10^9, so `start_gate` stores the combined input and `crank` -- which anyone may call -- runs as
many blind-rotation steps as the transaction's gas allows, checking `gas_remaining()` against a
reserve before each, then key-switches, and saves its progress (the accumulator, or the partial
key switch) between calls. The last crank stores the result and emits `GateEvaluated` with the
output's id and ciphertext.

**Memory.** A contract has 64 KiB of data memory in all, stack included, and the guest's
allocator never frees. The artifact is built with a 16 KiB stack (`--stack-size 16K`, set in
`scripts/build-guest.sh` and `live.sh`): reading a 4 KiB storage value goes through the stack
twice in the SDK, so the reads happen in their own non-inlined functions. That leaves 10.5 KiB
of NTT tables and 38 KiB of heap, of which a crank uses 28 KiB for the accumulator, the two
products and the digit polynomial. Key material is never held: each piece is read into the read
function's stack buffer and lent to the step through a closure (`KeySource`).

## Parameters

OpenFHE's `STD128` parameter set for GINX, as `BinFHEContext::GenerateBinFHEContext` states it
(OpenFHE `src/binfhe/lib/binfhecontext.cpp`), verified against its source:

| | Value |
| --- | --- |
| LWE dimension `n`, modulus `q` | 554, 2048 |
| Ring dimension `N`, modulus `Q` | 1024, 134,215,681 (`LastPrime(27, 2048)`) |
| Gadget base | 2^7 (3 of 4 digits kept) for the first 303 coefficients, 2^9 (2 of 3) for the other 251 |
| Key-switching modulus | 2^15 |
| Key-switching base | **2** (OpenFHE: 2^8) |
| Noise, secrets | discrete Gaussian, σ = 3.19; uniform ternary |
| Gate constants, test polynomial, rounding | as OpenFHE's `BootstrapGateCore` and `EvalBinGate` |

The one change is the key-switching base. OpenFHE stores every multiple `j·256^k` of every
digit, about 391,000 samples (over 400 MB), so that key switching is additions only. Base 2 needs
one sample per bit, 15,360 samples (17 MB). Security is unchanged (it is still LWE under the same
secret, modulus and noise). Noise is slightly higher: measured over hundreds of gates, the output
noise has a standard deviation of 20.6 (mod 2048) at base 2 against 19.3 at base 2^8. With a
decision margin of q/8 = 256 for a pair of inputs, that puts the estimated probability of a
wrong gate at about 2^−59 per gate, against about 2^−67 at base 2^8 (OpenFHE states 2^−68 for
`STD128`).

## Costs

Measured on a local node configured like the hosted network (`live.sh`):

| | |
| --- | --- |
| One gate (AND, OR, NAND, NOR, XOR, XNOR) | 3 transactions: `start_gate` (0.26M gas), `crank` (~996M), `crank` (~790M); 1.78 × 10^9 gas; about 3.5 s locally |
| NOT, constants | one call, no bootstrap |
| One blind-rotation step | about 3.1M gas (24 cold reads of 4 KiB, 8 NTTs of size 1024); 2.4M for the last 251 coefficients |
| Key upload | 2,614 transactions of at most 0.56M gas (6 polynomials or 7 sample groups each); 1.4 × 10^9 gas in all |
| Key size and deposit | 63.3 MB in 16,408 storage values; about 83 native tokens, held by the contract |
| Full adder (5 gates, depth 3) | 15 transactions, about 16 s locally |

**Storage is paid by the contract.** On Thruput a contract funds the deposits for data stored
under its address, and a caller cannot pay for the storage its call creates. So the contract
needs about 83 native tokens of balance for every keyset uploaded to it. Fund it before
uploading. Deposits are refundable, but this example has no way to delete a keyset.

## Run it

Native tests, no node needed: the NTT against schoolbook multiplication, every gate on every
input pair (on fresh and on bootstrapped inputs) through the contract's step code, a full adder,
and the contract's keyset, ciphertext and input checks:

```sh
cargo test -p fhe-core -p fhe-client -p fhe --locked
```

```text
384 bootstrapped outputs: noise sd 20.6, worst 61, margin q/8 = 256 (mod q = 2048)
test result: ok. ...
```

The mock environment's database holds less than a whole evaluation key, so gates on the contract
itself run on a node. The RV32 artifact can be checked in the mock executor:

```sh
thruput build -p fhe --stack-size 16K
cargo test -p fhe --locked --test test_rv32 -- --ignored
```

`live.sh` builds the artifact, starts a node with the hosted network's 4,096-byte storage values
(`thruput node --network-config max_bytestring_len=4096`; the local default is 1,024), uploads
a keyset and evaluates NAND and two full adders through `crank`
([`tests/testkit_gate.rs`](contract/tests/testkit_gate.rs)). It takes about two minutes:

```sh
bash contracts/fhe/live.sh
```

```text
upload: 2614 transactions in 51 s, 1421361140 gas in all, at most 563008 per transaction
NAND(true, true) = false in 3 transactions, 1786555973 gas, 3.6 s: [258651, 995326284, 790971038]
NAND(false, true) = true in 3 transactions, 1786897923 gas, 3.6 s: [258684, 996207794, 790431445]
full adder 1 + 1 + 1 = carry 1, sum 1: 15 transactions, 17.3 s
full adder 1 + 0 + 1 = carry 1, sum 0: 15 transactions, 16.8 s
one crank: 319 steps for 996207299 gas (3122906 per step)
```

### The demo on any network

`fhe-demo` runs the same calls against a deployed contract. It signs with a key you export from
the CLI and never prints it:

```sh
thruput build -p fhe --stack-size 16K
thruput deploy --artifact target/thruput/fhe.rv32a --fund 100 -y   # the contract pays deposits
thruput keys export NAME -y > signer.key                            # a funded key; keep it out of git
export THRUPUT_RPC_URL=... THRUPUT_RUNTIME_MANIFEST=... FHE_CONTRACT=<address> FHE_SIGNER=signer.key
cargo run -p fhe-client --features node --bin fhe-demo -- keyset         # prints the keyset id
cargo run -p fhe-client --features node --bin fhe-demo -- nand 0 1 1
cargo run -p fhe-client --features node --bin fhe-demo -- adder 0 1 1 0
```

```text
NAND(1, 1) = 0 (ciphertext 2, 3.0 s)
  Xor: 3 transactions, 1779718604 gas
  ...
1 + 1 + 0 = carry 1, sum 0 (15.5 s)
```

The demo keyset's secret key is derived from a public phrase (`DEMO_PHRASE` in `fhe-demo.rs`), so
that anyone can reproduce its encryptions and decryptions. **It is a demo key and protects
nothing.** For your own data, generate a key with `SecretKey::generate(&mut Rng::from_os())`,
upload its evaluation key to a keyset of your own, and keep the secret key to yourself.

## Limits

- One key holder: whoever holds a keyset's secret key decrypts everything computed under it.
  Sharing results between users needs threshold or multi-key FHE, which this does not implement.
- IND-CPA only. The contract cannot tell a well-formed ciphertext from garbage, and a gate's
  result is only as meaningful as its inputs.
- Not constant-time, and the client's Gaussian sampler uses floating point. Fine for a teaching
  example, not for a side-channel-exposed service.
- Slow and large: a gate takes three transactions, and a keyset is 63 MB. Known ways to shrink
  both: storing the bootstrapping key's uniform halves as a seed and expanding it on chain (half
  the size), and the LMKCDEY blind rotation (fewer, smaller keys).

## Exercise

Add `MUX(s, x, y)` (`s ? x : y`). It needs no new cryptography: build it from the gates the
contract has (for example `OR(AND(s, x), AND(NOT(s), y))`), first natively with `Evaluator`
in a test, then in `Fhe` in `client/src/node.rs`. How many transactions does it take, and how
could the contract evaluate the two ANDs at the same time?

## Credits

- I. Chillotti, N. Gama, M. Georgieva, M. Izabachène, *TFHE: Fast Fully Homomorphic Encryption
  over the Torus* (J. Cryptology 2020), for the CGGI blind rotation.
- L. Ducas, D. Micciancio, *FHEW: Bootstrapping Homomorphic Encryption in less than a second*
  (Eurocrypt 2015), and D. Micciancio, Y. Polyakov, *Bootstrapping in FHEW-like Cryptosystems*
  (eprint 2020/086).
- eprint 2022/074, section 5 (as OpenFHE's `rgsw-acc-cggi.cpp` cites it), for the update of
  the accumulator with a ternary secret.
- [OpenFHE](https://github.com/openfheorg/openfhe-development), whose `STD128` parameter set
  this uses, and whose `binfhe` module was the reference for every constant. No OpenFHE code is
  copied.
