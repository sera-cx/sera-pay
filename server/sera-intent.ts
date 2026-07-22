import { hashStruct } from "viem";

export const SERA_INTENT_TYPES = {
  Intent: [
    { name: "taker", type: "address" },
    { name: "inputToken", type: "address" },
    { name: "outputToken", type: "address" },
    { name: "maxInputAmount", type: "uint256" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "initialDepositAmount", type: "uint256" },
    { name: "uuid", type: "uint256" },
    { name: "deadline", type: "uint48" },
  ],
} as const;

export type SeraIntentMessage = {
  taker: string;
  inputToken: string;
  outputToken: string;
  maxInputAmount: string;
  minOutputAmount: string;
  recipient: string;
  initialDepositAmount: string;
  uuid: string | number;
  deadline: string | number;
};

/** The struct hash emitted as `intentHash` by SeraSOR.IntentMatched. */
export function hashSeraIntentStruct(message: SeraIntentMessage): `0x${string}` {
  return hashStruct({
    types: SERA_INTENT_TYPES,
    primaryType: "Intent",
    data: message as any,
  });
}
