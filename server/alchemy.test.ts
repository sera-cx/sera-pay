import { describe, it, expect } from "vitest";

const runIfAlchemyKey = process.env.ALCHEMY_API_KEY ? it : it.skip;

describe("Alchemy API key validation", () => {
  runIfAlchemyKey("should return eth_blockNumber from Alchemy Sepolia RPC", async () => {
    const apiKey = process.env.ALCHEMY_API_KEY!;

    const resp = await fetch(`https://eth-sepolia.g.alchemy.com/v2/${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
    });

    expect(resp.status).toBe(200);
    const json = await resp.json() as any;
    expect(json.result).toMatch(/^0x[0-9a-fA-F]+$/);
    console.log("Alchemy Sepolia block number:", parseInt(json.result, 16));
  });
});
