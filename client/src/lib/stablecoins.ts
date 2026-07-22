export interface Stablecoin {
  symbol: string;
  name: string;
  currency: string;
  contractAddress: string;
  decimals: number;
  icon: string;
  logoUri?: string;
  region: string;
}

// All Sepolia contract addresses sourced from https://docs.sera.cx/tokens
export const STABLECOINS: Stablecoin[] = [
  // ── USD ──────────────────────────────────────────────────────────────────
  { symbol: "USDT", name: "Tether USD", currency: "USD", contractAddress: "0x1920bf0643ae49b4fb334586dad6bed29ff30f88", decimals: 6, icon: "🇺🇸", region: "Americas" },
  { symbol: "USDC", name: "USD Coin", currency: "USD", contractAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", decimals: 6, icon: "🇺🇸", region: "Americas" },

  // ── SGD ──────────────────────────────────────────────────────────────────
  { symbol: "XSGD", name: "StraitsX SGD", currency: "SGD", contractAddress: "0x1fe69b1171d8aa5e6d432f14a9e4129ed96e40c0", decimals: 6, icon: "🇸🇬", region: "Asia Pacific" },
  { symbol: "TNSGD", name: "TN SGD", currency: "SGD", contractAddress: "0x4638f8eb9f2047ab18d70e12539e0b16ff2998a2", decimals: 6, icon: "🇸🇬", region: "Asia Pacific" },

  // ── MYR ──────────────────────────────────────────────────────────────────
  { symbol: "MYRT", name: "MYRT Ringgit", currency: "MYR", contractAddress: "0x68077f53a6562d42051c86b09160ea577f3c7476", decimals: 6, icon: "🇲🇾", region: "Asia Pacific" },

  // ── IDR ──────────────────────────────────────────────────────────────────
  { symbol: "IDRX", name: "IDRX Rupiah", currency: "IDR", contractAddress: "0x258f1e146b8bd0decf54bad8f1f01fe69025601c", decimals: 6, icon: "🇮🇩", region: "Asia Pacific" },
  { symbol: "IDRT", name: "IDR Tether", currency: "IDR", contractAddress: "0x26db12e7cb7be8ab22a97b7e4c3d33c0bfe89e82", decimals: 6, icon: "🇮🇩", region: "Asia Pacific" },
  { symbol: "XIDR", name: "XIDR Rupiah", currency: "IDR", contractAddress: "0xe02bbf861736147e1506d07239d7f2d291fb39fc", decimals: 6, icon: "🇮🇩", region: "Asia Pacific" },

  // ── JPY ──────────────────────────────────────────────────────────────────
  { symbol: "JPYC", name: "JPY Coin", currency: "JPY", contractAddress: "0x2c9e4db557af394f1f21d1e1e6754a7cb1ec1d01", decimals: 6, icon: "🇯🇵", region: "Asia Pacific" },
  { symbol: "GYEN", name: "GMO Yen", currency: "JPY", contractAddress: "0xa39c3648cd2b5a183af33dcc30af6799a13ad7ae", decimals: 6, icon: "🇯🇵", region: "Asia Pacific" },

  // ── THB ──────────────────────────────────────────────────────────────────
  { symbol: "THBK", name: "THB Kaidex", currency: "THB", contractAddress: "0x696451a335eb929934a1020db4ed655f33765802", decimals: 6, icon: "🇹🇭", region: "Asia Pacific" },
  { symbol: "THBT", name: "THB Token", currency: "THB", contractAddress: "0x5e875193255bfe0557701dceb01831c7bdfa910b", decimals: 6, icon: "🇹🇭", region: "Asia Pacific" },

  // ── KRW ──────────────────────────────────────────────────────────────────
  { symbol: "KRW1", name: "KRW One", currency: "KRW", contractAddress: "0x01943628c3e70a4f39ce905e8fea56e7a8a357f8", decimals: 6, icon: "🇰🇷", region: "Asia Pacific" },
  { symbol: "KRWO", name: "KRW Onchain", currency: "KRW", contractAddress: "0x4c16af20c7f8a841397273955c6451f4feb6a576", decimals: 6, icon: "🇰🇷", region: "Asia Pacific" },
  { symbol: "KRWIN", name: "KRW Internet", currency: "KRW", contractAddress: "0xce2ddc28068b3929ecf9787ec47284a9e3a62b3a", decimals: 6, icon: "🇰🇷", region: "Asia Pacific" },

  // ── CNY / HKD ────────────────────────────────────────────────────────────
  { symbol: "CNHT", name: "CNH Tether", currency: "CNY", contractAddress: "0x8f3f6be3f2545d5d90275f0da98980264f6a8913", decimals: 6, icon: "🇨🇳", region: "Asia Pacific" },
  { symbol: "CNGN", name: "cNGN Naira", currency: "NGN", contractAddress: "0x82167fecbb10c496f75afcd933dc0e23891e1cf3", decimals: 6, icon: "🇳🇬", region: "Africa & Middle East" },
  { symbol: "HKDR", name: "HKD Reserve", currency: "HKD", contractAddress: "0x40ad01c5ade2a9202d110c621919d0a2b147eb97", decimals: 6, icon: "🇭🇰", region: "Asia Pacific" },

  // ── AUD ──────────────────────────────────────────────────────────────────
  { symbol: "AUDD", name: "AUD Digital", currency: "AUD", contractAddress: "0x03a8d551bf1d708471064aa97fea004a45ed8cf3", decimals: 6, icon: "🇦🇺", region: "Asia Pacific" },
  { symbol: "AUDF", name: "AUD Finance", currency: "AUD", contractAddress: "0x06dce1a62f5d3188d016e640f3a9dd3bb26f9431", decimals: 6, icon: "🇦🇺", region: "Asia Pacific" },

  // ── NZD ──────────────────────────────────────────────────────────────────
  { symbol: "NZDD", name: "NZD Digital", currency: "NZD", contractAddress: "0x2cdc20d7efee786d28529ecc8a0a491bee84b207", decimals: 6, icon: "🇳🇿", region: "Asia Pacific" },
  { symbol: "NZDS", name: "NZD Stable", currency: "NZD", contractAddress: "0xa6da6f948f6c95d4d6525856208b1a267a37c905", decimals: 6, icon: "🇳🇿", region: "Asia Pacific" },

  // ── PHP ──────────────────────────────────────────────────────────────────
  { symbol: "PHPC", name: "PHP Coin", currency: "PHP", contractAddress: "0x9aa087afd8c3eada4f52dfe61aac507bf845bc29", decimals: 6, icon: "🇵🇭", region: "Asia Pacific" },

  // ── EUR ──────────────────────────────────────────────────────────────────
  { symbol: "EURC", name: "Euro Coin", currency: "EUR", contractAddress: "0xd3bdb2ce9cd98566efc2e2977448c40578371779", decimals: 6, icon: "🇪🇺", region: "Europe" },
  { symbol: "EURT", name: "Euro Tether", currency: "EUR", contractAddress: "0x47230df72231f594c5c598635dd92849c11532d0", decimals: 6, icon: "🇪🇺", region: "Europe" },
  { symbol: "TNEUR", name: "TN EUR", currency: "EUR", contractAddress: "0xe4af44ef7ce074f8fa94131035108201a5ac2f3a", decimals: 6, icon: "🇪🇺", region: "Europe" },
  { symbol: "VEUR", name: "Verified EUR", currency: "EUR", contractAddress: "0x4abcbc7c307bacf5adbfc57e822658f5d917ca1e", decimals: 6, icon: "🇪🇺", region: "Europe" },

  // ── GBP ──────────────────────────────────────────────────────────────────
  { symbol: "GBPA", name: "GBP Alliance", currency: "GBP", contractAddress: "0xd685bc15a53bbb624b98ebf97b357db8e0da4a23", decimals: 6, icon: "🇬🇧", region: "Europe" },
  { symbol: "TGBP", name: "GBP Tether", currency: "GBP", contractAddress: "0xa26f1088f41714b696d0e7b117fa9cbd810bbe8b", decimals: 6, icon: "🇬🇧", region: "Europe" },
  { symbol: "VGBP", name: "Verified GBP", currency: "GBP", contractAddress: "0x01d8b6e34a57573ff48d49fa047b45054f939eda", decimals: 6, icon: "🇬🇧", region: "Europe" },

  // ── CHF ──────────────────────────────────────────────────────────────────
  { symbol: "VCHF", name: "Verified CHF", currency: "CHF", contractAddress: "0x1e7fd8256cff4c61519e9e7e5e9d0496a14b0d5b", decimals: 6, icon: "🇨🇭", region: "Europe" },
  { symbol: "CCHF", name: "Crypto CHF", currency: "CHF", contractAddress: "0xa6b42b17219c854e4a44f40ed93d15a5fd88676e", decimals: 6, icon: "🇨🇭", region: "Europe" },

  // ── TRY ──────────────────────────────────────────────────────────────────
  { symbol: "TRYB", name: "Turkish Lira", currency: "TRY", contractAddress: "0x0d2968dc1b9ec131becab8e28193e81bcd63040c", decimals: 6, icon: "🇹🇷", region: "Europe" },

  // ── CAD ──────────────────────────────────────────────────────────────────
  { symbol: "CADC", name: "CAD Coin", currency: "CAD", contractAddress: "0xae64ceb804292f737c28e0bd552d929041662970", decimals: 6, icon: "🇨🇦", region: "Americas" },
  { symbol: "QCAD", name: "QCAD Dollar", currency: "CAD", contractAddress: "0x3bdb8be37ad586852ad005c5a0885211cd803250", decimals: 6, icon: "🇨🇦", region: "Americas" },

  // ── BRL ──────────────────────────────────────────────────────────────────
  { symbol: "BRZ", name: "Brazilian Real", currency: "BRL", contractAddress: "0x1b7fa411238bf745138a59cbd90fb8480d85c130", decimals: 6, icon: "🇧🇷", region: "Americas" },
  { symbol: "BRLA", name: "BRL Alliance", currency: "BRL", contractAddress: "0x6b5256523acd840ae97aede492cb31a5d500fdf9", decimals: 6, icon: "🇧🇷", region: "Americas" },

  // ── MXN ──────────────────────────────────────────────────────────────────
  { symbol: "MXNT", name: "MXN Tether", currency: "MXN", contractAddress: "0x6750eec6a189bcbc4a9a52ee285b525c8d1940f3", decimals: 6, icon: "🇲🇽", region: "Americas" },
  { symbol: "MXNB", name: "MXN Bridge", currency: "MXN", contractAddress: "0x510139cc0b118711accf9ec476b3093df0bbb1fc", decimals: 6, icon: "🇲🇽", region: "Americas" },

  // ── ARS ──────────────────────────────────────────────────────────────────
  { symbol: "ARZ", name: "ARS Zone", currency: "ARS", contractAddress: "0x3a2498c86db0e4a2e8766649f368cbd37fe6d52a", decimals: 6, icon: "🇦🇷", region: "Americas" },
  { symbol: "ARC", name: "ARS Coin", currency: "ARS", contractAddress: "0xdbb492152ebd689cef184c17e6f65ab18dcde627", decimals: 6, icon: "🇦🇷", region: "Americas" },

  // ── ZAR ──────────────────────────────────────────────────────────────────
  { symbol: "ZARP", name: "ZAR Payment", currency: "ZAR", contractAddress: "0x409667ce4e4674e9fb8272774aabffbb7c8956a4", decimals: 6, icon: "🇿🇦", region: "Africa & Middle East" },
  { symbol: "ZARU", name: "ZAR Universal", currency: "ZAR", contractAddress: "0x721cb3e2b0ba43b0a51f2179b7d260dd98d4baf1", decimals: 6, icon: "🇿🇦", region: "Africa & Middle East" },

  // ── RUB ──────────────────────────────────────────────────────────────────
  { symbol: "A7A5", name: "A7A5 Ruble", currency: "RUB", contractAddress: "0xef6182c0db1466b4b24608360bef8376a6a0578d", decimals: 6, icon: "🇷🇺", region: "Europe" },
];

export function getStablecoinBySymbol(symbol: string): Stablecoin | undefined {
  if (!symbol) return undefined;
  return STABLECOINS.find((c) => c.symbol.toUpperCase() === symbol.toUpperCase());
}

// The Sera API /tokens registry intentionally contains contract/routing data
// only. Sera's own web app resolves presentation assets from this official
// path and falls back to default.png when a token has no dedicated image.
// Keep SeraPay on that same source instead of mixing in unrelated third-party
// token artwork.
const SERA_STABLECOIN_ASSET_BASE_URL = "https://app.sera.cx/stablecoins";

function normalizeStablecoinLogoSymbol(symbol: string): string | null {
  const normalized = String(symbol || "").trim().toLowerCase();
  return /^[a-z0-9]{2,20}$/.test(normalized) ? normalized : null;
}

export function getStablecoinLogoUrl(symbol: string): string | undefined {
  const coin = getStablecoinBySymbol(symbol);
  if (coin?.logoUri) return coin.logoUri;
  const normalized = normalizeStablecoinLogoSymbol(symbol);
  return normalized ? `${SERA_STABLECOIN_ASSET_BASE_URL}/${normalized}.png` : undefined;
}

export function getStablecoinDefaultLogoUrl(): string {
  return `${SERA_STABLECOIN_ASSET_BASE_URL}/default.png`;
}

export function getRegions(): string[] {
  return [...new Set(STABLECOINS.map((c) => c.region))];
}

export function getStablecoinsByRegion(region: string): Stablecoin[] {
  return STABLECOINS.filter((c) => c.region === region);
}
