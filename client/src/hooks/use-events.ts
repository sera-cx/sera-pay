import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./use-auth";
import { useToast } from "@/components/toast-system";
import { playNotificationSound, formatPaymentAmount, shortenAddress, getSoundPref } from "@/lib/dashboard-utils";
import { ApiError, fetchApi } from "@/lib/api";

const POLL_INTERVAL_MS = 8000;

export function useEvents() {
  const { apiKey, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const lastPollAt = useRef<number>(Date.now() - 30_000);
  const seenTxIds = useRef<Set<string>>(new Set());
  const pollTimer = useRef<number>(0);

  useEffect(() => {
    if (!isAuthenticated || !apiKey) return;

    let mounted = true;

    const poll = async () => {
      if (!mounted) return;
      try {
        const since = new Date(lastPollAt.current).toISOString();
        const result = await fetchApi<{
          events: Array<{ event: string; data: Record<string, unknown>; ts: number }>;
          serverTime: number;
        }>(`/merchant/events/poll?since=${encodeURIComponent(since)}`);

        // Advance cursor to server time so we never miss events
        if (result.serverTime) lastPollAt.current = result.serverTime;

        for (const item of result.events ?? []) {
          const data = item.data;
          if (data.event === "payment_received") {
            const txId = data.transactionId as string;
            if (seenTxIds.current.has(txId)) continue;
            seenTxIds.current.add(txId);

            // Trim seen set to avoid unbounded growth
            if (seenTxIds.current.size > 200) {
              const arr = [...seenTxIds.current];
              seenTxIds.current = new Set(arr.slice(-100));
            }

            if (!data.replay) {
              try {
                const pref = getSoundPref();
                const amt = parseFloat((data.amount as string) || "0");
                const amtStr = Number.isInteger(amt) ? amt.toString() : amt.toFixed(amt < 1 ? 4 : 2).replace(/\.?0+$/, "");
                const coin = ((data.coin as string) || "").toUpperCase();

                if (pref === "mute") {
                  // silence
                } else if (pref === "chime") {
                  playNotificationSound();
                } else {
                  // "zh" or "en" TTS
                  if (typeof window !== "undefined" && window.speechSynthesis) {
                    window.speechSynthesis.cancel();

                    const getVoicesReady = (): Promise<SpeechSynthesisVoice[]> => {
                      const v = window.speechSynthesis.getVoices();
                      if (v.length > 0) return Promise.resolve(v);
                      return new Promise(resolve => {
                        const onChanged = () => {
                          resolve(window.speechSynthesis.getVoices());
                          window.speechSynthesis.removeEventListener("voiceschanged", onChanged);
                        };
                        window.speechSynthesis.addEventListener("voiceschanged", onChanged);
                        setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1000);
                      });
                    };

                    const voices = await getVoicesReady();
                    let voice: SpeechSynthesisVoice | null = null;
                    let text: string;
                    let lang: string;

                    if (pref === "zh") {
                      voice = voices.find(v => /zh[-_]CN/i.test(v.lang)) ||
                              voices.find(v => /^zh/i.test(v.lang)) || null;
                      text = `收款成功，到账${amtStr}${coin}`;
                      lang = "zh-CN";
                    } else {
                      voice = voices.find(v => /en[-_]US/i.test(v.lang)) ||
                              voices.find(v => /^en/i.test(v.lang)) || null;
                      text = `Payment received. ${amtStr} ${coin}.`;
                      lang = "en-US";
                    }

                    const utter = new SpeechSynthesisUtterance(text);
                    utter.lang = lang;
                    if (voice) utter.voice = voice;
                    utter.rate = 0.95;
                    utter.pitch = 1;
                    utter.volume = 1;
                    window.speechSynthesis.speak(utter);
                  } else {
                    playNotificationSound();
                  }
                }
              } catch {
                playNotificationSound();
              }
              toast({
                title: `+${formatPaymentAmount(data.amount as string, data.coin as string)}`,
                description: `via ${data.coin} · from ${shortenAddress(data.from as string)}`,
                type: "payment",
              });
            }

            queryClient.invalidateQueries({ queryKey: ["/merchant/transactions"] });
            queryClient.invalidateQueries({ queryKey: ["/merchant/stats"] });
          }
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return;
      }

      if (mounted) {
        pollTimer.current = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    poll();

    return () => {
      mounted = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [apiKey, isAuthenticated, queryClient, toast]);
}
