import React, { useEffect, useMemo, useState } from "react";
import { getStablecoinDefaultLogoUrl, getStablecoinLogoUrl } from "@/lib/stablecoins";

type StablecoinLogoProps = {
  symbol: string;
  logoUri?: string;
  className?: string;
  style?: React.CSSProperties;
  fallbackClassName?: string;
};

/**
 * Uses the same logo resolver as app.sera.cx:
 *   /stablecoins/{symbol}.png -> /stablecoins/default.png -> initials.
 */
export function StablecoinLogo({
  symbol,
  logoUri,
  className,
  style,
  fallbackClassName,
}: StablecoinLogoProps) {
  const candidates = useMemo(
    () => Array.from(new Set([
      logoUri,
      getStablecoinLogoUrl(symbol),
      getStablecoinDefaultLogoUrl(),
    ].filter((value): value is string => Boolean(value)))),
    [logoUri, symbol],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => setCandidateIndex(0), [candidates.join("|")]);

  const currentUrl = candidates[candidateIndex];
  if (currentUrl) {
    return (
      <img
        src={currentUrl}
        alt={`${symbol} logo`}
        className={className}
        style={style}
        onError={() => setCandidateIndex((current) => current + 1)}
      />
    );
  }

  return (
    <span
      className={fallbackClassName || className}
      style={style}
      role="img"
      aria-label={`${symbol} logo unavailable`}
    >
      {symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}
