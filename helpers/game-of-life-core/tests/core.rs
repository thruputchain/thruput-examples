use game_of_life_core::digest::WorldDigest;
use game_of_life_core::kernel::compute_next_row;
use game_of_life_core::prng::SplitMix64;

#[test]
fn splitmix64_matches_canonical_seed_zero_vectors() {
    let mut rng = SplitMix64::new(0);
    assert_eq!(rng.next_u64(), 0xE220_A839_7B1D_CDAF);
    assert_eq!(rng.next_u64(), 0x6E78_9E6A_A1B9_65F4);
    assert_eq!(rng.next_u64(), 0x06C4_5D18_8009_454F);
}

#[test]
fn byte_stream_continues_across_unaligned_chunks() {
    let mut chunked = SplitMix64::new(42);
    let mut first = [0u8; 5];
    let mut second = [0u8; 11];
    chunked.fill_bytes(&mut first);
    chunked.fill_bytes(&mut second);

    let mut contiguous = SplitMix64::new(42);
    let mut expected = [0u8; 16];
    contiguous.fill_bytes(&mut expected);

    assert_eq!([first.as_slice(), second.as_slice()].concat(), expected);
}

#[test]
fn digest_pins_field_widths_byte_order_and_actual_chunk_length() {
    let mut digest = WorldDigest::new(10_000, 10_000, 7);
    digest.update(0, &[1, 2, 3]);
    digest.update(1, &[4, 5]);
    assert_eq!(
        digest.finish(),
        [
            0xcb, 0x94, 0x4c, 0x57, 0x99, 0x1a, 0x6f, 0x05, 0x98, 0x56, 0x26, 0xfc, 0x08, 0x0b,
            0x6a, 0xb8, 0x77, 0x00, 0x24, 0x38, 0xd1, 0x59, 0xd0, 0xd3, 0x35, 0x98, 0x8e, 0xc7,
            0xcf, 0x87, 0xed, 0xc0,
        ]
    );
}

#[test]
fn full_scale_seed_vectors_are_reproducible() {
    assert_eq!(
        initialized_world(0),
        (
            49_999_272,
            [
                0x85, 0xd7, 0x2e, 0x50, 0x01, 0x6b, 0xad, 0xaf, 0xcf, 0x3b, 0xc5, 0xc7, 0x04, 0x0d,
                0x42, 0x90, 0x0b, 0x04, 0x17, 0xc3, 0xad, 0xc6, 0x72, 0x10, 0x15, 0xaa, 0x11, 0x47,
                0xd6, 0x73, 0x3e, 0x05,
            ],
        )
    );
    assert_eq!(
        initialized_world(1),
        (
            50_010_937,
            [
                0x5b, 0xc5, 0x82, 0xc3, 0x30, 0xd2, 0xad, 0xd2, 0x8e, 0x5b, 0xaf, 0x16, 0x45, 0xc6,
                0x19, 0x12, 0xcb, 0x1f, 0xf4, 0x02, 0xa5, 0xd8, 0x89, 0x8f, 0x6e, 0x30, 0x6b, 0x28,
                0xca, 0xb2, 0xbf, 0xd5,
            ],
        )
    );
}

#[test]
#[ignore = "full 100-million-cell reference pass; run in release mode"]
fn full_scale_generation_one_vector() {
    let mut rng = SplitMix64::new(0);
    let mut world = vec![[0u8; 1_250]; 10_000];
    for row in &mut world {
        rng.fill_bytes(row);
    }

    let mut digest = WorldDigest::new(10_000, 10_000, 1);
    let mut population = 0u64;
    let mut output = [0u8; 1_250];
    for y in 0..10_000 {
        population += u64::from(compute_next_row(
            &world[(y + 9_999) % 10_000],
            &world[y],
            &world[(y + 1) % 10_000],
            &mut output,
        ));
        let key = (y as u32) * 2;
        digest.update(key, &output[..1_000]);
        digest.update(key + 1, &output[1_000..]);
    }
    assert_eq!(
        (population, digest.finish()),
        (
            27_336_807,
            [
                0x51, 0xae, 0xd4, 0x70, 0xa5, 0xda, 0xb0, 0x91, 0x13, 0x14, 0x71, 0x8a, 0xb3, 0xa6,
                0x41, 0xc0, 0x14, 0xe0, 0x68, 0x41, 0x95, 0x16, 0x48, 0xf0, 0xf0, 0x64, 0x66, 0x31,
                0x9f, 0x46, 0x5c, 0xe8,
            ],
        )
    );
}

