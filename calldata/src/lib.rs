#![cfg_attr(not(feature = "dev"), no_std)]
#![allow(clippy::too_many_arguments)]

use sdk::*;

sdk::declare_mock_contract!();

pub struct Calldata;

#[contract]
impl Calldata {
    pub fn sum16(
        a00: u32,
        a01: u32,
        a02: u32,
        a03: u32,
        a04: u32,
        a05: u32,
        a06: u32,
        a07: u32,
        a08: u32,
        a09: u32,
        a10: u32,
        a11: u32,
        a12: u32,
        a13: u32,
        a14: u32,
        a15: u32,
    ) -> u32 {
        a00.wrapping_add(a01)
            .wrapping_add(a02)
            .wrapping_add(a03)
            .wrapping_add(a04)
            .wrapping_add(a05)
            .wrapping_add(a06)
            .wrapping_add(a07)
            .wrapping_add(a08)
            .wrapping_add(a09)
            .wrapping_add(a10)
            .wrapping_add(a11)
            .wrapping_add(a12)
            .wrapping_add(a13)
            .wrapping_add(a14)
            .wrapping_add(a15)
    }
}
