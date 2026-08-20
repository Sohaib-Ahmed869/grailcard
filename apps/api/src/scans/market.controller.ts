import { Controller, Get } from "@nestjs/common";
import { usdToAud } from "./fx.js";
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

  @Get("fx")
  async fx() {
    return { usdToAud: await usdToAud() };
  }
}
