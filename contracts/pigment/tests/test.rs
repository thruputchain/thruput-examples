use pigment::*;
use std::panic::AssertUnwindSafe;
use std::time::Duration;
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

// Blocks are a second apart, from START, when the canvas is laid out. An epoch is a minute.
const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000 * SECOND;
const EPOCH: u64 = 60 * SECOND;

// What a unit of paint costs, in native-token base units.
const PRICE: i128 = 3;

// The native tokens each painter starts with, all of which the canvas may take.
const FUNDS: i128 = 1_000_000;

// The native tokens the deployer starts with when storage is priced: plenty for the canvas's
// deposits.
const NATIVE: i128 = 100_000_000;

const RED: u32 = 0xFF_0000;
const GREEN: u32 = 0x00_FF00;
const BLUE: u32 = 0x00_00FF;

fn addr(name: &str) -> ContractAddress {
    ContractAddress::named(name)
}

fn names(prefix: &str, n: usize) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}-{i}")).collect()
}

fn stroke(x: u32, y: u32, color: u32, amount: u32) -> Stroke {
    Stroke {
        x,
        y,
        color,
        amount,
    }
}

fn terms(width: u32, height: u32) -> Terms {
    Terms {
        width,
        height,
        epoch: EPOCH,
        price: PRICE,
        beneficiary: addr("artist"),
    }
}

// Whether storage is free, as in most of these tests, or priced as the network prices it.
#[derive(Clone, Copy)]
enum Storage {
    Free,
    Priced,
}

struct Fixture {
    env: TestEnvironmentHandle,
    _code: MockContract,
    canvas: ContractAddress,
}

impl Fixture {
    // A `width` by `height` canvas, laid out at START, with each of `painters` funded and its
    // allowance granted. Returns two blocks into epoch 0.
    fn new(width: u32, height: u32, painters: &[String]) -> Self {
        Self::with_storage(width, height, painters, Storage::Free)
    }

    fn with_storage(width: u32, height: u32, painters: &[String], storage: Storage) -> Self {
        let env = match storage {
            Storage::Free => TestEnvironment::no_cost(),
            Storage::Priced => TestEnvironment::default(),
        };
        let deployer = addr("deployer");
        let painters: Vec<_> = painters.iter().map(|p| addr(p)).collect();
        for painter in &painters {
            env.setup_grant_storage_tokens(painter, FUNDS as i64);
        }
        if let Storage::Priced = storage {
            // The native token pays for its own allowance rows, like any token. A native balance
            // pays for its own row, so the beneficiary needs one before payments of a few units
            // can reach it.
            for who in [&deployer, &ADDRESS_NATIVE_TOKEN, &addr("artist")] {
                env.setup_grant_storage_tokens(who, NATIVE as i64);
            }
        }
        env.advance_block_at(START.into());
        env.set_block_time_step(Some(Duration::from_secs(1)));

        let code = register_mock_contract(&env);
        let mut canvas = deployer;
        env.transact(|tx| {
            tx.call(&deployer).run(AssertUnwindSafe(|| {
                // Deploy and lay out the canvas in one transaction, so nobody can lay it out
                // first. Under priced storage, the canvas pays deposits for what it lays out.
                canvas = deploy_contract(&sha256_static!("canvas"), code.as_hash());
                if let Storage::Priced = storage {
                    ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(&canvas, NATIVE / 2);
                }
                PigmentClient::new(&canvas).initialize(terms(width, height));
            }))
        })
        .assert_success();
        env.advance_block();

        for painter in painters {
            env.transact(|tx| {
                tx.call(&painter).run(move || {
                    ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(&canvas, FUNDS);
                })
            })
            .assert_success();
        }
        env.advance_block();

        Self {
            env,
            _code: code,
            canvas,
        }
    }

    // Run `f` against the canvas as `caller`, in the current block, and require it to succeed.
    fn call<R>(&self, caller: &str, f: impl FnOnce(PigmentClient) -> R) -> R
    where
        R: WriteXDR + xdr::ReadXDROwned,
    {
        let canvas = self.canvas;
        let result = self.env.transact(|tx| {
            tx.call(&addr(caller))
                .run(AssertUnwindSafe(|| f(PigmentClient::new(&canvas))))
        });
        result.assert_success();
        result.assert_return_as::<R>()
    }

