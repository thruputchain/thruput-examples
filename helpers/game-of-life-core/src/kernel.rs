/// Compute one toroidal Conway row. The width is `N * 8` cells.
pub fn compute_next_row<const N: usize>(
    previous: &[u8; N],
    current: &[u8; N],
    next: &[u8; N],
    output: &mut [u8; N],
) -> u32 {
    assert!(N > 0, "a Life row must contain at least one byte");
    output.fill(0);
    let width = N * 8;
    let mut population = 0;

    for x in 0..width {
        let left = if x == 0 { width - 1 } else { x - 1 };
        let right = if x + 1 == width { 0 } else { x + 1 };
        let neighbors = bit(previous, left)
            + bit(previous, x)
            + bit(previous, right)
            + bit(current, left)
            + bit(current, right)
            + bit(next, left)
            + bit(next, x)
            + bit(next, right);
        let alive = bit(current, x) != 0;
        if neighbors == 3 || (alive && neighbors == 2) {
            output[x / 8] |= 1 << (x % 8);
            population += 1;
        }
    }

    population
}

#[inline]
fn bit<const N: usize>(row: &[u8; N], x: usize) -> u8 {
    (row[x / 8] >> (x % 8)) & 1
}
