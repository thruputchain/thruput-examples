use super::*;
use std::fmt::{self, Display};

// A snapshot of some balances
#[derive(Debug, PartialEq)]
pub struct SwapStats {
    pub user_a: (User, (Amounts, Amount)),
    pub user_b: (User, (Amounts, Amount)),
    pub swap_pair: (Amounts, Amount),
}

impl Display for SwapStats {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        writeln!(f, "\tUserA {:?}", self.user_a.1)?;
        writeln!(f, "\tUserB {:?}", self.user_b.1)?;
        writeln!(f, "\tPair  {:?}", self.swap_pair)?;
        Ok(())
    }
}
