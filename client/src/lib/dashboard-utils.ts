import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shortenAddress(address: string | null | undefined): string {
  if (!address || address.length < 10) return address || "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatAmount(amount: string | number): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "0.00";
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

const COIN_CURRENCY: Record<string, string> = {
  USDT: "USD", USDC: "USD", DAI: "USD", BUSD: "USD", FRAX: "USD",
  LUSD: "USD", USDP: "USD", FDUSD: "USD", USDD: "USD", TUSD: "USD",
  GUSD: "USD", USDX: "USD", USDE: "USD", SUSD: "USD", PYUSD: "USD",
  CRVUSD: "USD", GHO: "USD", USDV: "USD", USDY: "USD", USDB: "USD",
  ZUSD: "USD", USDZ: "USD", DOLA: "USD", HAI: "USD", EUSD: "USD",
  MIM: "USD", MAI: "USD", BEAN: "USD", VOLT: "USD", FLOAT: "USD",
  RAI: "USD", USDK: "USD", USDL: "USD",
  XSGD: "SGD",
  MYRT: "MYR",
  IDRX: "IDR", XIDR: "IDR", IDRT: "IDR",
  JPYC: "JPY", GYEN: "JPY",
  THBK: "THB", THBT: "THB",
  KRW1: "KRW", KRWO: "KRW", KRWIN: "KRW",
  CNHT: "CNY",
  HKDR: "HKD",
  AUDD: "AUD", AUDF: "AUD",
  NZDD: "NZD", NZDS: "NZD",
  EURC: "EUR", VEUR: "EUR", EURT: "EUR",
  VGBP: "GBP", GBPA: "GBP", TGBP: "GBP",
  VCHF: "CHF", CCHF: "CHF",
  TRYB: "TRY",
  CADC: "CAD", QCAD: "CAD",
  BRZ: "BRL", BRLA: "BRL",
  MXNT: "MXN", MXNB: "MXN",
  ARZ: "ARS", ARC: "ARS",
  ZARP: "ZAR", ZARU: "ZAR",
  CNGN: "NGN",
};

const CURRENCY_DECIMALS: Record<string, number> = {
  IDR: 0, JPY: 0, KRW: 0,
  BHD: 3, KWD: 3,
};

export function getCoinCurrency(coinSymbol: string): string {
  return COIN_CURRENCY[coinSymbol?.toUpperCase()] ?? "USD";
}

export function formatPaymentAmount(amount: string | number, coinSymbol: string): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "0.00";
  const currency = getCoinCurrency(coinSymbol);
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  return num.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }) + " " + currency;
}

export const SOUND_PREF_KEY = "serapay_notification_sound";
export type SoundPref = "zh" | "en" | "chime" | "mute";

export function getSoundPref(): SoundPref {
  try {
    const v = localStorage.getItem(SOUND_PREF_KEY);
    if (v === "zh" || v === "en" || v === "chime" || v === "mute") return v;
  } catch {}
  return "zh";
}

export function playNotificationSound() {
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);

    // Three-note ascending chime: A5 → C#6 → E6 (A major triad)
    // Each note: fundamental + 2nd harmonic for warm bell quality
    const notes = [
      { freq: 880,  time: 0,    decay: 0.55, vol: 0.42 },
      { freq: 1109, time: 0.13, decay: 0.65, vol: 0.46 },
      { freq: 1319, time: 0.26, decay: 0.80, vol: 0.50 },
    ];

    for (const { freq, time, decay, vol } of notes) {
      const t0 = ctx.currentTime + time;

      // Fundamental
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + 0.007);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + decay);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t0);
      osc.stop(t0 + decay + 0.05);

      // 2nd harmonic (bell body)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = "sine";
      osc2.frequency.value = freq * 2.756; // inharmonic partial for bell quality
      gain2.gain.setValueAtTime(0, t0);
      gain2.gain.linearRampToValueAtTime(vol * 0.28, t0 + 0.007);
      gain2.gain.exponentialRampToValueAtTime(0.001, t0 + decay * 0.5);
      osc2.connect(gain2);
      gain2.connect(master);
      osc2.start(t0);
      osc2.stop(t0 + decay * 0.55);
    }

    // Soft low "thud" at the very start for a sense of weight
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(200, ctx.currentTime);
    sub.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.07);
    subGain.gain.setValueAtTime(0.35, ctx.currentTime);
    subGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    sub.connect(subGain);
    subGain.connect(master);
    sub.start(ctx.currentTime);
    sub.stop(ctx.currentTime + 0.12);
  } catch (error) {
    console.error("Audio playback failed", error);
  }
}
