import { ListChecks, PenLine, ScanLine } from "lucide-react";
import { SIGN_RAW_CALL, VERIFY_RAW_CALL } from "./shared";
import type { GuideContent } from "./types";

export const transfer: GuideContent = {
  setup: [
    "Get the chain and token registry from the testnet API. Check both the connected wallet network and the sender address.",
    "Have the wallet sign for a CLOB session and let the backend seal the key in an HttpOnly cookie. Use it for /balances, /transfer and /transfer/send. The credential owner must match from_address.",
    "Choose a wallet that can sign a transaction and return the raw bytes. If the wallet only broadcasts or returns a proposal, show that this transfer flow is unavailable.",
  ],
  steps: [
    {
      id: "validate",
      icon: ScanLine,
      title: "Validate the transfer",
      summary:
        "Select the token by its current registry address and decimals. Resolve a contact to one exact address and show it before the user signs.",
      rules: [
        "Reject empty, zero, negative or over-precision amounts. Convert decimal strings to raw units without floating-point math or rounding.",
        "Reject malformed or zero recipients. Ask for deliberate confirmation on a self-transfer or a new recipient and preserve the reviewed address when retrying.",
        "Read the token balance from /balances. Use the native fee fields returned by /transfer to show the maximum gas cost. A standard ERC-20 transfer needs native ETH for gas.",
      ],
      sample: {
        title: "Build a testnet transfer",
        code: `// viem: getAddress, parseUnits, zeroAddress
// token is the exact ERC-20 entry selected from GET /tokens.
const to = getAddress(reviewedRecipient);
if (to.toLowerCase() === zeroAddress) throw new Error("Invalid recipient");
if (!/^\\d+(\\.\\d+)?$/.test(amount) ||
    (amount.split(".")[1]?.length ?? 0) > token.decimals) {
  throw new Error("Invalid token amount");
}
const rawAmount = parseUnits(amount, token.decimals);
if (rawAmount <= 0n || rawAmount >= 2n ** 256n) {
  throw new Error("Amount outside the supported range");
}

const { tx } = await sera("/transfer", {
  bearer,
  body: {
    token: token.address.toLowerCase(),
    to,
    from_address: owner.toLowerCase(),
    amount: rawAmount.toString(),
  },
});`,
      },
    },
    {
      id: "sign",
      icon: PenLine,
      title: "Verify, sign and send",
      summary:
        "Before the wallet prompt, decode the returned transaction and compare it with the reviewed transfer.",
      rules: [
        "Verify chainId, the ERC-20 contract in to, zero native value, the transfer selector, the decoded recipient and raw amount. Stop if anything differs.",
        "Submit raw signed bytes once through /transfer/send. If the wallet cannot return signed bytes, stop before submission.",
        "Save the pending intent before opening the wallet. Lock duplicate clicks and restore unfinished transfers after a refresh.",
      ],
      sample: {
        title: "Browser · review and sign the transfer",
        code: `// viem: decodeFunctionData, encodeFunctionData, erc20Abi, getAddress
const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
if (BigInt(tx.type) !== 2n || tx.accessList?.length || tx.authorizationList != null ||
    BigInt(tx.chainId) !== BigInt(config.chain_id) ||
    getAddress(tx.to) !== getAddress(token.address) ||
    BigInt(tx.value) !== 0n ||
    decoded.functionName !== "transfer" ||
    getAddress(decoded.args[0]) !== getAddress(reviewedRecipient) ||
    decoded.args[1] !== rawAmount || BigInt(tx.gas) <= 0n ||
    BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas) ||
    tx.data.toLowerCase() !== encodeFunctionData({ abi: erc20Abi,
      functionName: "transfer", args: [reviewedRecipient, rawAmount] }).toLowerCase())
  throw new Error("Transfer changed");

${SIGN_RAW_CALL}
// Send the signed bytes and stable attemptId to your authenticated backend.`,
      },
      extraSamples: [{
        title: "Backend · verify the signed bytes and broadcast once",
        code: `// Look up the reviewed tx by attemptId and its verified owner and chain.
${VERIFY_RAW_CALL}
// attemptId identifies the saved review across clicks, tabs and reloads.
// Your backend atomically claims (owner, chainId, attemptId) once before broadcast.
if (!(await claimPendingHash({ owner, chainId: config.chain_id, attemptId, expectedHash })))
  throw new Error("Transfer already awaiting acknowledgment");
const { tx_hash } = await sera("/transfer/send", { bearer, body: { raw_tx } });
if (tx_hash.toLowerCase() !== expectedHash.toLowerCase()) {
  throw new Error("Unexpected transaction hash; reconcile before retrying");
}`,
      }],
    },
    {
      id: "verify",
      icon: ListChecks,
      title: "Show the submission",
      summary:
        "A matching transaction hash from Sera means Submitted. The public API has no direct-transfer receipt or final-status endpoint.",
      rules: [
        "Save the signed hash before calling /transfer/send. Record the submission once when the returned tx_hash matches.",
        "Keep a lost response unresolved. Restore the original attempt on reload and prevent a second payment.",
        "Direct transfers have no CLOB order or fills. Your app can show its own submission history and the hash. It cannot confirm delivery through this API.",
      ],
      sample: {
        title: "Record Sera’s broadcast acknowledgment",
        code: `// expectedHash is keccak256(raw_tx), saved with the reviewed attempt.
if (!/^0x[0-9a-f]{64}$/i.test(expectedHash) ||
    acknowledgment?.tx_hash?.toLowerCase() !== expectedHash.toLowerCase()) return;
await recordSubmittedOnce({ chainId: config.chain_id, txHash: expectedHash, status: "submitted" });`,
      },
    },
  ],
  edgeCases: [
    [
      "Wrong network or wallet",
      "Stop before signing and rebuild the transfer after the switch.",
    ],
    [
      "Recipient or token mismatch",
      "Reject the transaction. Resolve the current address again and have the user confirm it.",
    ],
    [
      "Insufficient balance or gas",
      "Show which balance is short. Refresh balances and estimates after funding.",
    ],
    [
      "Signature declined",
      "Keep the draft. Release the pending claim only once you know nothing was broadcast.",
    ],
    [
      "Timeout, duplicate or reload",
      "Restore the original signed hash. A timeout leaves the outcome unknown. Keep the attempt and prevent a second transfer.",
    ],
    [
      "Unrecognized broadcast response",
      "Keep the submission unresolved if the returned hash differs from the signed bytes.",
    ],
  ],
  checklist: [
    {
      group: "Build and sign on Sepolia",
      items: [
        {
          q: "Send a small supported token amount to a second test wallet.",
          expect:
            "The wallet shows the reviewed token, amount, recipient and network.",
        },
        {
          q: "Try a malformed recipient, extra decimal places and an unregistered token.",
          expect: "Each case stops before any signing prompt.",
        },
        {
          q: "Run with too little token balance, too little gas, and then decline the signature.",
          expect: "Each result is explained and never shown as sent.",
        },
      ],
    },
    {
      group: "Verify and recover",
      items: [
        {
          q: "Reload after submitting and repeat the submit action.",
          expect:
            "The original submission stays visible and no second transfer is sent.",
        },
        {
          q: "Simulate a lost response and a mismatched hash.",
          expect:
            "Both remain unresolved. Only a matching acknowledgment changes the attempt to Submitted.",
        },
        {
          q: "Try a wallet that cannot return raw signed bytes.",
          expect: "The app explains the signing requirement before asking the wallet to submit.",
        },
      ],
    },
  ],
  promptRules: [
    "Let the sender select a registry token, enter the amount and review the exact recipient. Reject zero/invalid addresses, amounts outside uint256 and excess decimal places. Check GET /balances?owner_address=… for wallet_balance and show the native gas cost from the built transaction. Treat wallet_balance_available=false as unavailable data.",
    "From the server, POST /transfer with {token, to, from_address, amount}. Use the signed-in sender as from_address and a decimal string of raw units for amount. Decode the returned tx: verify chainId, ERC-20 contract in tx.to, zero tx.value and transfer(recipient, rawAmount) in tx.data against the reviewed draft.",
    "Persist the attempt before opening the wallet. For raw signing, require a plain EIP-1559 transaction with an empty access list, recover the signer and compare the signed transaction’s chain, nonce, fees, gas, destination, value and calldata to the reviewed transaction. Atomically claim the stable attempt ID with keccak256(raw_tx) once, then POST /transfer/send with {raw_tx} and match the returned tx_hash. Require a wallet that returns raw bytes. If unavailable, stop before signing.",
    "A matching /transfer/send acknowledgment means submitted. The public API has no direct-transfer receipt, direct-transfer history or final-status lookup. Save submissions locally, deduplicate by chain and signed hash, and keep a lost or mismatched response unresolved. Never fulfill a payment or promote a transfer to confirmed from a hash.",
  ],
  production:
    "Load mainnet config and tokens, provision a separate wallet credential, then verify a small transfer reaches Submitted with the matching Sera hash before making the feature available.",
};
