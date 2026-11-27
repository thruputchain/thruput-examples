//! Every gate on every input pair, repeatedly, through the same step code the contract runs;
//! the output noise against the decision margin; and composed circuits several bootstraps deep.

use fhe_client::{EvalKey, Rng, SecretKey};
use fhe_core::params::LWE_Q;
use fhe_core::{Evaluator, Gate, Lwe, lwe};
use std::sync::{Mutex, OnceLock};

struct Keys {
    sk: SecretKey,
    ek: Mutex<EvalKey>,
}

fn keys() -> &'static Keys {
    static KEYS: OnceLock<Keys> = OnceLock::new();
    KEYS.get_or_init(|| {
        let mut rng = Rng::from_phrase("fhe-client tests");
        let sk = SecretKey::generate(&mut rng);
        let ek = Mutex::new(sk.eval_key(&mut rng));
        Keys { sk, ek }
    })
}

fn gate(g: Gate, x: &Lwe, y: &Lwe) -> Lwe {
    let mut ek = keys().ek.lock().unwrap();
    Evaluator::new().gate(&mut *ek, g, x, y)
}

#[test]
fn pack_round_trip() {
    let mut rng = Rng::from_phrase("pack");
    let ct = keys().sk.encrypt(true, &mut rng);
    assert_eq!(Lwe::from_bytes(&ct.to_bytes()), Some(ct));
}

#[test]
fn fresh_and_not() {
    let k = keys();
    let mut rng = Rng::from_phrase("fresh");
    for _ in 0..200 {
        for bit in [false, true] {
            let ct = k.sk.encrypt(bit, &mut rng);
            assert_eq!(k.sk.decrypt(&ct), bit);
            assert_eq!(k.sk.decrypt(&lwe::not(&ct)), !bit);
        }
    }
}

/// Every gate on every input pair, `ROUNDS` times, on fresh inputs and on inputs that are
/// themselves gate outputs. Prints the output noise (standard deviation and worst case, mod q)
/// next to the margin of q/8 that a NAND input pair has before it decrypts wrongly.
#[test]
fn every_gate_every_input() {
    const ROUNDS: usize = 8;
    let k = keys();
    let mut rng = Rng::from_phrase("gates");
    let mut noise = Vec::new();
    for round in 0..ROUNDS {
        for g in Gate::ALL {
            for (x, y) in [(false, false), (false, true), (true, false), (true, true)] {
                let mut cx = k.sk.encrypt(x, &mut rng);
                let mut cy = k.sk.encrypt(y, &mut rng);
                if round % 2 == 1 {
                    // Use bootstrapped inputs: OR with a constant 0 refreshes a ciphertext.
                    cx = gate(Gate::Or, &cx, &Lwe::constant(false));
                    cy = gate(Gate::And, &cy, &Lwe::constant(true));
                    noise.push(k.sk.noise(&cx, x));
                    noise.push(k.sk.noise(&cy, y));
                }
                let out = gate(g, &cx, &cy);
                let want = g.eval(x, y);
                noise.push(k.sk.noise(&out, want));
                assert_eq!(k.sk.decrypt(&out), want, "{g:?}({x}, {y}) in round {round}");
            }
        }
    }
    let n = noise.len() as f64;
    let var = noise.iter().map(|&e| (e as f64).powi(2)).sum::<f64>() / n;
    let worst = noise.iter().map(|e| e.abs()).max().unwrap();
    println!(
        "{} bootstrapped outputs: noise sd {:.1}, worst {}, margin q/8 = {} (mod q = {})",
        noise.len(),
        var.sqrt(),
        worst,
        LWE_Q / 8,
        LWE_Q
    );
}

/// A full adder (XOR, XOR, AND, AND, OR: five bootstraps, three deep), on every input.
#[test]
fn full_adder() {
    let k = keys();
    let mut rng = Rng::from_phrase("adder");
    for bits in 0..8u8 {
        let (a, b, c) = (bits & 1 == 1, bits & 2 == 2, bits & 4 == 4);
        let [ca, cb, cc] = [a, b, c].map(|v| k.sk.encrypt(v, &mut rng));
        let ab = gate(Gate::Xor, &ca, &cb);
        let sum = gate(Gate::Xor, &ab, &cc);
        let carry = gate(
            Gate::Or,
            &gate(Gate::And, &ca, &cb),
            &gate(Gate::And, &ab, &cc),
        );
        let total = a as u8 + b as u8 + c as u8;
        assert_eq!(k.sk.decrypt(&sum), total & 1 == 1, "sum of {a} {b} {c}");
        assert_eq!(k.sk.decrypt(&carry), total >= 2, "carry of {a} {b} {c}");
    }
}
