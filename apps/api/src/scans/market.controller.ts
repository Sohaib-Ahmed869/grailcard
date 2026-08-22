import { Controller, Get } from "@nestjs/common";
import { fxRates } from "./fx.js";
import { scanBudget } from "./budget.js";
import { quotaStatus } from "./gradedprices.js";
import { cardNews, marketPulse } from "./market.js";

@Controller("market")
export class MarketController {
  @Get("pulse")
  pulse() {
    return marketPulse();
  }

  @Get("news")
  news() {
    return cardNews();
  }

  // price-provider budget, so the UI can explain a missing price instead of
  // rendering a silent blank
  @Get("quota")
  quota() {
    return { ...quotaStatus(), budget: scanBudget() };
  }

  @Get("fx")
  async fx() {
    const fx = await fxRates();
    // usdToAud kept alongside the full table so an older cached client bundle
    // keeps working through a deploy
    return { ...fx, usdToAud: fx.rates.AUD };
  }
}