    // The canvas error the call `f` makes fails with, as `caller`. `f` returns the call's error:
    // `|c| c.try_paint(strokes).err()`.
    fn refused(
        &self,
        caller: &str,
        f: impl FnOnce(PigmentClient) -> Option<CallError>,
    ) -> PigmentError {
        let canvas = self.canvas;
        let mut error = None;
        self.env
            .transact(|tx| {
                tx.call(&addr(caller)).run(AssertUnwindSafe(|| {
                    error = f(PigmentClient::new(&canvas));
                }))
            })
            .assert_success();
        error
            .expect("the call succeeded")
            .try_as::<PigmentError>()
            .expect("a canvas error")
    }

    // Paint, as `painter`, and require it to commit. Returns the fee.
    fn paint(&self, painter: &str, strokes: &[Stroke]) -> i128 {
        let strokes = VecM(strokes.to_vec());
        self.call(painter, |c| c.paint(strokes))
    }

    // Execute `painter`'s paint in the current block without committing it.
    fn pending_paint(&self, painter: &str, strokes: &[Stroke]) -> MockTransactionHandler {
        let (canvas, strokes) = (self.canvas, VecM(strokes.to_vec()));
        let mut tx = self.env.transaction().build();
        tx.call(&addr(painter))
            .run(move || PigmentClient::new(&canvas).paint(strokes))
            .assert_success();
        tx
    }

    fn pixel(&self, x: u32, y: u32) -> Pixel {
        self.call("viewer", |c| c.pixel(x, y))
    }

    fn row(&self, y: u32) -> Vec<u32> {
        self.call("viewer", |c| c.row(y)).0
    }

    fn native(&self, holder: ContractAddress) -> i128 {
        let r = self.env.transact(|tx| {
            tx.call(&addr("viewer"))
                .run(move || ERC20Client::new(&ADDRESS_NATIVE_TOKEN).get_balance_of(&holder))
        });
        r.assert_success();
        r.assert_return_as::<i128>()
    }

    // Move to a block `into` nanoseconds into epoch `epoch`.
    fn at(&self, epoch: u64, into: u64) {
        self.env
            .advance_block_at((START + epoch * EPOCH + into).into());
    }
}

// Commit `txs` in order, and return how each fared.
fn commit_all(txs: Vec<MockTransactionHandler>) -> Vec<TryCommitResult> {
    let mut txs = txs;
    let results = txs
        .iter_mut()
        .map(|tx| tx.try_commit_transaction())
        .collect();
    drop(txs);
    results
}

// The codes of the conflicts that kept a transaction out of its block.
fn conflicts(result: &TryCommitResult) -> Vec<DbConflictCode> {
    match result {
        TryCommitResult::TxNonDeterministicError(DbConflictResult::kDbDiagnosticAll {
            conflicts,
        }) => conflicts.iter().map(|c| c.code).collect(),
        TryCommitResult::TxNonDeterministicError(DbConflictResult::kDbDiagnosticFirst {
            first,
        }) => vec![first.code],
        other => panic!("expected a conflict, got {other:?}"),
    }
}

fn admitted(results: &[TryCommitResult]) -> usize {
    results
        .iter()
        .filter(|r| **r == TryCommitResult::Ok)
        .count()
}

// A pixel as `row` packs it.
fn rgba(color: u32, alpha: u32) -> u32 {
    (color << 8) | alpha
}

fn blank() -> Pixel {
    Pixel {
        color: 0,
        alpha: 0,
        wet: 0,
        fading: 0,
    }
}

// A stroke colours its pixel, and its painter pays the beneficiary for every unit.
#[test]
fn a_stroke_colors_a_pixel_and_pays_for_its_paint() {
    let f = Fixture::new(4, 4, &names("painter", 1));
    assert_eq!(f.paint("painter-0", &[stroke(1, 2, RED, 10)]), 10 * PRICE);
    f.env.advance_block();

    assert_eq!(
        f.pixel(1, 2),
        Pixel {
            color: RED,
            alpha: 255,
            wet: 10,
            fading: 0,
        }
    );
    assert_eq!(f.pixel(2, 1), blank());
    assert_eq!(f.native(addr("artist")), 10 * PRICE);
    assert_eq!(f.native(addr("painter-0")), FUNDS - 10 * PRICE);
    // The canvas keeps none of it.
    assert_eq!(f.native(f.canvas), 0);
}

