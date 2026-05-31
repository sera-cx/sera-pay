// Buffer polyfill — must be the very first import in main.tsx so that
// wagmi/viem/Privy embedded-wallet internals can reference Buffer during
// their own module-level initialization (before the main.tsx body runs).
import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
