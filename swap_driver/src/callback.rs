use sdk::*;
use groundhog_xdr::transaction::{
    Invocation, Transaction, Uniquifier,
};
use groundhog_contract_util::{
    EntrypointSignature, NormalizedMethodSignature
};

pub fn submit_process_requests_callback(self_addr: &ContractAddress, callback_id: u64) {
    let entrypoint = EntrypointSignature {
        interface_name: Some("SwapV2Driver".to_string()),
        version_str: env!("CARGO_PKG_VERSION").to_string(),
        method_sig: NormalizedMethodSignature::new("process_requests"),
    }.id();

    let tx = build_call_transaction(BuildCallTransaction {
        invoked_address: *self_addr,
        entrypoint,
        calldata: xdrs::cxs::encode(&()).unwrap(),
        gas_limit: crate::swapv2_driver::PROCESS_REQUESTS_GAS,
        block_expiry_height: get_block_height().into_inner() + 10,
        nonce: callback_id,
        auth_claim: get_auth_claim().unwrap(), // XXX
    });

    let encoded_tx = encode_transaction_xdr(&tx);

    sdk::log(encoded_tx.as_ref());
}

pub fn encode_transaction_xdr(tx: &Transaction) -> Vec<u8> {
    xdrs::txs::encode(tx).unwrap()
}

/// Inputs for constructing a contract invocation transaction.
pub struct BuildCallTransaction {
    /// Address being invoked.
    pub invoked_address: ContractAddress,
    /// Entry point to invoke.
    pub entrypoint: ContractEntrypointID,
    /// Encoded calldata bytes.
    pub calldata: Vec<u8>,
    /// Transaction gas limit.
    pub gas_limit: u64,
    /// Transaction expiry height.
    pub block_expiry_height: i64,
    /// Transaction nonce.
    pub nonce: u64,
    /// Auth claim attached to the transaction.
    pub auth_claim: AuthClaim,
}

/// Builds a call transaction with no contracts-to-deploy or gas claims.
pub fn build_call_transaction(args: BuildCallTransaction) -> Transaction {
    let invocation = Invocation {
        invoked_address: args.invoked_address,
        entrypoint: args.entrypoint,
        gas_limit: args.gas_limit,
        calldata: BytesM(args.calldata),
    };

    let uniquifier = Uniquifier {
        block_expiry_height: BlockHeight::from(args.block_expiry_height),
        nonce: args.nonce,
    };

    Transaction {
        invocation,
        uniquifier,
        contracts_to_deploy: VecM(vec![]),
        auth_claim: args.auth_claim,
    }
}

/*
fn callback_nonce(id: u64, addr: &ContractAddress, entrypoint: ContractEntrypointId) -> SHA256Hash {
    let preimage = NoncePreimage { id, addr, entrypoint };

    let mut h = Hasher::new();
    h.update(&xdrs::cxs::encode(&preimage).unwrap());
    h.finish()
}

#[derive(WriteXDR)]
struct NoncePreimage<'a> {
    pub id: u64,
    pub addr: &'a ContractAddress,
    pub entrypoint: ContractEntrypointID,
}
*/