// A pixel shows the mean of the colours painted on it, weighted by amount. Covering a colour takes
// more paint than it has.
#[test]
fn strokes_mix_by_amount() {
    let f = Fixture::new(4, 4, &names("painter", 2));
    // Three units of red, then one of blue, then a stroke of each in one call.
    f.paint("painter-0", &[stroke(0, 0, RED, 3)]);
    f.env.advance_block();
    f.paint("painter-1", &[stroke(0, 0, BLUE, 1)]);
    f.paint(
        "painter-1",
        &[stroke(3, 3, GREEN, 1), stroke(3, 3, BLUE, 1)],
    );
    f.env.advance_block();

    // Red is 3 * 255 / 4, and blue 255 / 4, each rounded down.
    assert_eq!(
        f.pixel(0, 0),
        Pixel {
            color: 0xBF_003F,
            alpha: 255,
            wet: 4,
            fading: 0,
        }
    );
    assert_eq!(f.pixel(3, 3).color, 0x00_7F7F);

    // Five more units of blue outweigh the red.
    f.paint("painter-1", &[stroke(0, 0, BLUE, 5)]);
    f.env.advance_block();
    // Red is 3 * 255 / 9, and blue 6 * 255 / 9.
    assert_eq!(f.pixel(0, 0).color, 0x55_00AA);
}

const CROWD: usize = 60;

// Sixty painters paint one pixel, each executed in one block before any commits, committed in the
// order `order` gives. The block is the first of epoch 1, so every one of them starts the pixel's
// coat over. Then each paints it again in a later block of the epoch, adding to the coat.
fn crowd_paints(order: impl Iterator<Item = usize> + Clone) -> Fixture {
    let painters = names("painter", CROWD);
    let f = Fixture::new(2, 2, &painters);
    // Something to start over: last epoch's coat in the slot epoch 1 reuses would be two epochs
    // old by now, but slot 1 has only the zero it was laid out with, from epoch 0.
    f.at(1, 0);

    for _ in 0..2 {
        let mut txs: Vec<_> = (0..CROWD)
            .map(|i| {
                let color = [RED, GREEN, BLUE][i % 3];
                Some(f.pending_paint(&painters[i], &[stroke(1, 1, color, 1 + i as u32 % 7)]))
            })
            .collect();
        for i in order.clone() {
            let mut tx = txs[i].take().unwrap();
            assert_eq!(
                tx.try_commit_transaction(),
                TryCommitResult::Ok,
                "paint {i}"
            );
        }
        drop(txs);
        f.env.advance_block();
    }
    f
}

// Strokes on one pixel never conflict: all sixty commit, both when they start the coat over and
// when they add to it, and the mix is the same whatever order they commit in.
#[test]
fn a_crowd_paints_one_pixel_in_one_block_in_any_order() {
    let forward = crowd_paints(0..CROWD);
    let backward = crowd_paints((0..CROWD).rev());

    let units = |c: usize| -> u32 {
        (0..CROWD)
            .filter(|i| i % 3 == c)
            .map(|i| 1 + i as u32 % 7)
            .sum()
    };
    let (red, green, blue) = (units(0), units(1), units(2));
    let depth = red + green + blue;
    let mean = |units: u32| units * 255 / depth;
    let expected = Pixel {
        color: (mean(red) << 16) | (mean(green) << 8) | mean(blue),
        alpha: 255,
        wet: 2 * depth,
        fading: 0,
    };
    assert_eq!(forward.pixel(1, 1), expected);
    assert_eq!(backward.pixel(1, 1), expected);
    for f in [&forward, &backward] {
        assert_eq!(f.native(addr("artist")), i128::from(2 * depth) * PRICE);
    }
}

// Paint is wet, at full weight, through the epoch it is applied in. Through the next it fades
// away, and new paint mixes with what is left of it. After that it is gone.
#[test]
fn paint_is_wet_for_its_epoch_then_fades() {
    let f = Fixture::new(2, 2, &names("painter", 1));
    f.paint("painter-0", &[stroke(0, 0, RED, 4)]);
    f.at(0, EPOCH - SECOND);
    assert_eq!(f.pixel(0, 0).alpha, 255);

    // At the start of epoch 1 the red begins to fade; a quarter of the way in, a quarter of it
    // is gone.
    f.at(1, 0);
    assert_eq!(
        f.pixel(0, 0),
        Pixel {
            color: RED,
            alpha: 255,
            wet: 0,
            fading: 4,
        }
    );
    f.at(1, EPOCH / 4);
    assert_eq!(f.pixel(0, 0).alpha, 191);

    // Halfway, four units of blue go on, wet, over the two units of red that are left.
    f.at(1, EPOCH / 2);
    f.paint("painter-0", &[stroke(0, 0, BLUE, 4)]);
    f.env.advance_block_at((START + EPOCH + EPOCH / 2).into());
    assert_eq!(
        f.pixel(0, 0),
        Pixel {
            // Red is 2 * 255 / 6, and blue 4 * 255 / 6.
            color: 0x55_00AA,
            alpha: 6 * 255 / 8,
            wet: 4,
            fading: 4,
        }
    );

    // In epoch 2 the red is gone, and the blue fading.
    f.at(2, 0);
    assert_eq!(
        f.pixel(0, 0),
        Pixel {
            color: BLUE,
            alpha: 255,
            wet: 0,
            fading: 4,
        }
    );
    f.at(3, 0);
    assert_eq!(f.pixel(0, 0), blank());
}

