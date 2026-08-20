import { Controller, Get } from "@nestjs/common";
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
}
