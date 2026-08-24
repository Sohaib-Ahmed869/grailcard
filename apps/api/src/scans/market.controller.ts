import { Controller, Get, Query } from "@nestjs/common";
import { fxRates } from "./fx.js";
import { scanBudget } from "./budget.js";
import { fetchListings } from "./ebaylistings.js";
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
  async quota() {
    return { ...quotaStatus(), budget: await scanBudget() };
  }

  // Live listings for one card. Kept off the scan response deliberately: a
  // scan already waits on vision plus pricing, and asks are useful but not
  // worth adding latency to the number people are waiting for.
  @Get("listings")
  async listings(
    @Query("name") name?: string,
    @Query("set") set?: string,
    @Query("number") number?: string,
    @Query("grader") grader?: string,
    @Query("grade") grade?: string,
  ) {
    if (!name) return { listings: [], total: 0, query: "", filteredToGrade: false };
    const g = grade != null && grade !== "" ? Number(grade) : null;
    return (
      (await fetchListings({
        name,
        setName: set ?? null,
        number: number ?? null,
        grader: grader ?? null,
        grade: Number.isFinite(g) ? g : null,
      })) ?? { listings: [], total: 0, query: name, filteredToGrade: false }
    );
  }

  @Get("fx")
  async fx() {
    const fx = await fxRates();
    // usdToAud kept alongside the full table so an older cached client bundle
    // keeps working through a deploy
    return { ...fx, usdToAud: fx.rates.AUD };
  }
}