// Two epochs on, a pixel's slot is reused. What it held is ignored, and the first strokes on it
// start it over, with room for a full coat again.
#[test]
fn a_new_epoch_starts_the_coat_over() {
    let f = Fixture::new(2, 2, &names("painter", 1));
    f.paint("painter-0", &[stroke(0, 0, RED, MAX_DEPTH)]);
    f.env.advance_block();
    assert_eq!(
        f.refused("painter-0", |c| c
            .try_paint(VecM(vec![stroke(0, 0, RED, 1)]))
            .err()),
        PigmentError::PixelFull
    );

    // Epoch 2 reuses epoch 0's slot. Before anyone paints, the pixel is blank.
    f.at(2, 0);
    assert_eq!(f.pixel(0, 0), blank());
    f.paint("painter-0", &[stroke(0, 0, BLUE, 1)]);
    f.env.advance_block();
    assert_eq!(
        f.pixel(0, 0),
        Pixel {
            color: BLUE,
            alpha: 255,
            wet: 1,
            fading: 0,
        }
    );
    f.paint("painter-0", &[stroke(0, 0, BLUE, MAX_DEPTH - 1)]);
}

// A pixel holds at most `MAX_DEPTH` units from one epoch. A paint that would take it past that by
// itself is refused. Paints in one block cannot see each other, so together they can ask for more:
// the runtime admits them while the pixel holds them, and turns the rest away with nothing kept.
#[test]
fn a_full_pixel_takes_no_more_paint() {
    let painters = names("painter", 3);
    let f = Fixture::new(2, 2, &painters);
    let half = MAX_DEPTH / 2 + 1;
    assert_eq!(
        f.refused("painter-0", |c| c
            .try_paint(VecM(vec![stroke(0, 0, RED, half), stroke(0, 0, RED, half)]))
            .err()),
        PigmentError::PixelFull
    );

    // Each paint fits by itself, but only one fits beside the others.
    let txs = painters
        .iter()
        .zip([RED, GREEN, BLUE])
        .map(|(painter, color)| f.pending_paint(painter, &[stroke(0, 0, color, half)]))
        .collect();
    let results = commit_all(txs);
    assert_eq!(results[0], TryCommitResult::Ok);
    for result in &results[1..] {
        // The depth would overflow the coat's integer, which the runtime reports as going out of
        // its bounds.
        assert_eq!(conflicts(result), vec![DbConflictCode::BoundsExceeded]);
    }
    f.env.advance_block();

    // The coat is exactly the paint that was admitted: no lane spilled into the next.
    assert_eq!(
        f.pixel(0, 0),
        Pixel {
            color: RED,
            alpha: 255,
            wet: half,
            fading: 0,
        }
    );
    assert_eq!(f.native(addr("artist")), i128::from(half) * PRICE);
    assert_eq!(f.native(addr("painter-1")), FUNDS);
}

// A row comes back as one word a pixel: the colour, and the alpha in the low byte.
#[test]
fn a_row_packs_each_pixel() {
    let f = Fixture::new(5, 3, &names("painter", 1));
    f.paint("painter-0", &[stroke(0, 2, RED, 1), stroke(4, 2, GREEN, 2)]);
    f.at(1, EPOCH / 2);
    assert_eq!(f.row(2), vec![rgba(RED, 127), 0, 0, 0, rgba(GREEN, 127)]);
    assert_eq!(f.row(0), vec![0; 5]);
    assert_eq!(
        f.refused("viewer", |c| c.try_row(3).err()),
        PigmentError::OffCanvas
    );
}