#[test]
fn dead_world_remains_dead_and_output_is_cleared() {
    let row = [0u8; 2];
    let mut output = [0xFF; 2];
    let population = compute_next_row(&row, &row, &row, &mut output);
    assert_eq!(population, 0);
    assert_eq!(output, [0; 2]);
}

#[test]
fn row_kernel_population_matches_output_bits() {
    let previous = [0b1000_0001];
    let current = [0b0000_0011];
    let next = [0b0100_0010];
    let mut output = [0];
    let population = compute_next_row(&previous, &current, &next, &mut output);
    assert_eq!(population, output[0].count_ones());
}

#[test]
fn standard_patterns_and_toroidal_edges_match_reference_model() {
    const H: usize = 8;
    const N: usize = 2;
    let patterns = [
        &[(3, 3)][..],
        &[(3, 2), (3, 3), (3, 4)][..],
        &[(5, 2), (6, 2), (5, 3), (6, 3)][..],
        &[(1, 0), (0, 1), (15, 1)][..],
        &[(0, 0), (15, 0), (0, 7)][..],
        &[(2, 1), (3, 2), (1, 3), (2, 3), (3, 3)][..],
    ];

    for pattern in patterns {
        let world = world_from_cells::<H, N>(pattern);
        assert_eq!(kernel_step(world), reference_step(world));
    }
}

#[test]
fn randomized_worlds_match_simple_reference_model() {
    const H: usize = 9;
    const N: usize = 3;
    let mut rng = SplitMix64::new(0xCAFE_BABE);
    for _ in 0..128 {
        let mut world = [[0u8; N]; H];
        for row in &mut world {
            rng.fill_bytes(row);
        }
        assert_eq!(kernel_step(world), reference_step(world));
    }
}

fn world_from_cells<const H: usize, const N: usize>(cells: &[(usize, usize)]) -> [[u8; N]; H] {
    let mut world = [[0u8; N]; H];
    for &(x, y) in cells {
        world[y][x / 8] |= 1 << (x % 8);
    }
    world
}

fn kernel_step<const H: usize, const N: usize>(world: [[u8; N]; H]) -> [[u8; N]; H] {
    let mut output = [[0u8; N]; H];
    for (y, output_row) in output.iter_mut().enumerate() {
        compute_next_row(
            &world[(y + H - 1) % H],
            &world[y],
            &world[(y + 1) % H],
            output_row,
        );
    }
    output
}

fn reference_step<const H: usize, const N: usize>(world: [[u8; N]; H]) -> [[u8; N]; H] {
    let width = N * 8;
    let mut output = [[0u8; N]; H];
    for (y, output_row) in output.iter_mut().enumerate() {
        for x in 0..width {
            let mut neighbors = 0;
            for dy in [H - 1, 0, 1] {
                for dx in [width - 1, 0, 1] {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    neighbors += cell(&world, (x + dx) % width, (y + dy) % H);
                }
            }
            let alive = cell(&world, x, y) != 0;
            if neighbors == 3 || (alive && neighbors == 2) {
                output_row[x / 8] |= 1 << (x % 8);
            }
        }
    }
    output
}

fn cell<const H: usize, const N: usize>(world: &[[u8; N]; H], x: usize, y: usize) -> u8 {
    (world[y][x / 8] >> (x % 8)) & 1
}

fn initialized_world(seed: u64) -> (u64, [u8; 32]) {
    let mut rng = SplitMix64::new(seed);
    let mut digest = WorldDigest::new(10_000, 10_000, 0);
    let mut population = 0u64;
    let mut full = [0u8; 1_000];
    let mut tail = [0u8; 250];
    for row in 0..10_000u32 {
        let key = row * 2;
        rng.fill_bytes(&mut full);
        population += full
            .iter()
            .map(|byte| u64::from(byte.count_ones()))
            .sum::<u64>();
        digest.update(key, &full);
        rng.fill_bytes(&mut tail);
        population += tail
            .iter()
            .map(|byte| u64::from(byte.count_ones()))
            .sum::<u64>();
        digest.update(key + 1, &tail);
    }
    (population, digest.finish())
}
