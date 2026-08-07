/**
 * FX Rate API Routes
 * Provides endpoints for FX rates, quotes, and currency information
 */

import { Router, Request, Response } from "express";
import { seraFxService } from "./sera-fx-service";
import { locationDetectionService } from "./location-detection";

export const fxRouter = Router();

/**
 * GET /api/fx/rate
 * Get FX rate between two currencies
 */
fxRouter.get("/rate", async (req: Request, res: Response) => {
  try {
    const { base, quote } = req.query;

    if (!base || !quote) {
      res.status(400).json({ error: "Missing required parameters: base and quote" });
      return;
    }

    if (typeof base !== "string" || typeof quote !== "string") {
      res.status(400).json({ error: "Invalid parameter types" });
      return;
    }

    const rate = await seraFxService.getFxRate(base, quote);

    if (!rate) {
      res.status(404).json({ error: "FX rate not found" });
      return;
    }

    res.json(rate);
  } catch (error) {
    console.error("[FX Routes] Failed to get FX rate:", error);
    res.status(500).json({ error: "Failed to fetch FX rate" });
  }
});

/**
 * GET /api/fx/quote
 * Get quote for currency conversion
 */
fxRouter.get("/quote", async (req: Request, res: Response) => {
  try {
    const { from, to, amount } = req.query;

    if (!from || !to || !amount) {
      res.status(400).json({ error: "Missing required parameters: from, to, and amount" });
      return;
    }

    if (typeof from !== "string" || typeof to !== "string" || typeof amount !== "string") {
      res.status(400).json({ error: "Invalid parameter types" });
      return;
    }

    const quote = await seraFxService.getFxQuote(from, to, amount);

    if (!quote) {
      res.status(404).json({ error: "FX quote not available" });
      return;
    }

    res.json(quote);
  } catch (error) {
    console.error("[FX Routes] Failed to get FX quote:", error);
    res.status(500).json({ error: "Failed to fetch FX quote" });
  }
});

/**
 * GET /api/fx/deals
 * Find best deals across currency pairs
 */
fxRouter.get("/deals", async (req: Request, res: Response) => {
  try {
    const { minBps } = req.query;
    const minBpsValue = minBps ? parseInt(minBps as string) : 25;

    const deals = await seraFxService.findDeals(minBpsValue);
    res.json({ deals });
  } catch (error) {
    console.error("[FX Routes] Failed to find deals:", error);
    res.status(500).json({ error: "Failed to fetch deals" });
  }
});

/**
 * GET /api/fx/multi-source-mid
 * Get multi-source mid price for a currency pair
 */
fxRouter.get("/multi-source-mid", async (req: Request, res: Response) => {
  try {
    const { base, quote } = req.query;

    if (!base || !quote) {
      res.status(400).json({ error: "Missing required parameters: base and quote" });
      return;
    }

    if (typeof base !== "string" || typeof quote !== "string") {
      res.status(400).json({ error: "Invalid parameter types" });
      return;
    }

    const mid = await seraFxService.getMultiSourceMid(base, quote);

    if (mid === null) {
      res.status(404).json({ error: "Multi-source mid not available" });
      return;
    }

    res.json({ base, quote, mid });
  } catch (error) {
    console.error("[FX Routes] Failed to get multi-source mid:", error);
    res.status(500).json({ error: "Failed to fetch multi-source mid" });
  }
});

/**
 * GET /api/fx/spread-radar
 * Get spread radar for multiple currencies
 */
fxRouter.get("/spread-radar", async (req: Request, res: Response) => {
  try {
    const { currencies } = req.query;

    if (!currencies) {
      res.status(400).json({ error: "Missing required parameter: currencies" });
      return;
    }

    if (typeof currencies !== "string") {
      res.status(400).json({ error: "Invalid parameter type" });
      return;
    }

    const currencyArray = currencies.split(",").map(c => c.trim());
    const radar = await seraFxService.getSpreadRadar(currencyArray);
    res.json({ radar });
  } catch (error) {
    console.error("[FX Routes] Failed to get spread radar:", error);
    res.status(500).json({ error: "Failed to fetch spread radar" });
  }
});

/**
 * GET /api/fx/currencies
 * Get list of supported currencies
 */
fxRouter.get("/currencies", async (req: Request, res: Response) => {
  try {
    const currencies = seraFxService.getSupportedCurrencies();
    res.json({ currencies });
  } catch (error) {
    console.error("[FX Routes] Failed to get currencies:", error);
    res.status(500).json({ error: "Failed to fetch currencies" });
  }
});

/**
 * GET /api/fx/currency/:code
 * Get information about a specific currency
 */
fxRouter.get("/currency/:code", async (req: Request, res: Response) => {
  try {
    const { code } = req.params;

    if (!code) {
      res.status(400).json({ error: "Missing currency code" });
      return;
    }

    const currencyInfo = seraFxService.getCurrencyInfo(code);

    if (!currencyInfo) {
      res.status(404).json({ error: "Currency not found" });
      return;
    }

    res.json(currencyInfo);
  } catch (error) {
    console.error("[FX Routes] Failed to get currency info:", error);
    res.status(500).json({ error: "Failed to fetch currency info" });
  }
});

/**
 * GET /api/fx/location
 * Detect customer location and currency from IP
 */
fxRouter.get("/location", async (req: Request, res: Response) => {
  try {
    const location = await locationDetectionService.getLocationFromRequest(req);
    res.json(location);
  } catch (error) {
    console.error("[FX Routes] Failed to detect location:", error);
    res.status(500).json({ error: "Failed to detect location" });
  }
});

/**
 * GET /api/fx/detect-currency
 * Detect customer currency from IP
 */
fxRouter.get("/detect-currency", async (req: Request, res: Response) => {
  try {
    const currency = await locationDetectionService.detectCurrencyFromRequest(req);
    res.json({ currency });
  } catch (error) {
    console.error("[FX Routes] Failed to detect currency:", error);
    res.status(500).json({ error: "Failed to detect currency" });
  }
});

/**
 * GET /api/fx/stablecoins/:currency
 * Get stablecoins available for a currency
 */
fxRouter.get("/stablecoins/:currency", async (req: Request, res: Response) => {
  try {
    const { currency } = req.params;

    if (!currency) {
      res.status(400).json({ error: "Missing currency code" });
      return;
    }

    const stablecoins = seraFxService.getStablecoinsForCurrency(currency);
    res.json({ currency, stablecoins });
  } catch (error) {
    console.error("[FX Routes] Failed to get stablecoins:", error);
    res.status(500).json({ error: "Failed to fetch stablecoins" });
  }
});