// With storage priced as the network prices it, laying out a canvas costs the deposits for all
// the storage it will ever have. Painting only rewrites it: a crowd painting in one block,
// starting coats over in a new epoch, or adding to them, costs the canvas nothing.
#[test]
fn painting_never_costs_the_canvas_storage() {
    let painters = names("painter", 20);
    let f = Fixture::with_storage(8, 8, &painters, Storage::Priced);
    let laid_out = f.native(f.canvas);
    let cost = f.env.get_current_cost_model().nnint_cost();
    assert!(
        NATIVE / 2 - laid_out >= 2 * 8 * 8 * cost,
        "two coats a pixel"
    );

    for epoch in 0..3 {
        f.at(epoch, 10 * SECOND);
        for _ in 0..2 {
            let txs = painters
                .iter()
                .enumerate()
                .map(|(i, painter)| {
                    let (x, y) = (i as u32 % 8, i as u32 / 8);
                    f.pending_paint(painter, &[stroke(x, y, RED, 1), stroke(7, 7, BLUE, 1)])
                })
                .collect();
            assert_eq!(admitted(&commit_all(txs)), painters.len());
            f.env.advance_block();
        }
    }
    assert_eq!(f.native(f.canvas), laid_out);
    assert_eq!(f.pixel(7, 7).wet, 2 * painters.len() as u32);
}

// A canvas that cannot pay for its storage cannot be laid out.
#[test]
fn an_unfunded_canvas_cannot_be_laid_out() {
    let env = TestEnvironment::default();
    let deployer = addr("deployer");
    env.setup_grant_storage_tokens(&deployer, NATIVE as i64);
    env.setup_grant_storage_tokens(&ADDRESS_NATIVE_TOKEN, NATIVE as i64);
    let code = register_mock_contract(&env);
    env.transact(|tx| {
        tx.call(&deployer).run(AssertUnwindSafe(|| {
            let canvas = deploy_contract(&sha256_static!("canvas"), code.as_hash());
            PigmentClient::new(&canvas).initialize(terms(8, 8));
        }))
    })
    .assert_commit_failed();
}

#[test]
fn bad_terms_are_refused() {
    let f = Fixture::new(2, 2, &[]);
    assert_eq!(
        f.refused("deployer", |c| c.try_initialize(terms(2, 2)).err()),
        PigmentError::AlreadyInitialized
    );

    let code = register_mock_contract(&f.env);
    f.env
        .transact(|tx| {
            tx.call(&addr("deployer")).run(AssertUnwindSafe(|| {
                let canvas = deploy_contract(&sha256_static!("another"), code.as_hash());
                let c = PigmentClient::new(&canvas);
                assert_eq!(
                    c.try_canvas().unwrap_err().try_as(),
                    Some(PigmentError::NotInitialized)
                );
                for bad in [
                    terms(0, 2),
                    terms(2, 0),
                    terms(MAX_SIDE + 1, 2),
                    terms(2, MAX_SIDE + 1),
                    Terms {
                        epoch: MIN_EPOCH - 1,
                        ..terms(2, 2)
                    },
                    Terms {
                        price: 0,
                        ..terms(2, 2)
                    },
                    Terms {
                        beneficiary: ContractAddress::default(),
                        ..terms(2, 2)
                    },
                ] {
                    assert_eq!(
                        c.try_initialize(bad).unwrap_err().try_as(),
                        Some(PigmentError::InvalidTerms),
                        "{bad:?}"
                    );
                }
            }))
        })
        .assert_success();
}

#[test]
fn bad_strokes_are_refused() {
    let f = Fixture::new(3, 2, &names("painter", 1));
    let refused =
        |strokes: Vec<Stroke>| f.refused("painter-0", |c| c.try_paint(VecM(strokes)).err());
    assert_eq!(refused(vec![]), PigmentError::NoPaint);
    assert_eq!(refused(vec![stroke(0, 0, RED, 0)]), PigmentError::NoPaint);
    assert_eq!(refused(vec![stroke(3, 0, RED, 1)]), PigmentError::OffCanvas);
    assert_eq!(refused(vec![stroke(0, 2, RED, 1)]), PigmentError::OffCanvas);
    assert_eq!(
        refused(vec![stroke(0, 0, 0x100_0000, 1)]),
        PigmentError::InvalidColor
    );
    assert_eq!(
        refused(vec![stroke(0, 0, RED, MAX_DEPTH + 1)]),
        PigmentError::PixelFull
    );
    // One bad stroke spoils the call: nothing is painted, or paid for.
    assert_eq!(
        refused(vec![stroke(0, 0, RED, 1), stroke(9, 9, RED, 1)]),
        PigmentError::OffCanvas
    );
    f.env.advance_block();
    assert_eq!(f.pixel(0, 0), blank());

    // A painter that has granted the canvas no allowance cannot pay.
    let canvas = f.canvas;
    f.env
        .transact(|tx| {
            tx.call(&addr("stranger")).run(move || {
                let paid = PigmentClient::new(&canvas).try_paint(VecM(vec![stroke(0, 0, RED, 1)]));
                assert!(paid.is_err());
            })
        })
        .assert_success();
}
